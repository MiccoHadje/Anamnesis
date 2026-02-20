# Anamnesis

Persistent semantic memory for Claude Code sessions. Parses JSONL conversation transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools so future sessions can semantically search past conversations.

## Architecture

```
Claude Code JSONL transcripts (C:/Users/clay/.claude/projects/**/*.jsonl)
  |
  v
ETL Pipeline (TypeScript)
  parse turns -> extract metadata -> chunk user+assistant pairs
  |
  v
Ollama bge-m3 (localhost:11434) -> 1024-dim vector embeddings
  |
  v
PostgreSQL + pgvector (localhost) -> anamnesis database
  |     - anamnesis_sessions (session metadata, tags, summary)
  |     - anamnesis_turns (user+assistant pairs with embeddings)
  |     - anamnesis_session_links (auto-links: file overlap, semantic, topic)
  |     - anamnesis_ingested_files (idempotency tracking)
  |
  v
MCP Server (stdio) -> anamnesis_search, anamnesis_recent, anamnesis_session, anamnesis_ingest
```

## Quick Start

### Prerequisites

- **Node.js** 18+
- **PostgreSQL** with pgvector extension
- **Ollama** with models:
  - `bge-m3` (embeddings)
  - `gemma3:12b` (topic extraction, optional)

### Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd Anamnesis
npm install
npm run build

# 2. Create database
createdb anamnesis
psql -d anamnesis -f src/db/schema.sql

# 3. Ensure Ollama models are available
ollama pull bge-m3
ollama pull gemma3:12b  # optional, for topic extraction

# 4. Edit config (optional — defaults work for standard setup)
# See anamnesis.config.json

# 5. Register MCP server in ~/.claude.json
# See "MCP Registration" below

# 6. Add SessionEnd hook to ~/.claude/settings.json
# See "Hook Setup" below

# 7. Run initial backfill
node dist/index.js backfill

# 8. Create HNSW indexes (after initial data load)
psql -d anamnesis -c "CREATE INDEX idx_turns_embedding ON anamnesis_turns USING hnsw (embedding vector_cosine_ops);"
psql -d anamnesis -c "CREATE INDEX idx_sessions_embedding ON anamnesis_sessions USING hnsw (session_embedding vector_cosine_ops);"

# 9. Run topic backfill (optional, requires gemma3:12b)
node dist/index.js backfill-topics

# 10. Verify
node dist/index.js stats
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `node dist/index.js ingest-session [id]` | Ingest a session (used by SessionEnd hook) |
| `node dist/index.js ingest <file>` | Ingest a single JSONL transcript |
| `node dist/index.js ingest-all` | Discover and ingest all new/changed transcripts |
| `node dist/index.js backfill` | Full backfill of all transcripts |
| `node dist/index.js backfill-topics` | Extract tags/summaries for sessions missing them |
| `node dist/index.js search <query>` | Semantic search across all turns |
| `node dist/index.js stats` | Show database statistics |

Options:
- `--force` — Force re-ingestion even if already processed (for `ingest` and `ingest-all`)

## Configuration

`anamnesis.config.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `exclude_projects` | `[]` | Project directory names to skip |
| `exclude_sessions` | `[]` | Specific session UUIDs to skip |
| `transcripts_root` | `C:/Users/clay/.claude/projects` | Where to find JSONL transcripts |
| `search_mode` | `hybrid` | Default search mode: `hybrid` or `vector` |
| `database.host` | `localhost` | PostgreSQL host |
| `database.port` | `5432` | PostgreSQL port |
| `database.database` | `anamnesis` | Database name |
| `database.user` | `clay` | Database user |
| `ollama.url` | `http://localhost:11434` | Ollama server URL |
| `ollama.model` | `bge-m3` | Embedding model |
| `topic_model.url` | `http://localhost:11434` | Topic extraction Ollama URL |
| `topic_model.model` | `gemma3:12b` | Topic extraction model |

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

## Hook Setup

### SessionEnd Hook (auto-ingest)

Add to `~/.claude/settings.json` in the `hooks.SessionEnd` array:

```json
{
  "type": "command",
  "command": "node D:/Projects/Anamnesis/dist/index.js ingest-session",
  "timeout": 30000,
  "statusMessage": "Saving to Anamnesis..."
}
```

### SessionStart Hook (proactive recall)

Place `anamnesis-recall.py` in `~/.claude/hooks/`:

```python
# See hooks/anamnesis-recall.py in this repo for the full implementation
```

This hook searches Anamnesis at session start and injects relevant context.

## MCP Registration

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "anamnesis": {
    "command": "node",
    "args": ["D:/Projects/Anamnesis/dist/mcp/index.js"],
    "env": {}
  }
}
```

## Database Tables

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

## Development

```bash
npm run build    # TypeScript -> dist/
npm run dev      # Watch mode (tsx)
```

## Adding Anamnesis to a New Machine

1. Install prerequisites: Node.js 18+, PostgreSQL + pgvector, Ollama
2. Pull Ollama models: `ollama pull bge-m3 && ollama pull gemma3:12b`
3. Clone repo: `git clone <repo> && cd Anamnesis && npm install && npm run build`
4. Create database: `createdb anamnesis && psql -d anamnesis -f src/db/schema.sql`
5. Edit `anamnesis.config.json` — set `transcripts_root`, database credentials
6. Register MCP server in `~/.claude.json` (see above)
7. Add SessionEnd hook to `~/.claude/settings.json` (see above)
8. Add SessionStart recall hook (see above)
9. Run initial backfill: `node dist/index.js backfill`
10. Create HNSW indexes (see Quick Start step 8)
11. Run topic backfill: `node dist/index.js backfill-topics`
12. Verify: `node dist/index.js stats`
