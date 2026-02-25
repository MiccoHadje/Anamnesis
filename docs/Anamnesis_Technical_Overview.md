# Anamnesis: Persistent Semantic Memory for AI Coding Agents

## The Problem: AI Amnesia

Every Claude Code session starts with a blank slate. The agent has no memory of what you built yesterday, which architectural decisions you debated last week, or the obscure workaround you discovered for a platform bug three months ago. Each session is an island.

This isn't a minor inconvenience. It creates real friction:

- You re-explain context that was thoroughly established in a prior session.
- The agent proposes solutions you've already tried and rejected.
- Decisions get relitigated because neither party remembers the rationale.
- Institutional knowledge about your codebase lives only in your head.

Markdown files like `CLAUDE.md` help — they're read at every session start and provide stable context. But they're manually maintained, limited in scope, and don't capture the organic, conversational knowledge that accumulates across hundreds of sessions.

**Anamnesis** solves this. It's a semantic memory layer that automatically ingests every Claude Code session transcript, embeds it into a vector database, and makes it searchable from within future sessions. The agent can now recall past conversations — not by rote, but by meaning.

The name comes from the Greek *anamnesis* (ἀνάμνησις): the act of recollection, of bringing latent knowledge back to awareness.

---

## Architecture

Anamnesis is a TypeScript application with four major subsystems: an ETL pipeline, a PostgreSQL + pgvector storage layer, an MCP server for runtime access, and a hook system for lifecycle integration. Everything runs locally — no cloud dependencies, no API costs for the memory system itself.

```
Claude Code JSONL transcripts
  → Streaming Parser (readline + JSON.parse per line)
  → Turn Chunker (groups user+assistant pairs, extracts tool metadata)
  → Metadata Extractor (session ID, project, CWD, git branch, model, timestamps)
  → Embedder (Ollama bge-m3, 1024-dim, concurrency-controlled batches)
  → PostgreSQL + pgvector (sessions, turns with embeddings, ingestion tracking, session links)
  → Auto-Linker (file overlap + semantic similarity + topic overlap)
  → Topic Extractor (Ollama gemma3:12b, tags + summaries)
  → MCP Server (anamnesis_search, anamnesis_recent, anamnesis_session, anamnesis_ingest)
```

### Dependencies

The dependency footprint is deliberately minimal:

- `@modelcontextprotocol/sdk` — MCP server protocol
- `pg` + `pgvector` — PostgreSQL client with vector type support
- `pino` — Structured logging

No LangChain, no LlamaIndex, no heavyweight frameworks. The ETL pipeline, search logic, and MCP integration are all hand-rolled in ~1,200 lines of TypeScript.

---

## The ETL Pipeline

### 1. Transcript Discovery

Claude Code writes session transcripts as JSONL files to `~/.claude/projects/<project-dir>/`. Each project directory contains top-level session files and `<session-uuid>/subagents/` subdirectories for agent delegations.

The discovery module (`src/etl/discovery.ts`) walks this tree, filters by privacy config (excluded projects/sessions), and checks idempotency. A batch lookup against `anamnesis_ingested_files` compares `(file_path, file_size, file_mtime)` tuples — only new or modified files are returned for processing. This means re-running ingestion is always safe and fast.

```typescript
// Idempotency check: single batch query instead of N individual lookups
const allPaths = files.map(f => f.path);
const ingested = await getIngestedFilesMap(allPaths);
// Only return files where size/mtime changed or file is new
```

Discovery also handles subagent files. Subagents write their own JSONL transcripts in nested directories. Anamnesis discovers and ingests them separately, marking them with `is_subagent = true` and linking them to their parent session via `parent_session_id`.

### 2. Streaming Parser

Each JSONL line is one of several message types: `user`, `assistant`, `system`, `progress`, `queue-operation`, etc. The parser (`src/etl/parser.ts`) streams through the file using Node's `readline` interface and yields only the types relevant to the task at hand.

For turn chunking, only `user` and `assistant` messages matter. For metadata extraction, all message types are scanned to capture `sessionId`, `cwd`, `gitBranch`, `model`, and timestamps from wherever they first appear.

