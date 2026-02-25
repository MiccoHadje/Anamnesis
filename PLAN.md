# Anamnesis Implementation Plan

> **Historical document.** This plan was written during initial development and is preserved for reference. The project is now at v1.0.0 with all phases complete.

## Context

Claude Code sessions start fresh with no memory of past work. Transcripts exist as JSONL files on disk but are unsearchable. Anamnesis parses these transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools so future sessions can semantically search past conversations.

See `DESIGN_BRIEF.md` for success goals, trigger catalog, and output state definition.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Chunking unit | User+Assistant pairs |
| Tool content | Include everything (file reads, grep, bash output) |
| Subagents | Main sessions + subagents >5KB |
| Ingestion | Dual: SessionEnd hook + scheduled task (every 15 min) |
| Stack | Node.js/TypeScript (ETL + MCP server) |
| Embedding | Ollama bge-m3, 1024-dim |
| Database | PostgreSQL + pgvector, local |
| Auto-linking | Layered: file overlap → semantic similarity → topic extraction |
| Access modes | Explicit + triggered (CLAUDE.md nudges) + proactive (session-start) |

## Project Structure

```
Anamnesis/
├── package.json
├── tsconfig.json
├── .gitignore
├── anamnesis.config.json     # Privacy exclusions, project mappings (gitignored)
├── anamnesis.config.example.json
├── CLAUDE.md / CONCEPT.md / DESIGN_BRIEF.md
├── hooks/                    # Example Claude Code hooks
├── skills/                   # Example Claude Code skills
├── src/
│   ├── index.ts              # CLI: ingest-session, ingest-all, backfill, stats, search
│   ├── mcp/
│   │   ├── index.ts          # MCP server entry (stdio, @modelcontextprotocol/sdk)
│   │   ├── tools.ts          # Tool definitions + handlers
│   │   └── daily-report.ts   # Daily report generation
│   ├── etl/
│   │   ├── parser.ts         # Streaming JSONL parser (readline)
│   │   ├── chunker.ts        # Group into user+assistant pairs
│   │   ├── embedder.ts       # Ollama bge-m3 client
│   │   ├── ingester.ts       # Orchestrator: parse → chunk → embed → store
│   │   ├── discovery.ts      # Find new/changed JSONL files
│   │   ├── metadata.ts       # Extract project, files_touched, tools_used
│   │   ├── linker.ts         # Auto-linking: file overlap, semantic similarity, topics
│   │   └── topics.ts         # Topic extraction via local LLM
│   ├── db/
│   │   ├── schema.sql        # DDL
│   │   ├── client.ts         # pg Pool wrapper
│   │   └── queries.ts        # Parameterized queries
│   └── util/
│       ├── text.ts           # Embedding text construction
│       └── config.ts         # Config loading, env overrides, tilde resolution
└── scripts/
    └── setup-scheduled-task.ps1  # Windows scheduled task
```

## Database Schema

Four tables:

1. **`anamnesis_ingested_files`** — Idempotency tracking. Stores `(file_path, file_size, file_mtime)` for each processed JSONL.

2. **`anamnesis_sessions`** — One row per session/subagent. Fields: `session_id`, `project_name`, `cwd`, `git_branch`, `model`, `started_at`, `ended_at`, `turn_count`, `files_touched[]`, `tools_used[]`, `is_subagent`, `parent_session_id`, `tags TEXT[]`, `summary TEXT`, `session_embedding vector(1024)`, `metadata JSONB`.

3. **`anamnesis_turns`** — One row per user+assistant pair. Fields: `session_id`, `turn_index`, `user_content`, `assistant_content`, `tool_calls JSONB`, `files_in_turn[]`, `timestamp_start/end`, `token_count`, `embedding_text`, `embedding vector(1024)`.

4. **`anamnesis_session_links`** — Auto-linking. Fields: `session_a`, `session_b`, `link_type` (enum: `file_overlap`, `semantic`, `topic`), `score FLOAT`, `shared_detail TEXT`.

## ETL Pipeline

1. **Discovery** — Glob transcripts directory, filter subagents <5KB, check privacy exclusions, diff against `anamnesis_ingested_files`
2. **Parse** — Stream JSONL line-by-line (readline). Yield typed objects per line.
3. **Chunk** — Filter to `user`/`assistant` types. Group: User(text) → Assistant(text+tool_use) → User(tool_result) → Assistant(response).
4. **Build embedding text** — `[Project: Name]\nUser: ...\n[Read: path]\n<truncated output>\nAssistant: ...` — cap tool output at 500 chars each, total at ~7500 tokens.
5. **Embed** — POST to Ollama API with bge-m3. Batch with configurable concurrency.
6. **Store** — Insert session row, then turn rows with embeddings. Wrap in transaction.
7. **Link** — After storing, run auto-linking (file overlap, semantic similarity, topic overlap).

## Implementation Phases

### Phase 1: Foundation ✅
Project scaffolding, database schema, parser, chunker, metadata extraction, config.

### Phase 2: Embeddings + Search ✅
Embedding text construction, Ollama client, ingester, discovery, vector search.

### Phase 3: MCP Server ✅
MCP server with 4 tools, registered in Claude Code.

### Phase 4: Auto-Linking ✅
File overlap, semantic similarity, session embedding computation.

### Phase 5: CLI + Hook + Scheduler ✅
CLI commands, SessionEnd hook, Windows scheduled task.

### Phase 6: Full Backfill ✅
All transcripts processed. 243 sessions, 4,745 turns ingested.

### Phase 7: Triggers + Proactive Recall ✅
CLAUDE.md trigger instructions, SessionStart recall hook, plan-mode recall hook.

### Phase 8: Polish + Topic Extraction ✅
Search quality improvements, hybrid search, topic extraction, documentation.

### Phase 9: Public Release ✅
Private info scrubbed, config externalized with env var overrides, GPL v3 license, example hooks/skills, daily reporting MCP tool, README rewrite.

## Key Dependencies

```
@modelcontextprotocol/sdk  — MCP server
pg + pgvector              — PostgreSQL + vector types
tsx                        — Dev runner
typescript + vitest        — Build/test
```
