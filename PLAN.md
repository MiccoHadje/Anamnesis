# Anamnesis Implementation Plan

## Context

Claude Code sessions start fresh with no memory of past work. Transcripts exist as JSONL files on disk (2,120 files, 3.35GB) but are unsearchable. Anamnesis parses these transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools so future sessions can semantically search past conversations.

See `DESIGN_BRIEF.md` for success goals, trigger catalog, and output state definition.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Chunking unit | User+Assistant pairs |
| Tool content | Include everything (file reads, grep, bash output) |
| Subagents | Main sessions + subagents >5KB |
| Ingestion | Dual: SessionEnd hook + Windows scheduled task (every 15 min) |
| Stack | Node.js/TypeScript (ETL + MCP server) |
| Backfill | Full 3.35GB |
| Embedding | Ollama bge-m3 on WS25 (localhost:11434), 1024-dim |
| Database | PostgreSQL + pgvector on **WS25 (localhost)**, database `anamnesis` |
| Auto-linking | Layered: file overlap → semantic similarity → topic extraction |
| Access modes | Explicit + triggered (CLAUDE.md nudges) + proactive (session-start) |

## Project Structure

```
D:\Projects\Anamnesis\
├── package.json
├── tsconfig.json
├── .gitignore
├── anamnesis.config.json     # Privacy exclusions, project mappings
├── CLAUDE.md / CONCEPT.md / DESIGN_BRIEF.md
├── src/
│   ├── index.ts              # CLI: ingest-session, ingest-all, backfill, stats, search
│   ├── mcp/
│   │   ├── index.ts          # MCP server entry (stdio, @modelcontextprotocol/sdk)
│   │   └── tools.ts          # Tool definitions + handlers
│   ├── etl/
│   │   ├── parser.ts         # Streaming JSONL parser (readline)
│   │   ├── chunker.ts        # Group into user+assistant pairs
│   │   ├── embedder.ts       # Ollama bge-m3 client
│   │   ├── ingester.ts       # Orchestrator: parse → chunk → embed → store
│   │   ├── discovery.ts      # Find new/changed JSONL files
│   │   ├── metadata.ts       # Extract project, files_touched, tools_used
│   │   └── linker.ts         # Auto-linking: file overlap, semantic similarity, topics
│   ├── db/
│   │   ├── schema.sql        # DDL
│   │   ├── client.ts         # pg Pool wrapper (localhost)
│   │   └── queries.ts        # Parameterized queries
│   └── util/
│       ├── text.ts           # Embedding text construction
│       └── config.ts         # Paths, connection strings, privacy config
└── scripts/
    └── migrate.ts            # Run schema.sql
```

## Database Schema

**Host:** WS25 localhost (PostgreSQL + pgvector). Database: `anamnesis`.

Four tables:

1. **`anamnesis_ingested_files`** — Idempotency tracking. Stores `(file_path, file_size, file_mtime)` for each processed JSONL. If size/mtime change, re-ingest.

2. **`anamnesis_sessions`** — One row per session/subagent. Fields: `session_id`, `project_name`, `cwd`, `git_branch`, `model`, `started_at`, `ended_at`, `turn_count`, `files_touched[]`, `tools_used[]`, `is_subagent`, `parent_session_id`, `tags TEXT[]`, `summary TEXT`, `session_embedding vector(1024)` (averaged turn embeddings), `metadata JSONB`.

3. **`anamnesis_turns`** — One row per user+assistant pair. Fields: `session_id`, `turn_index`, `user_content`, `assistant_content`, `tool_calls JSONB`, `files_in_turn[]`, `timestamp_start/end`, `token_count`, `embedding_text`, `embedding vector(1024)`.

4. **`anamnesis_session_links`** — Auto-linking. Fields: `session_a`, `session_b`, `link_type` (enum: `file_overlap`, `semantic`, `topic`), `score FLOAT`, `shared_detail TEXT` (e.g., shared file path or topic name).

