# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Anamnesis** is a persistent semantic memory system for Claude Code sessions. It parses JSONL conversation transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools for future session context retrieval.

## Architecture

```
Claude Code JSONL transcripts (~/.claude/projects/**/*.jsonl)
  → ETL Pipeline (TypeScript) — parse turns, extract metadata, chunk user+assistant pairs
  → Ollama bge-m3 (localhost:11434) — 1024-dim vector embeddings
  → Storage Layer (StorageBackend) — typed interface over PostgreSQL+pgvector
  → MCP Server (stdio) — anamnesis_search, anamnesis_recent, anamnesis_session, anamnesis_ingest, anamnesis_daily_report
  → Task Provider (optional) — read-only task data from Nudge DB or filesystem for report enrichment
```

## Commands

```bash
npm run build                              # TypeScript → dist/
node dist/index.js ingest-session [id]     # SessionEnd hook / manual
node dist/index.js ingest <file>           # Ingest single JSONL
node dist/index.js ingest-all              # Discover + ingest new transcripts
node dist/index.js backfill                # Full backfill of all transcripts
node dist/index.js backfill-topics         # Extract tags/summaries for all sessions
node dist/index.js search <query>          # CLI semantic search
node dist/index.js stats                   # Database statistics
```

## Directory Structure

```
src/
├── index.ts              # CLI entry point (delegates to storage + ETL)
├── types.ts              # All domain types (Session, Turn, SearchResult, etc.)
├── storage/              # Data access layer
│   ├── index.ts          # Factory: getStorage(), closeStorage()
│   ├── interface.ts      # StorageBackend + Transaction interfaces
│   └── pg.ts             # PgStorage implements StorageBackend (all SQL lives here)
├── tasks/                # Task Provider abstraction (read-only task data)
│   ├── index.ts          # Factory: createTaskProvider() from config
│   ├── interface.ts      # TaskProvider interface + TaskCompletion type
│   ├── nudge.ts          # NudgeProvider — queries Nudge PostgreSQL directly
│   └── filesystem.ts     # FileSystemProvider — reads markdown/JSON todo files
├── mcp/
│   ├── index.ts          # MCP server entry (stdio transport)
│   ├── tools.ts          # Tool schemas + handleTool() dispatch (~85 lines)
│   ├── handlers/         # One handler per MCP tool
│   │   ├── search.ts     # handleSearch + handleRecent
│   │   ├── session.ts    # handleSession
│   │   ├── ingest.ts     # handleIngest
│   │   └── report.ts     # handleDailyReport (creates TaskProvider, passes to daily-report)
│   ├── format.ts         # Shared: truncate, formatDuration, formatRelevance
│   └── daily-report.ts   # Report generation (uses storage + optional TaskProvider)
├── etl/
│   ├── parser.ts         # Streaming JSONL parser
│   ├── chunker.ts        # Groups messages into user+assistant turn pairs
│   ├── embedder.ts       # Ollama bge-m3 embedding client
│   ├── ingester.ts       # Full orchestrator: parse → chunk → embed → store → link
│   ├── discovery.ts      # File scanning, idempotency, privacy filtering
│   ├── linker.ts         # Auto-linking: file overlap + semantic + topic (Jaccard math)
│   ├── topics.ts         # Topic extraction + summary via Ollama
│   └── metadata.ts       # Session metadata extraction (project, files, tools)
├── db/
│   ├── schema.sql        # Database DDL (4 tables)
│   └── client.ts         # @internal — pg Pool wrapper, only used by PgStorage + migrate.ts
├── scripts/
│   └── migrate.ts        # Schema migration (keeps own pool — infrastructure script)
└── util/
    ├── text.ts           # Embedding text construction (config-driven max_embedding_chars)
    └── config.ts         # Config loading, validation, env var overrides, tilde resolution
```

## Key Architectural Patterns

| Pattern | Detail |
|---------|--------|
| **StorageBackend** | All data access goes through `getStorage()` — a typed interface. No raw SQL outside `storage/pg.ts`. |
| **Transaction** | Write operations (insert session/turns, update embeddings) go through `storage.transaction()` which exposes a `Transaction` interface. |
| **Domain types** | `src/types.ts` defines all row shapes (`Session`, `Turn`, `SearchResult`, etc.) — no `any` returns from storage. |
| **Tool dispatch** | `tools.ts` is schemas + dispatch only (~85 lines). Handler logic lives in `mcp/handlers/`. |
| **TaskProvider** | Optional read-only abstraction for task data. `NudgeProvider` queries Nudge DB directly; `FileSystemProvider` reads markdown/JSON. Created per-request, not a singleton. |
| **Config validation** | `validateConfig()` in `config.ts` checks port ranges, URL format, concurrency, search_mode. Throws `ConfigError`. |

## Infrastructure

| Component | Location | Notes |
|-----------|----------|-------|
| PostgreSQL + pgvector | localhost | Database: `anamnesis` |
| Ollama bge-m3 | localhost:11434 | 1024-dim embeddings |
| Transcripts | `~/.claude/projects/` | JSONL files |
| MCP server | Registered in `~/.claude.json` | stdio transport |
| SessionEnd hook | `~/.claude/settings.json` | Auto-ingest on session end |
| SessionStart hook | `~/.claude/hooks/` | Proactive recall at session start |
| Plan-mode hook | `~/.claude/hooks/` | PreToolUse on EnterPlanMode |
| Scheduled task | `scripts/setup-scheduled-task.ps1` | Every 15 min (Windows) |

## Design Decisions

| Decision | Choice |
|----------|--------|
| Chunking | User+assistant pairs (not individual messages) |
| Tool content | Include everything, summarized in embedding text |
| Subagents | Include if >5KB |
| Stack | Node.js/TypeScript |
| Embedding | Ollama bge-m3, 1024-dim, configurable `max_embedding_chars` (default 8000) |
| Storage | `StorageBackend` interface with `PgStorage` implementation. All SQL consolidated. |
| Auto-linking | File overlap + semantic similarity + topic overlap (3 layers). Jaccard math in linker.ts, SQL in storage. |
| Search | Cosine similarity + hybrid (RRF with tsvector + recency boost), min threshold 0.3 |
| Topic extraction | Ollama (configurable model), 3-5 tags + 1-sentence summary per session |
| Idempotency | Track file_path + size + mtime in `anamnesis_ingested_files` |
| Config | JSON file + env var overrides, tilde resolution, validation on load |
| Task data | Optional `TaskProvider` interface. Nudge DB or filesystem adapters. Graceful degradation. |

## Database Tables

- `anamnesis_sessions` — One row per session/subagent
- `anamnesis_turns` — One row per user+assistant pair, with embedding
- `anamnesis_ingested_files` — Idempotency tracking
- `anamnesis_session_links` — Auto-links (file_overlap, semantic, topic)

## Daily Reporting

The `anamnesis_daily_report` MCP tool generates activity reports from session data. When a `tasks` provider is configured (Nudge DB or filesystem), reports automatically include task completion data. The `/daily_duties` skill (in `skills/daily-duties/`) orchestrates full reporting workflows. Both require the `reporting` section in config.
