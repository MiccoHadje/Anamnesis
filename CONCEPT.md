# Anamnesis

> *The recollection of knowledge the soul possessed before birth. Memory not as record but as recovery. The act of remembering something you have always known but had forgotten you knew.*

## What It Is

A system that captures Claude Code conversation transcripts, stores them in PostgreSQL with vector embeddings, and makes them searchable from future sessions via MCP tools. The goal is persistent, semantic memory across Claude Code sessions.

## The Problem

Claude Code sessions start fresh. Context from past sessions exists only in:
- Auto-memory files (manually curated, limited)
- JSONL transcript files on disk (raw, unsearchable)
- The user's head

When a topic spans multiple sessions, finding that context later requires remembering it exists and manually searching transcript files.

## The Solution

1. **ETL Pipeline** - Parse Claude Code JSONL transcripts, extract conversation turns with metadata (project, files touched, tools used, timestamps)
2. **PostgreSQL + pgvector** - Store turns with vector embeddings for semantic similarity search
3. **MCP Tools** - `anamnesis_search`, `anamnesis_recent`, `anamnesis_session`, `anamnesis_ingest`, `anamnesis_daily_report`
4. **Metadata Extraction** - Auto-tag sessions with projects, files modified, topics discussed
5. **Auto-Linking** - Connect related sessions by shared files, semantic similarity, and topics

## Architecture

```
Claude Code JSONL transcripts
        │
        ▼
   ETL Pipeline (TypeScript)
   - Parse turns, extract metadata
   - Chunk user+assistant pairs
        │
        ▼
   Ollama bge-m3
   - Generate 1024-dim embeddings
        │
        ▼
   PostgreSQL + pgvector
   - anamnesis_sessions (metadata, tags, summary)
   - anamnesis_turns (content + embeddings)
   - anamnesis_session_links (auto-links)
   - anamnesis_ingested_files (idempotency)
        │
        ▼
   MCP Server (stdio)
   - Semantic search, browsing, ingestion, reporting
```

## Open Questions (Resolved)

- **Transcript location**: `~/.claude/projects/<encoded-dir>/*.jsonl`
- **Chunking strategy**: User+assistant pairs (captures full context per turn)
- **Tool content**: Include everything, summarized in embedding text
- **Ingestion trigger**: Dual — SessionEnd hook (immediate) + scheduled task (catch-up)
- **Summaries**: Auto-generated via local LLM (topic extraction)
- **bge-m3 dimension**: 1024

## Origin

Named during a Varisian Legacy (PF2e) session on 2026-02-19. The party encountered Ioziviath, guardian of the Still Place beneath Kaer Maga, who described Anamnesis: an entity that is the embodiment of Memory, dwelling within Xavorax. The Grammarian noted that its tense structure "should not be having been possible." The name was too perfect not to use.
