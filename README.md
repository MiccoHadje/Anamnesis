# Anamnesis

> *The recollection of knowledge the soul possessed before birth. Memory not as record but as recovery.*

**Persistent semantic memory for Claude Code sessions.** Parses JSONL conversation transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools so future sessions can semantically search past conversations.

## Features

- **Semantic search** — Find past sessions by meaning, not just keywords
- **Hybrid search** — Combines vector similarity with full-text keyword search (RRF fusion)
- **Smart context builder** — Token-budget-aware context assembly with deduplication, diversity re-ranking, and link graph traversal
- **Auto-ingestion** — SessionEnd hook + scheduled task keep the database current
- **Auto-linking** — Sessions are linked by shared files, semantic similarity, and topic overlap
- **Topic extraction** — Auto-generated tags and summaries per session via local LLM
- **Proactive recall** — Session-start hook injects relevant context automatically
- **Compaction resilience** — PreCompact hook captures session state and triggers ingestion before context window compaction, so long sessions never lose their thread
- **Daily reporting** — MCP tool + skill for cross-project daily/weekly/monthly reports

## How It Works

```
Claude Code JSONL transcripts (~/.claude/projects/**/*.jsonl)
  → ETL Pipeline (TypeScript) — parse, chunk, extract metadata
  → Ollama bge-m3 — 1024-dim vector embeddings
  → PostgreSQL + pgvector — semantic search + full-text search
  → MCP Server (stdio) — 5 tools for search, browsing, ingestion, reporting
```

