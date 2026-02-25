# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Anamnesis** is a persistent semantic memory system for Claude Code sessions. It parses JSONL conversation transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools for future session context retrieval.

## Architecture

```
Claude Code JSONL transcripts (~/.claude/projects/**/*.jsonl)
  → ETL Pipeline (TypeScript) — parse turns, extract metadata, chunk user+assistant pairs
  → Ollama bge-m3 (localhost:11434) — 1024-dim vector embeddings
  → PostgreSQL + pgvector (localhost) — anamnesis database
  → MCP Server (stdio) — anamnesis_search, anamnesis_recent, anamnesis_session, anamnesis_ingest, anamnesis_daily_report
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

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point |
| `src/mcp/index.ts` | MCP server (stdio transport) |
| `src/mcp/tools.ts` | Tool definitions + handlers |
| `src/mcp/daily-report.ts` | Daily report generation logic |
| `src/etl/parser.ts` | Streaming JSONL parser |
| `src/etl/chunker.ts` | Groups messages into user+assistant turn pairs |
| `src/etl/embedder.ts` | Ollama bge-m3 embedding client |
| `src/etl/ingester.ts` | Full orchestrator: parse → chunk → embed → store → link |
| `src/etl/discovery.ts` | File scanning, idempotency, privacy filtering |
| `src/etl/linker.ts` | Auto-linking: file overlap + semantic similarity + topic overlap |
| `src/etl/topics.ts` | Topic extraction + summary via Ollama |
| `src/etl/metadata.ts` | Session metadata extraction (project, files, tools) |
| `src/db/schema.sql` | Database DDL (4 tables) |
| `src/db/client.ts` | pg Pool wrapper |
| `src/db/queries.ts` | All parameterized queries (CRUD + search) |
| `src/util/config.ts` | Config loading, env var overrides, tilde resolution |
| `src/util/text.ts` | Embedding text construction |
| `anamnesis.config.example.json` | Config template |

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
| Embedding | Ollama bge-m3, 1024-dim |
| Auto-linking | File overlap + semantic similarity + topic overlap (3 layers) |
| Search | Cosine similarity + hybrid (RRF with tsvector + recency boost), min threshold 0.3 |
| Topic extraction | Ollama (configurable model), 3-5 tags + 1-sentence summary per session |
| Idempotency | Track file_path + size + mtime in `anamnesis_ingested_files` |
| Config | JSON file + env var overrides, tilde resolution |

## Database Tables

- `anamnesis_sessions` — One row per session/subagent
- `anamnesis_turns` — One row per user+assistant pair, with embedding
- `anamnesis_ingested_files` — Idempotency tracking
- `anamnesis_session_links` — Auto-links (file_overlap, semantic, topic)

## Daily Reporting

The `anamnesis_daily_report` MCP tool generates activity reports from session data. The `/daily_duties` skill (in `skills/daily-duties/`) orchestrates full reporting workflows. Both require the `reporting` section in config.
