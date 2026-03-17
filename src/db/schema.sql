-- Anamnesis database schema
-- Run: psql -d anamnesis -f src/db/schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Idempotency tracking for ingested JSONL files
CREATE TABLE IF NOT EXISTS anamnesis_ingested_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_path TEXT UNIQUE NOT NULL,
  file_size BIGINT NOT NULL,
  file_mtime TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT
);

-- One row per session or subagent
CREATE TABLE IF NOT EXISTS anamnesis_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT UNIQUE NOT NULL,
  project_name TEXT,
  cwd TEXT,
  git_branch TEXT,
  model TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  turn_count INT DEFAULT 0,
  files_touched TEXT[] DEFAULT '{}',
  tools_used TEXT[] DEFAULT '{}',
  is_subagent BOOLEAN DEFAULT FALSE,
  parent_session_id TEXT,
  tags TEXT[] DEFAULT '{}',
  summary TEXT,
  session_embedding vector(1024),
  metadata JSONB DEFAULT '{}'
);

-- One row per user+assistant turn pair
CREATE TABLE IF NOT EXISTS anamnesis_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES anamnesis_sessions(session_id) ON DELETE CASCADE,
  turn_index INT NOT NULL,
  user_content TEXT,
  assistant_content TEXT,
  tool_calls JSONB DEFAULT '[]',
  files_in_turn TEXT[] DEFAULT '{}',
  timestamp_start TIMESTAMPTZ,
  timestamp_end TIMESTAMPTZ,
  token_count INT,
  embedding_text TEXT,
  embedding vector(1024),
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(user_content, '') || ' ' || coalesce(assistant_content, ''))
  ) STORED
);

-- Agent metadata for sessions
ALTER TABLE anamnesis_sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE anamnesis_sessions ADD COLUMN IF NOT EXISTS agent_type TEXT;

-- Compact summaries (one session can compact multiple times)
CREATE TABLE IF NOT EXISTS anamnesis_compact_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES anamnesis_sessions(session_id) ON DELETE CASCADE,
  compact_summary TEXT NOT NULL,
  trigger TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compact_session ON anamnesis_compact_summaries(session_id);

-- Auto-linking between sessions
DO $$ BEGIN
  CREATE TYPE link_type AS ENUM ('file_overlap', 'semantic', 'topic');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS anamnesis_session_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_a TEXT NOT NULL REFERENCES anamnesis_sessions(session_id) ON DELETE CASCADE,
  session_b TEXT NOT NULL REFERENCES anamnesis_sessions(session_id) ON DELETE CASCADE,
  link_type link_type NOT NULL,
  score FLOAT,
  shared_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_a, session_b, link_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_turns_session ON anamnesis_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON anamnesis_turns(timestamp_start);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON anamnesis_sessions(project_name);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON anamnesis_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_links_a ON anamnesis_session_links(session_a);
CREATE INDEX IF NOT EXISTS idx_links_b ON anamnesis_session_links(session_b);
CREATE INDEX IF NOT EXISTS idx_ingested_session ON anamnesis_ingested_files(session_id);

-- Full-text search index on turns
CREATE INDEX IF NOT EXISTS idx_turns_tsv ON anamnesis_turns USING GIN(tsv);

-- Vector indexes (HNSW for better recall than IVFFlat)
-- Created after initial data load for better index quality
-- Run manually after backfill:
--   CREATE INDEX idx_turns_embedding ON anamnesis_turns USING hnsw (embedding vector_cosine_ops);
--   CREATE INDEX idx_sessions_embedding ON anamnesis_sessions USING hnsw (session_embedding vector_cosine_ops);
