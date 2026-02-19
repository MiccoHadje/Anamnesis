# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Anamnesis** is a persistent semantic memory system for Claude Code sessions. It parses JSONL conversation transcripts, embeds them with bge-m3, stores them in PostgreSQL+pgvector, and exposes them via MCP tools for future session context retrieval.

**Status:** Phases 1-5 complete. MCP server registered, SessionEnd hook active, CLI functional. Backfill pending.

## Architecture

```
Claude Code JSONL transcripts (C:/Users/clay/.claude/projects/*/*.jsonl)
  → ETL Pipeline (TypeScript) — parse turns, extract metadata, chunk user+assistant pairs
  → Ollama bge-m3 (WS25 localhost:11434) — 1024-dim vector embeddings
  → PostgreSQL + pgvector (WS25 localhost) — anamnesis database
  → MCP Server (stdio) — anamnesis_search, anamnesis_recent, anamnesis_session, anamnesis_ingest
```

## Commands

```bash
node dist/index.js ingest-session [id]   # SessionEnd hook / manual
node dist/index.js ingest <file>         # Ingest single JSONL
node dist/index.js ingest-all            # Discover + ingest new transcripts
node dist/index.js backfill              # Full backfill of all transcripts
node dist/index.js search <query>        # CLI semantic search
node dist/index.js stats                 # Database statistics
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point |
| `src/mcp/index.ts` | MCP server (stdio transport) |
| `src/mcp/tools.ts` | Tool definitions + handlers |
| `src/etl/parser.ts` | Streaming JSONL parser |
| `src/etl/chunker.ts` | Groups messages into user+assistant turn pairs |
| `src/etl/embedder.ts` | Ollama bge-m3 embedding client |
| `src/etl/ingester.ts` | Full orchestrator: parse → chunk → embed → store → link |
| `src/etl/discovery.ts` | File scanning, idempotency, privacy filtering |
| `src/etl/linker.ts` | Auto-linking: file overlap + semantic similarity |
| `src/etl/metadata.ts` | Session metadata extraction (project, files, tools) |
| `src/db/schema.sql` | Database DDL (4 tables) |
| `src/db/client.ts` | pg Pool wrapper |
| `src/db/queries.ts` | All parameterized queries (CRUD + search) |
| `src/util/config.ts` | Config loading from anamnesis.config.json |
| `src/util/text.ts` | Embedding text construction |
| `anamnesis.config.json` | Privacy exclusions, DB/Ollama connection settings |

## Infrastructure

| Component | Location | Notes |
|-----------|----------|-------|
| PostgreSQL + pgvector | WS25 localhost | Database: `anamnesis` |
| Ollama bge-m3 | WS25 localhost:11434 | 1024-dim embeddings |
| Transcripts | `C:/Users/clay/.claude/projects/` | JSONL files |
| MCP server | Registered in `~/.claude.json` | stdio transport |
| SessionEnd hook | `~/.claude/settings.json` | Auto-ingest on session end |
| Scheduled task | `scripts/setup-scheduled-task.ps1` | Every 15 min (needs admin setup) |

## Design Decisions

| Decision | Choice |
|----------|--------|
| Chunking | User+assistant pairs (not individual messages) |
| Tool content | Include everything, summarized in embedding text |
| Subagents | Include if >5KB |
| Stack | Node.js/TypeScript |
| Embedding | Ollama bge-m3, 1024-dim, concurrency 4 |
| Database | WS25 localhost (collocated with transcripts + model) |
| Auto-linking | File overlap + semantic similarity (topic extraction deferred) |
| Search | Cosine similarity + optional hybrid (RRF with tsvector) |
| Idempotency | Track file_path + size + mtime in `anamnesis_ingested_files` |

## Database Tables

- `anamnesis_sessions` — One row per session/subagent
- `anamnesis_turns` — One row per user+assistant pair, with embedding
- `anamnesis_ingested_files` — Idempotency tracking
- `anamnesis_session_links` — Auto-links (file_overlap, semantic, topic)

## Task Tracking

- **Nudge Project:** `@Anamnesis` (ID: `11e34a1a-2734-40a3-9017-c24da3131a37`)
- **Category:** DevOps