The parser is generator-based (`async function*`), so it handles arbitrarily large files without buffering the entire transcript into memory.

### 3. Turn Chunker

The chunker (`src/etl/chunker.ts`) is where raw messages become structured knowledge units. It groups messages into **turns**: a user message (possibly with tool results from the prior assistant response) followed by one or more assistant messages (with text and tool use).

The boundary heuristic: a new turn starts when a user message contains actual text content (not just `tool_result` blocks). This correctly handles the common pattern where a single user prompt triggers multiple assistant responses with interleaved tool calls.

Each turn captures:

- **User content** — sanitized (system-reminder tags and task-notification tags stripped)
- **Assistant content** — the agent's text responses
- **Tool calls** — name + summarized input for each tool invocation
- **Files in turn** — extracted from tool inputs (`file_path`, `path`, `filePath` fields) and tool result text (regex: paths matching `[A-Z]:\...` or `/...`)
- **Timestamps** — start and end times from message timestamps
- **Token count** — summed from usage metadata on assistant messages

Tool call summaries are intelligently condensed. A `Read` call stores just the file path. A `Bash` call stores the command. A `Grep` stores `pattern in path`. This keeps the embedding text informative without including raw file contents or command output.

### 4. Metadata Extraction

The metadata extractor (`src/etl/metadata.ts`) derives session-level information:

- **Session ID** — from the first message's `sessionId` field, falling back to the filename
- **Project name** — derived from the file path by finding the `projects/` segment and extracting the next component. A `friendlyProjectName()` function converts directory-encoded names like `d--Projects-RPGDash` into `RPGDash`
- **Subagent detection** — files containing `/subagents/` in their path are flagged, and the parent session UUID is extracted from the directory structure
- **CWD, git branch, model** — from the first messages that contain them
- **Aggregated files and tools** — union of all files touched and tools used across all turns

A notable bug fix in the project's history: the original implementation used `basename(dirname(filePath))` for project name derivation, which returned `"subagents"` for any subagent file. The fix walks up the path to find the `projects/` segment, correctly attributing subagent sessions to their parent project. This mislabeled 74 sessions before it was caught.

### 5. Embedding

Anamnesis uses **bge-m3** via a local Ollama instance for generating 1024-dimensional vector embeddings. bge-m3 was chosen for its strong retrieval performance and multilingual capability, though in practice the content is overwhelmingly English with code mixed in.

The embedding text for each turn is constructed by `buildEmbeddingText()` (`src/util/text.ts`):

```
[Project: RPGDash]
User: <user content>
[Read: src/components/Card.tsx]
[Bash: npm run build]
Assistant: <assistant content>
```