**Indexes:**
- HNSW on `anamnesis_turns.embedding` (cosine) for turn-level semantic search
- HNSW on `anamnesis_sessions.session_embedding` (cosine) for session-level similarity
- GIN on generated `tsvector` column on turns for keyword/hybrid search
- B-tree on `session_id`, `timestamp_start`, `project_name`
- B-tree on `session_links(session_a)`, `session_links(session_b)`

## ETL Pipeline

1. **Discovery** — Glob `C:\Users\clay\.claude\projects\**\*.jsonl`, filter subagents <5KB, check privacy exclusions, diff against `anamnesis_ingested_files`
2. **Parse** — Stream JSONL line-by-line (readline). Yield typed objects per line.
3. **Chunk** — Filter to `user`/`assistant` types. Group: User(text) → Assistant(text+tool_use) → User(tool_result) → Assistant(response) → ... until next User(text). Skip `progress`, `system`, `file-history-snapshot`, `queue-operation`.
4. **Build embedding text** — `[Project: RPGDash]\nUser: ...\n[Read: path/to/file]\n<truncated output>\nAssistant: ...` — cap tool output at 500 chars each, total at ~7500 tokens for bge-m3's 8192 window.
5. **Embed** — POST to `http://localhost:11434/api/embeddings` with bge-m3. Batch with concurrency limit of 4.
6. **Store** — Insert session row, then turn rows with embeddings. Wrap in transaction. Record in `ingested_files`.
7. **Link** — After storing, run auto-linking:
   - File overlap: query sessions sharing `files_touched` entries
   - Semantic similarity: compare `session_embedding` (average of turn embeddings) against existing sessions, link top matches above threshold

**Idempotency:** If file already ingested with same size/mtime → skip. If changed → delete old session data (CASCADE), re-ingest.

**Privacy config** (`anamnesis.config.json`):
```json
{
  "exclude_projects": ["D--MainVault-Main-Home"],
  "exclude_sessions": ["<specific-uuid>"]
}
```

## MCP Tools

Follow CanoicAI Gateway pattern (`D:\Projects\CanoicAI\packages\gateway\src\mcp\index.ts`): `@modelcontextprotocol/sdk`, stdio transport, tool switch dispatch.

| Tool | Purpose | Key params |
|------|---------|------------|
| `anamnesis_search` | Semantic similarity search | `query` (required), `project`, `limit` (default 5), `since`, `hybrid` (bool) |
| `anamnesis_recent` | Browse recent sessions | `project`, `days` (default 7), `file`, `limit` (default 10) |
| `anamnesis_session` | Full session by ID (includes related sessions) | `session_id` (partial OK), `turn_range` |
| `anamnesis_ingest` | Trigger ingestion | `session_id` (optional), `force` (bool) |

**Search query:** Embed the query with bge-m3, then `ORDER BY embedding <=> $query LIMIT N` with optional project/date filters. Hybrid mode adds `UNION` with `ts_rank` on the tsvector column.

**Session detail** includes auto-linked related sessions from `anamnesis_session_links`.

## Hook + Scheduler

**Hook:** Add to `SessionEnd` array in `C:\Users\clay\.claude\settings.json`:
```json
{
  "type": "command",
  "command": "node D:/Projects/Anamnesis/dist/index.js ingest-session",
  "timeout": 30000,
  "statusMessage": "Saving to Anamnesis..."
}
```
The hook receives session context via stdin. Gracefully exits if JSONL not yet flushed (scheduled task catches it).

**Scheduler:** Windows Task Scheduler running `node D:\Projects\Anamnesis\dist\index.js ingest-all` every 15 minutes. Catches sessions where hook didn't fire.

## Implementation Phases

