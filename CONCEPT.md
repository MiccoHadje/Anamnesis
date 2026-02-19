# Anamnesis

> *The recollection of knowledge the soul possessed before birth. Memory not as record but as recovery. The act of remembering something you have always known but had forgotten you knew.*

## What It Is

A system that captures Claude Code conversation transcripts, stores them in PostgreSQL with vector embeddings, and makes them searchable from future sessions via MCP tools. The goal is persistent, semantic memory across Claude Code sessions.

## The Problem

Claude Code sessions start fresh. Context from past sessions exists only in:
- Auto-memory files (manually curated, limited)
- JSONL transcript files on disk (raw, unsearchable)
- The user's head

When a topic spans multiple sessions (like tonight's Counterspell house rule discussion that touched rules research, document updates, and build decisions), finding that context later requires remembering it exists and manually searching transcript files.

## The Solution

1. **ETL Pipeline** - Parse Claude Code JSONL transcripts, extract conversation turns with metadata (project, files touched, tools used, timestamps)
2. **PostgreSQL + pgvector** - Store turns with vector embeddings for semantic similarity search
3. **MCP Tool** - `anamnesis_search` (or similar) that future Claude Code sessions can call to retrieve relevant past context
4. **Metadata Extraction** - Auto-tag sessions with projects, files modified, topics discussed

## Architecture

```
Claude Code JSONL transcripts
        │
        ▼
   ETL Script (Python)
   - Parse turns, extract metadata
   - Chunk for embedding
        │
        ▼
   Ollama bge-m3 (WS25 or Max)
   - Generate embeddings
        │
        ▼
   PostgreSQL + pgvector (Max)
   - conversation_sessions table
   - conversation_turns table
   - vector similarity index
        │
        ▼
   MCP Server
   - anamnesis_search (semantic query)
   - anamnesis_recent (by project/date)
   - anamnesis_context (full session retrieval)
```

## Infrastructure (Already Available)

| Component | Location | Status |
|-----------|----------|--------|
| PostgreSQL + pgvector | Max (192.168.1.10) | Running |
| Ollama + bge-m3 | WS25 (local) | Running |
| Claude Code transcripts | Local disk (WS25) | Exist |
| MCP server framework | Multiple examples in ecosystem | Ready |

## Schema Sketch

```sql
CREATE TABLE anamnesis_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT UNIQUE NOT NULL,
  project TEXT,                    -- e.g., "Game Characters", "RPGDash"
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  model TEXT,                      -- e.g., "claude-opus-4-6"
  summary TEXT,                    -- auto-generated or extracted
  files_touched TEXT[],            -- parsed from tool calls
  tags TEXT[]
);

CREATE TABLE anamnesis_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT REFERENCES anamnesis_sessions(session_id),
  turn_number INT,
  role TEXT NOT NULL,              -- user, assistant, tool_use, tool_result
  content TEXT,
  tool_name TEXT,                  -- if tool_use/tool_result
  timestamp TIMESTAMPTZ,
  embedding vector(1024),          -- bge-m3 dimension
  metadata JSONB                   -- flexible: files read, edits made, etc.
);

CREATE INDEX ON anamnesis_turns
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

## MCP Tools (Planned)

| Tool | Purpose |
|------|---------|
| `anamnesis_search` | Semantic search across all past turns. Returns relevant context with session metadata. |
| `anamnesis_recent` | Recent sessions by project, date range, or file path. |
| `anamnesis_session` | Retrieve a full session transcript by ID. |
| `anamnesis_ingest` | Manually trigger ingestion of new transcripts. |

## Open Questions

- Where exactly does Claude Code store JSONL transcripts on Windows? Need to locate.
- Chunking strategy: per-turn, or group user+assistant pairs?
- Should tool_use/tool_result turns be embedded, or just user/assistant content?
- Ingestion trigger: cron job, manual, or hook-based?
- Should summaries be auto-generated per session via Gateway?
- bge-m3 embedding dimension: verify 1024 is correct for the model variant in use.

## Origin

Named during a Varisian Legacy (PF2e) session on 2026-02-19. The party encountered Ioziviath, guardian of the Still Place beneath Kaer Maga, who described Anamnesis: an entity that is the embodiment of Memory, dwelling within Xavorax. The Grammarian noted that its tense structure "should not be having been possible." The name was too perfect not to use.

## Nudge Project

- **Project:** @Anamnesis
- **Category:** DevOps
- **ID:** 11e34a1a-2734-40a3-9017-c24da3131a37
