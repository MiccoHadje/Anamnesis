/**
 * Domain types for Anamnesis.
 * All database row shapes and DTOs live here.
 */

// --- Sessions ---

export interface Session {
  id: string;
  session_id: string;
  project_name: string | null;
  cwd: string | null;
  git_branch: string | null;
  model: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  turn_count: number;
  files_touched: string[];
  tools_used: string[];
  is_subagent: boolean;
  parent_session_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tags: string[];
  summary: string | null;
  session_embedding: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionDetail extends Session {
  turns: Turn[];
  related_sessions: SessionLink[];
}

/** Subset returned by getRecentSessions */
export interface RecentSession {
  session_id: string;
  project_name: string | null;
  cwd: string | null;
  model: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  turn_count: number;
  files_touched: string[];
  tools_used: string[];
  summary: string | null;
  is_subagent: boolean;
}

/** Subset used by daily reports */
export interface SessionSummary {
  session_id: string;
  project_name: string;
  started_at: Date;
  ended_at: Date | null;
  turn_count: number;
  model: string | null;
  summary: string | null;
  tags: string[] | null;
  files_touched: string[];
  tools_used: string[];
  is_subagent: boolean;
}

// --- Turns ---

/** Turn row for display (no embedding) */
export interface Turn {
  turn_index: number;
  user_content: string | null;
  assistant_content: string | null;
  tool_calls: unknown[];
  files_in_turn: string[];
  timestamp_start: Date | null;
  timestamp_end: Date | null;
  token_count: number | null;
}

/** Full turn for insertion including embedding data */
export interface TurnInsert {
  session_id: string;
  turn_index: number;
  user_content?: string;
  assistant_content?: string;
  tool_calls: unknown[];
  files_in_turn: string[];
  timestamp_start?: Date;
  timestamp_end?: Date;
  token_count?: number;
  embedding_text?: string;
  embedding: number[];
}

/** Session data for insertion */
export interface SessionInsert {
  session_id: string;
  project_name?: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
  started_at?: Date;
  ended_at?: Date;
  turn_count: number;
  files_touched: string[];
  tools_used: string[];
  is_subagent: boolean;
  parent_session_id?: string;
  agent_id?: string;
  agent_type?: string;
  metadata?: Record<string, unknown>;
}

// --- Compact Summaries ---

export interface CompactSummary {
  id: string;
  session_id: string;
  compact_summary: string;
  trigger: string | null;
  created_at: Date;
}

// --- Links ---

export interface SessionLink {
  session_a: string;
  session_b: string;
  link_type: string;
  score: number;
  shared_detail: string | null;
  project_name: string | null;
  started_at: Date | null;
  summary: string | null;
}

// --- Search ---

export interface SearchResult {
  session_id: string;
  turn_index: number;
  project_name: string;
  user_content: string;
  assistant_content: string;
  similarity: number;
  timestamp_start: Date;
  started_at: Date;
}

export interface SearchOpts {
  project?: string;
  limit?: number;
  since?: string;
  minSimilarity?: number;
}

// --- Topics ---

export interface SessionWithoutTopics {
  session_id: string;
  project_name: string | null;
  files_touched: string[];
  tools_used: string[];
  turn_count: number;
}

// --- Stats ---

export interface Stats {
  sessions: number;
  turns: number;
  files: number;
  links: number;
}

// --- Ingested Files ---

export interface IngestedFile {
  file_path: string;
  file_size: number;
  file_mtime: string;
}

// --- Ingest ---

export interface IngestResult {
  sessionId: string;
  turnCount: number;
  projectName?: string;
  skipped: boolean;
  error?: string;
}

// --- Linker helpers ---

export interface SessionFiles {
  session_id: string;
  files_touched: string[];
}

export interface SessionTags {
  session_id: string;
  tags: string[];
}

export interface SimilarSession {
  session_id: string;
  similarity: number;
}

// --- Session Meta (lightweight, no turns) ---

/** Lightweight session metadata for context builder batch lookups. */
export interface SessionMeta {
  session_id: string;
  project_name: string | null;
  summary: string | null;
  tags: string[];
  started_at: Date | null;
  turn_count: number;
}

// --- Config ---

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