### Phase 1: Foundation
- Project scaffolding (package.json, tsconfig, .gitignore, git init)
- Create `anamnesis` database on WS25 localhost
- Database schema (all 4 tables)
- `db/client.ts` + `db/queries.ts`
- `etl/parser.ts` (streaming JSONL)
- `etl/chunker.ts` (user+assistant pairing)
- `etl/metadata.ts` (project name, files, tools extraction)
- `util/config.ts` (paths, privacy config loading)
- **Verify:** Parse one transcript, insert turns (without embeddings) into PostgreSQL

### Phase 2: Embeddings + Search
- `util/text.ts` (embedding text construction)
- `etl/embedder.ts` (Ollama bge-m3 client)
- `etl/ingester.ts` (full orchestrator)
- `etl/discovery.ts` (file scanning + idempotency + privacy filtering)
- Vector insert + cosine similarity queries
- **Verify:** Ingest Anamnesis session with embeddings, run similarity query via psql

### Phase 3: MCP Server
- `mcp/index.ts` + `mcp/tools.ts`
- Implement all 4 tools
- Register in Claude Code MCP config
- **Verify:** Call `anamnesis_search` from a Claude Code session

### Phase 4: Auto-Linking (Layer 1-2)
- `etl/linker.ts` — file overlap detection + semantic similarity
- Compute `session_embedding` (averaged turn vectors) and store on session row
- Populate `anamnesis_session_links` during ingestion
- Surface related sessions in `anamnesis_session` tool output
- **Verify:** Ingest two related sessions, confirm links appear

### Phase 5: CLI + Hook + Scheduler
- `src/index.ts` CLI (ingest-session, ingest-all, backfill, stats)
- Add SessionEnd hook to settings.json
- Create Windows Scheduled Task
- **Verify:** End a session, confirm auto-ingestion

### Phase 6: Full Backfill ✅
- Process all 2,120 files (sorted smallest-first for quick feedback)
- Progress reporting, error resilience, resume support
- Auto-link all sessions (file overlap + semantic)
- **Result:** 243 sessions, 4,745 turns ingested

### Phase 7: Triggers + Proactive Recall ✅
- Draft trigger instructions for global CLAUDE.md
- Draft project-specific trigger examples
- SessionStart recall hook (`anamnesis-recall.py`)
- **Verify:** Start a new session, confirm Claude proactively searches for context

### Phase 8: Polish + Topic Extraction (Layer 3) ✅
- Fixed JSON.parse bug on already-parsed JSONB in session detail
- Fixed RRF score display (was showing meaningless percentages)
- Added minimum similarity threshold (0.3) to vector search
- Increased hybrid candidate pool from 50 to 100 per arm
- Made project filters case-insensitive
- Added recency boost to hybrid search
- Increased content truncation limits for better context
- Added turn timestamps, session duration, subagent labels
- Added turn pagination for large sessions (first 10 + last 5)
- Topic extraction via Ollama gemma3:12b (tags + summary)
- Topic linking (Layer 3): sessions sharing 2+ tags
- `backfill-topics` CLI command
- `search_mode` and `topic_model` config options
- Created README.md with full documentation + deployment guide
- Updated PLAN.md and CLAUDE.md

## Key Dependencies

```
@modelcontextprotocol/sdk  — MCP server
pg + pgvector              — PostgreSQL + vector types
pino                       — Logging
tsx                        — Dev runner
typescript + vitest        — Build/test
```

## Verification

After each phase, verify with concrete tests:
- Phase 1: `psql -d anamnesis -c "SELECT count(*) FROM anamnesis_turns"`
- Phase 2: Similarity query via psql returns relevant turns
- Phase 3: `anamnesis_search` MCP tool returns results from Claude Code
- Phase 4: `anamnesis_session` shows related sessions
- Phase 5: End a session, check `anamnesis_ingested_files` for new entry
- Phase 6: `anamnesis stats` showing total sessions/turns
- Phase 7: New session proactively shows project context from Anamnesis
- Phase 8: Hybrid search works, topic tags appear on sessions