This format front-loads the project context and includes tool call summaries as bracketed annotations. The text is capped at 8,000 characters (bge-m3's context window is 8,192 tokens; code-heavy text is roughly 1 char/token).

Embedding happens in batches with configurable concurrency (default 2, raised to 4 during ingestion). The embedder includes:

- **Auto-start** — on Windows, if Ollama isn't running, it attempts `start "" "ollama" serve` and waits 5 seconds
- **Retry with backoff** — up to 3 retries with exponential backoff (2s, 4s, 8s) for transient server errors
- **Client error short-circuit** — 4xx errors are not retried

A **session embedding** is computed as the mean of all turn embeddings. This averaged vector represents the session's overall topic and is used for session-level semantic linking.

### 6. Storage

Everything is stored in PostgreSQL with the pgvector extension in a single transaction per session. If embedding or insertion fails partway through, the entire session rolls back cleanly.

**Tables:**

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `anamnesis_sessions` | One row per session/subagent | `session_id`, `project_name`, `files_touched[]`, `tools_used[]`, `tags[]`, `summary`, `session_embedding` (vector 1024) |
| `anamnesis_turns` | One row per user+assistant turn pair | `session_id`, `turn_index`, `user_content`, `assistant_content`, `tool_calls` (JSONB), `embedding` (vector 1024), `tsv` (generated tsvector) |
| `anamnesis_ingested_files` | Idempotency tracking | `file_path` (unique), `file_size`, `file_mtime`, `session_id` |
| `anamnesis_session_links` | Inter-session relationships | `session_a`, `session_b`, `link_type` (enum), `score`, `shared_detail` |

The `tsv` column on turns is a PostgreSQL generated column:
```sql
tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('english', coalesce(user_content, '') || ' ' || coalesce(assistant_content, ''))
) STORED
```

This enables full-text search alongside vector similarity at no additional write-time cost.

Vector indexes use HNSW (Hierarchical Navigable Small World) rather than IVFFlat, chosen for better recall characteristics. They're created after initial data load for optimal index quality.

### 7. Auto-Linking

After a session is ingested, the linker (`src/etl/linker.ts`) establishes connections to other sessions through three independent layers:

**Layer 1: File Overlap** — Uses PostgreSQL's array overlap operator (`&&`) to find sessions sharing files in `files_touched`. The score is Jaccard similarity: `|intersection| / |union|`. Trivial overlaps (< 5%) are filtered. This captures the structural relationship: "these sessions worked on the same files."

**Layer 2: Semantic Similarity** — Compares the session's averaged embedding against all other session embeddings using cosine distance (`<=>`). The top 5 sessions above a 0.5 similarity threshold are linked. This captures topical relationship: "these sessions discussed similar concepts."

**Layer 3: Topic Overlap** — Compares extracted topic tags using Jaccard similarity, requiring at least 2 shared tags. This captures categorical relationship: "these sessions were about the same domain."

Links are bidirectional with consistent ordering (`session_a < session_b`) and upserted with `ON CONFLICT` to handle re-ingestion gracefully.

### 8. Topic Extraction

The topic extractor (`src/etl/topics.ts`) uses a separate, larger language model — **gemma3:12b** via Ollama — to generate 3-5 topic tags and a one-sentence summary per session. It's given the project name, first 20 files touched, tools used, and the first 2,000 characters of the first user message.

The prompt explicitly requests specific tags ("drizzle-orm migration", "MCP server setup") rather than generic ones ("coding", "development"). Temperature is set to 0.3 for consistency.

Topic extraction is **best-effort and non-blocking** — if the model isn't available or returns malformed JSON, ingestion continues without topics. A `backfill-topics` command can retroactively extract topics for sessions that don't have them.

---

## Search

Anamnesis supports two search modes, both operating at the turn level (not session level) for precision.

### Pure Vector Search

Embeds the query with bge-m3, then finds the closest turn embeddings by cosine distance:

```sql
SELECT ..., 1 - (t.embedding <=> $1::vector) as similarity
FROM anamnesis_turns t
JOIN anamnesis_sessions s ON s.session_id = t.session_id
ORDER BY t.embedding <=> $1::vector
LIMIT $2
```

Results below a 0.3 similarity threshold are filtered out. This works well for conceptual queries ("how did we implement caching?") but can miss results where the exact terminology differs.

### Hybrid Search (default)

Combines vector similarity with PostgreSQL full-text search using **Reciprocal Rank Fusion (RRF)**:

1. **Semantic arm**: Top 100 turns by vector cosine distance
2. **Keyword arm**: Top 100 turns matching `plainto_tsquery('english', query)` against the generated `tsv` column, ranked by `ts_rank`
3. **RRF fusion**: `score = 1/(60 + semantic_rank) + 1/(60 + keyword_rank)` — the constant 60 is the standard RRF smoothing parameter
4. **Recency boost**: The RRF score is multiplied by `1 + 0.1 / (1 + days_ago)`, giving a mild preference to recent results

The hybrid approach is strictly better for queries containing specific identifiers, function names, error messages, or other literal strings that vector similarity might not capture well.

Both modes support filtering by project name and date range.

---

## MCP Integration

Anamnesis exposes four MCP tools via a stdio server, registered in the user's Claude Code config:

### `anamnesis_search`
Semantic (or hybrid) search across all past turns. Parameters: `query` (required), `project`, `limit`, `since`, `hybrid`. Returns formatted results with session ID prefix, project, turn index, similarity score, and truncated content.

### `anamnesis_recent`
Browse recent sessions by project, date range, or file. Returns session summaries with metadata, tools used, summaries, and file lists. Useful for session continuity: "what did I do on RPGDash this week?"

### `anamnesis_session`
Retrieve full session details by ID (partial ID matching supported). Includes all turns with content and tool calls, plus related sessions from the link graph. Supports `turn_range` for targeted retrieval. Sessions with >20 turns are auto-paginated (first 10 + last 5, with omission notice).

### `anamnesis_ingest`
Trigger ingestion from within a session. Without arguments, discovers and ingests all new files. With `session_id`, ingests a specific session. Supports `force` for re-ingestion.

---

## Lifecycle Hooks

The real power of Anamnesis comes from its integration into Claude Code's hook system, making memory retrieval automatic rather than manual.

### SessionEnd: Auto-Ingest

When a Claude Code session ends, a hook triggers `node dist/index.js ingest-session [session-id]`. This immediately ingests the just-completed session so it's searchable in the next one. If the JSONL isn't flushed yet (a race condition that sometimes occurs), the scheduled task catches it within 15 minutes.

### SessionStart: Proactive Recall

The `anamnesis-recall.py` hook (`~/.claude/hooks/`) fires at session start. It:

1. Derives the project name from the current working directory
2. Queries Anamnesis for the 5 most recent non-subagent sessions on this project (last 7 days)
3. Checks the user's current Nudge focus task and searches for related past sessions
4. Injects the results into Claude's context as a system message

This means every session starts with awareness of recent work — the agent knows what files were touched, how many turns each session had, and whether past sessions are relevant to the current focus.

### PreToolUse (EnterPlanMode): Deep Recall

The `plan-recall.py` hook fires whenever Claude enters plan mode — whether via the `/plan` skill, user request, or the agent's own initiative. It:

1. Reads the current session transcript to find the last user message
2. Strips `/plan` prefixes if present
3. Falls back to the Nudge focus task title if no message is found
4. Generates a bge-m3 embedding of the query directly (using `urllib.request` to call Ollama, no Node dependency)
5. Runs cosine similarity search against `anamnesis_turns`
6. Injects up to 5 relevant past turns as `additionalContext` via `hookSpecificOutput`

This is the most impactful hook. When the agent enters plan mode to design an implementation, it automatically receives relevant historical context — past implementations, rejected approaches, architectural decisions — without the user having to ask "do you remember when we...?"

### Scheduled Task: Background Ingestion

A Windows scheduled task runs every 15 minutes via a VBS wrapper (`scripts/silent-ingest.vbs`) that suppresses the console window:

```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node D:\Projects\Anamnesis\dist\index.js ingest-all", 0, True
```

This catches sessions that weren't ingested at end (e.g., crashed sessions, interrupted connections) and handles any stragglers from the race condition between session end and JSONL flush.

---

## Use Cases and Examples

### 1. Recovering Forgotten Decisions

**Scenario**: You're adding a new MCP server and can't remember how you configured the last one.

The agent enters plan mode. The plan-recall hook fires, embedding your planning query and searching past turns. It finds a session from two weeks ago where you set up the Nudge MCP server, including the exact `mcpServers` config format, the stdio transport pattern, and the registration in `~/.claude.json`. The agent plans the new server using the established pattern.

### 2. Debugging a Regression

**Scenario**: A feature that worked last week is now broken. You don't remember what changed.

```
anamnesis_search(query: "RPGDash encounter mode turn planning", hybrid: true, since: "2026-02-01")
```

Returns turns from 3 sessions over the past month that touched encounter mode. The agent can trace the evolution: session A introduced the feature, session B refactored the state management, session C changed the API contract. The regression is in session C.

### 3. Session Continuity

**Scenario**: You closed your laptop mid-task yesterday and are picking up today.

The SessionStart hook automatically shows:
```
RECALL: Recent sessions on @RPGDash
  2/24: 15 turns - schema.sql, Card.tsx, encounters/route.ts (+4)
  2/23: 8 turns - encounters/route.ts, useEncounter.ts
  [Focus: "Wire delegation Ethics/Loyalty side-effects" - 2 past sessions found]
```

The agent immediately knows the recent context without you explaining anything.

### 4. Cross-Project Pattern Reuse

**Scenario**: You need to implement rate limiting in a new project and remember doing something similar elsewhere.

```
anamnesis_search(query: "rate limiting token bucket implementation")
```

Finds turns from the CanoicAI Gateway project where you implemented token bucket rate limiting with per-provider configuration. The agent can adapt the same pattern.

### 5. Verifying Past Approaches

**Scenario**: The agent suggests using a particular library. You have a vague memory of trying it before and running into issues.

```
anamnesis_search(query: "drizzle ORM migration issues", hybrid: true)
```

Finds a session where you hit a specific incompatibility with Drizzle's migration system and switched to raw SQL migrations. The agent adjusts its recommendation.

### 6. Onboarding a New Project Area

**Scenario**: You haven't worked on the HG (Hollowed Ground) project in a while and need to make changes to the Argus belief engine.

```
anamnesis_recent(project: "HG", days: 30)
anamnesis_search(query: "Argus belief engine NPC knowledge consistency", project: "HG")
```

The agent gets a timeline of recent HG work plus deep context on how Argus was designed, what trade-offs were made, and what the current state is.

---

## Data at a Glance

After the initial backfill of all historical transcripts:

- **243+ sessions** ingested (main sessions + subagents)
- **4,745+ turns** embedded and searchable
- Multi-layer session links (file overlap, semantic, topic)
- Per-session topic tags and summaries
- Coverage across 6+ active projects

---

## Design Principles

### Local-First, Zero API Cost

Everything runs on the local machine: PostgreSQL, Ollama (bge-m3 for embeddings, gemma3:12b for topic extraction), and the MCP server. There are no API calls to external services for the memory system. The only compute cost is the local GPU time for embedding generation.

### Turn-Level Granularity

Search operates at the turn level, not the session level. A session might span 50 turns across multiple topics. Searching at turn granularity means you get the specific conversation fragment where a decision was made, not a 500-turn session you have to scan through.

### Idempotent and Crash-Safe

Every ingestion operation is idempotent. Files are tracked by `(path, size, mtime)`. Sessions are upserted with `ON CONFLICT`. Failed ingestions are recorded so they don't block future runs. The transaction-per-session model means a crash during ingestion leaves the database consistent.

### Privacy-Aware

The config file supports `exclude_projects` and `exclude_sessions` for opting specific content out of ingestion. System-injected content (`<system-reminder>` tags, `<task-notification>` tags) is stripped during chunking. Base64 image data is skipped.

### Passive Integration

The hook system makes Anamnesis invisible during normal use. You don't have to remember to search — the SessionStart and PlanMode hooks inject context automatically. The SessionEnd hook and scheduled task ensure ingestion happens without intervention. The system is designed to be useful by default and queryable on demand.

---

## Technical Stack Summary

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Language | TypeScript (ESM) | ETL pipeline, MCP server, CLI |
| Database | PostgreSQL 16 + pgvector | Storage, vector search, full-text search |
| Embeddings | Ollama bge-m3 (1024-dim) | Semantic vector generation |
| Topics | Ollama gemma3:12b | Tag/summary extraction |
| MCP | @modelcontextprotocol/sdk | Tool exposure to Claude Code |
| Hooks | Python (psycopg2) | Lifecycle integration (SessionStart, PlanMode) |
| Scheduling | Windows Task Scheduler + VBS | Background ingestion every 15 min |
| Search | Cosine similarity + RRF hybrid | Turn-level retrieval |

---

## What's Next

Anamnesis is functional and actively used across all projects. Future directions include:

- **Cross-session summarization** — automatically generating weekly/monthly digests of work per project
- **Decay and compaction** — older sessions could be summarized and their turn-level embeddings consolidated to save space
- **Multi-machine support** — extending ingestion to sessions on remote machines (Max server)
- **Richer linking** — temporal adjacency links, dependency chain detection
- **Evaluation framework** — measuring recall quality against known-good queries to tune search parameters

---

*Anamnesis is a personal infrastructure project by Clay Mahaffey, built for the Canoic LLC development environment. It demonstrates that meaningful AI memory doesn't require cloud services or expensive API calls — just a local embedding model, a vector database, and thoughtful integration into the agent's lifecycle.*
