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
  → HTTP Server (persistent) — hook handlers, periodic ingest, compact summary storage
  → Task Provider (optional) — read-only task data from Nudge DB or filesystem for report enrichment
```

## Commands

```bash
npm run build                              # TypeScript → dist/
npm run server                             # Start HTTP server (persistent background process)
npm run server:dev                         # Start HTTP server with tsx (dev mode)
node dist/index.js ingest-session [id]     # SessionEnd hook / manual
node dist/index.js ingest <file>           # Ingest single JSONL
node dist/index.js ingest-all              # Discover + ingest new transcripts
node dist/index.js backfill                # Full backfill of all transcripts
node dist/index.js backfill-topics         # Extract tags/summaries for all sessions
node dist/index.js search <query>          # CLI semantic search
node dist/index.js context <query>         # Budget-aware context assembly (--budget N --project NAME)
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
│   ├── github.ts         # GitHubProvider — queries GitHub Issues via gh CLI
│   ├── todoist.ts        # TodoistProvider — queries Todoist REST + Sync APIs
│   ├── linear.ts         # LinearProvider — queries Linear GraphQL API
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
├── context/              # Smart context builder (budget-aware assembly)
│   ├── types.ts          # ContextRequest, ContextResult, ContextItem, DetailLevel
│   ├── builder.ts        # buildContext() — orchestrates gather → allocate → render
│   ├── gather.ts         # Search + dedup + diversity + link traversal
│   ├── allocate.ts       # Greedy budget fill with progressive detail
│   └── render.ts         # Progressive-detail markdown formatting
├── server.ts             # HTTP server entry point (persistent, separate from MCP)
├── server/               # HTTP server modules
│   ├── routes.ts         # Route handlers for all hook endpoints
│   ├── timer.ts          # Periodic ingest timer (configurable interval)
│   └── pid.ts            # PID file management
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
│   ├── schema.sql        # Database DDL (5 tables)
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
| **TaskProvider** | Optional read-only abstraction for task data. 5 providers: `GitHubProvider` (recommended, `gh` CLI), `TodoistProvider` (REST API), `LinearProvider` (GraphQL API), `FileSystemProvider` (markdown/JSON), `NudgeProvider` (Nudge DB). Created per-request, not a singleton. |
| **Context builder** | `buildContext()` is a stateless three-phase pipeline (gather → allocate → render). Budget param on `anamnesis_search` dispatches to it; without budget, original top-N behavior is unchanged. |
| **Config validation** | `validateConfig()` in `config.ts` checks port ranges, URL format, concurrency, search_mode. Throws `ConfigError`. |
| **HTTP server** | Persistent process (`src/server.ts`) separate from ephemeral MCP server. Shares all code via imports. Handles hooks, periodic ingest, compact summaries. Zero new dependencies (`node:http`). |
| **Hook shim** | `hooks/anamnesis-shim.py` — single Python file for all hooks. Reads stdin JSON, POSTs to server. Auto-starts server on SessionStart if down. |

## Infrastructure

| Component | Location | Notes |
|-----------|----------|-------|
| PostgreSQL + pgvector | localhost | Database: `anamnesis` |
| Ollama bge-m3 | localhost:11434 | 1024-dim embeddings |
| Transcripts | `~/.claude/projects/` | JSONL files |
| MCP server | Registered in `~/.claude.json` | stdio transport (ephemeral, per-session) |
| HTTP server | `node dist/server.js` on port 3851 | Persistent, auto-started by shim |
| Hook shim | `hooks/anamnesis-shim.py` | Universal shim for all hook endpoints |
| Hooks | `~/.claude/settings.json` | SessionStart, SessionEnd, PreCompact, PostCompact, PlanRecall |
| Periodic ingest | HTTP server timer | Every 15 min (configurable), batch of 10 files |

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
| Context builder | Token-budget-aware assembly via gather → allocate → render pipeline, leveraging session link graph |
| Diversity re-rank | MMR heuristic: same-session=1.0, same-project=0.3 penalty (avoids pairwise embedding comparison) |
| Incremental ingest | Only new turns are embedded on re-ingest. Session embedding updated via weighted merge. Topic re-extraction only if 5+ new turns. |
| HTTP server | `node:http` built-in — zero new deps. Separate from MCP (persistent vs. ephemeral). Port 3851. |
| Compact summaries | Separate table (not column) — sessions can compact multiple times |
| Periodic ingest | Timer in HTTP server, 15 min default, batch of 10 files/tick, non-overlapping |
| Idempotency | Track file_path + size + mtime in `anamnesis_ingested_files` |
| Config | JSON file + env var overrides, tilde resolution, validation on load |
| Task data | Optional `TaskProvider` interface. GitHub Issues (recommended), Todoist, Linear, filesystem, or Nudge adapters. Graceful degradation. |

## HTTP Server

The HTTP server (`src/server.ts`) is a persistent background process separate from the MCP server. It handles all hook logic, periodic ingestion, and compact summary storage.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check + uptime + version + PID |
| `/stats` | GET | DB stats + timer status |
| `/hooks/session-start` | POST | Recent sessions + Nudge focus → systemMessage |
| `/hooks/session-end` | POST | Trigger ingestion of session |
| `/hooks/pre-compact` | POST | Extract state, trigger ingest, return continuation |
| `/hooks/post-compact` | POST | Store compact_summary, trigger ingest |
| `/hooks/plan-recall` | POST | Embed query → semantic search → additionalContext |
| `/ingest` | POST | On-demand ingestion trigger |

Config section: `server.port` (3851), `server.host` (127.0.0.1), `server.ingest_interval_minutes` (15), `server.pid_file`.

## Database Tables

- `anamnesis_sessions` — One row per session/subagent (includes `agent_id`, `agent_type`)
- `anamnesis_turns` — One row per user+assistant pair, with embedding
- `anamnesis_ingested_files` — Idempotency tracking
- `anamnesis_session_links` — Auto-links (file_overlap, semantic, topic)
- `anamnesis_compact_summaries` — Compact summaries from PreCompact/PostCompact hooks

## Daily Reporting

The `anamnesis_daily_report` MCP tool generates activity reports from session data. When a `tasks` provider is configured (Nudge DB or filesystem), reports automatically include task completion data. The `/daily_duties` skill (in `skills/daily-duties/`) orchestrates full reporting workflows. Both require the `reporting` section in config.