Each conversation turn (user message + assistant response) becomes a searchable unit with its own embedding. Sessions are enriched with metadata (project, files touched, tools used, timestamps) and linked to related sessions.

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** with [pgvector](https://github.com/pgvector/pgvector) extension
- **Ollama** with models:
  - `bge-m3` — embeddings (required)
  - `gemma3:12b` — topic extraction (optional, needs ~8 GB VRAM; `gemma3:4b` works with ~4 GB)

## Quick Start

```bash
git clone https://github.com/MiccoHadje/Anamnesis.git
cd Anamnesis
npm install

createdb anamnesis
psql -d anamnesis -f src/db/schema.sql

ollama pull bge-m3

cp anamnesis.config.example.json anamnesis.config.json
# Edit anamnesis.config.json — set database.user to your PostgreSQL username

npm run build
node dist/index.js backfill
node dist/index.js stats
```

This gets you a working database. For the full walkthrough — including MCP registration, hooks, topic extraction, HNSW indexes, troubleshooting, and Claude Code integration — see **[INSTALL.md](INSTALL.md)**.

Or let Claude guide you: open the project in Claude Code and type **`/anamnesis_install`**.

## Configuration

Create `anamnesis.config.json` from the example file. All settings can also be overridden with environment variables.

| Field | Default | Env Override | Description |
|-------|---------|-------------|-------------|
| `transcripts_root` | (required) | `ANAMNESIS_TRANSCRIPTS_ROOT` | Path to Claude Code transcripts (e.g., `~/.claude/projects`) |
| `search_mode` | `hybrid` | — | Default search: `hybrid` or `vector` |
| `database.host` | `localhost` | `ANAMNESIS_DB_HOST` | PostgreSQL host |
| `database.port` | `5432` | `ANAMNESIS_DB_PORT` | PostgreSQL port |
| `database.database` | `anamnesis` | `ANAMNESIS_DB_NAME` | Database name |
| `database.user` | `anamnesis` | `ANAMNESIS_DB_USER` | Database user |
| `database.password` | (empty) | `ANAMNESIS_DB_PASSWORD` | Database password (omit for trust/peer auth) |
| `ollama.url` | `http://localhost:11434` | `ANAMNESIS_OLLAMA_URL` | Ollama server URL |
| `ollama.model` | `bge-m3` | — | Embedding model |
| `topic_model.model` | `gemma3:12b` | — | Topic extraction model (use `gemma3:4b` for lower VRAM) |
| `exclude_projects` | `[]` | — | Project directory names to skip |
| `exclude_sessions` | `[]` | — | Specific session UUIDs to skip |
| `concurrency.embedding` | `4` | — | Parallel embedding requests |
| `concurrency.topics` | `2` | — | Parallel topic extraction requests |

Tilde (`~`) in `transcripts_root` is resolved to the user's home directory.

**Priority:** Environment variables > `anamnesis.config.json` > defaults.

## MCP Tools

### `anamnesis_search`

Semantic similarity search across past sessions.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Natural language search query |
| `project` | string | no | Filter by project name (case-insensitive) |
| `limit` | number | no | Max results (default 5) |
| `since` | string | no | Only search after this date (ISO 8601) |
| `hybrid` | boolean | no | Use hybrid search (semantic + keyword) |
| `budget` | number | no | Token budget for smart context assembly (e.g., 800, 2000, 4000). When set, uses link-enriched, deduplicated results with progressive detail levels. |

### `anamnesis_recent`

Browse recent sessions with summaries.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | no | Filter by project name |
| `days` | number | no | Look back N days (default 7) |
| `file` | string | no | Filter sessions that touched this file |
| `limit` | number | no | Max results (default 10) |

### `anamnesis_session`

Get full details of a specific session by ID.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | yes | Session ID (partial OK, 8+ chars) |
| `turn_range` | string | no | Turn range, e.g., "0-3" or "5" |

### `anamnesis_ingest`

Trigger ingestion of transcript files.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | no | Specific session to ingest |
| `force` | boolean | no | Force re-ingestion |

### `anamnesis_daily_report`

Generate a daily activity report from session data.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | string | no | Date (YYYY-MM-DD, default yesterday) |
| `project` | string | no | Project name (omit for cross-project summary) |

Requires the `reporting` section in config. See `anamnesis.config.example.json`.

## CLI Commands

| Command | Description |
|---------|-------------|
| `node dist/index.js ingest-session [id]` | Ingest a session (used by SessionEnd hook) |
| `node dist/index.js ingest <file>` | Ingest a single JSONL transcript |
| `node dist/index.js ingest-all` | Discover and ingest all new/changed transcripts |
| `node dist/index.js backfill` | Full backfill of all transcripts |
| `node dist/index.js backfill-topics` | Extract tags/summaries for sessions missing them |
| `node dist/index.js search <query>` | Semantic search from the command line |
| `node dist/index.js context <query> [--budget N] [--project NAME]` | Budget-aware context assembly (default 2000 tokens) |
| `node dist/index.js stats` | Show database statistics |

Add `--force` to `ingest` or `ingest-all` to re-process already-ingested files.

## MCP Registration

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "anamnesis": {
    "command": "node",
    "args": ["/path/to/Anamnesis/dist/mcp/index.js"],
    "env": {}
  }
}
```

## Hooks

Example hooks are provided in the `hooks/` directory:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `session-end.json` | SessionEnd | Auto-ingest transcripts when a session ends |
| `session-start-recall.py` | SessionStart | Inject recent project context at session start |
| `plan-recall.py` | PreToolUse (EnterPlanMode) | Search Anamnesis when entering plan mode |
| `pre-compact-ingest.py` | PreCompact | Capture state + ingest transcript before context compaction |

See [`hooks/README.md`](hooks/README.md) for installation instructions.

## Skills

Claude Code skills for higher-level workflows are in the `skills/` directory:

| Skill | Description |
|-------|-------------|
| `/anamnesis_install` | Guided setup and health check — walks through installation or verifies system health |
| `/daily_duties` | Generate per-project daily logs, cross-project reports, weekly retros, and monthly highlights |

See [`skills/README.md`](skills/README.md) for installation instructions.

## How Search Works

Anamnesis offers two search modes:

**Vector search** — Embeds your query with bge-m3 and finds the most similar conversation turns by cosine distance. Good for conceptual/semantic queries.

**Hybrid search** (default) — Combines vector similarity with PostgreSQL full-text search using Reciprocal Rank Fusion (RRF). Includes a recency boost. Better for queries mixing concepts with specific terms.

Both modes enforce a minimum similarity threshold (0.3) to filter noise.

## Smart Context Builder

When `anamnesis_search` receives a `budget` parameter, it switches from top-N retrieval to a three-phase context assembly pipeline:

1. **Gather** — Overfetch 20 results, deduplicate by session (keeping related turns as drill-down hints), apply MMR diversity re-ranking, traverse the session link graph for top hits
2. **Allocate** — Greedily assign detail levels (full/summary/title) based on remaining token budget
3. **Render** — Format progressive-detail markdown with "See also" turns and "Linked" session hints

This produces richer, more diverse results than simple top-N search, especially as the database grows. Typical budgets:
- **800** — Hooks and quick context (5-7 sessions, concise)
- **2000** — Planning and moderate context
- **4000** — Deep research with linked sessions

Also available via CLI: `node dist/index.js context "query" --budget 2000`

## Database Schema

| Table | Purpose |
|-------|---------|
| `anamnesis_sessions` | One row per session/subagent. Metadata, tags, summary, session embedding. |
| `anamnesis_turns` | One row per user+assistant pair. Content, tool calls, embedding, tsvector. |
| `anamnesis_ingested_files` | Idempotency tracking (file path, size, mtime). |
| `anamnesis_session_links` | Auto-links between sessions (file_overlap, semantic, topic). |

## Auto-Linking

Three layers of automatic session linking:

1. **File overlap** — Sessions sharing `files_touched` entries. Score = Jaccard similarity.
2. **Semantic similarity** — Compare averaged session embeddings. Links top 5 above 0.5 threshold.
3. **Topic overlap** — Sessions sharing 2+ extracted tags. Score = Jaccard similarity.

Related sessions surface in `anamnesis_session` results.

## Daily Reporting

The `anamnesis_daily_report` MCP tool and `/daily_duties` skill work together for cross-project reporting:

- The **MCP tool** queries the database and returns structured markdown reports
- The **skill** orchestrates a full reporting workflow: gap detection, per-project logs, cross-project summaries, weekly retros, monthly highlights

Configure the `reporting` section in `anamnesis.config.json` with your projects. Optionally integrate with [Nudge](https://github.com/MiccoHadje/Nudge) for task completion data.

## Scheduled Ingestion (Windows)

For Windows users, `scripts/setup-scheduled-task.ps1` creates a Windows Scheduled Task that runs `ingest-all` every 15 minutes. This catches sessions where the SessionEnd hook didn't fire.

```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File scripts/setup-scheduled-task.ps1
```

## Development

```bash
npm run build    # TypeScript → dist/
npm run dev      # Run with tsx (no build step)
npm test         # Run tests
```

## License

[GPL-3.0](LICENSE) — Copyright 2026 Clay Mahaffey / Canoic LLC
