import type {
  SessionDetail,
  RecentSession,
  SessionSummary,
  SessionWithoutTopics,
  SessionInsert,
  TurnInsert,
  SearchResult,
  SearchOpts,
  Stats,
  IngestedFile,
  SessionFiles,
  SessionTags,
  SimilarSession,
  SessionMeta,
  SessionLink,
  CompactSummary,
} from '../types.js';

/**
 * Write-only operations available inside a transaction.
 */
export interface Transaction {
  insertSession(session: SessionInsert): Promise<void>;
  insertTurnWithEmbedding(turn: TurnInsert): Promise<void>;
  updateSessionEmbedding(sessionId: string, embedding: number[]): Promise<void>;
  mergeSessionEmbedding(sessionId: string, newEmbeddings: number[][], existingCount: number): Promise<void>;
  deleteSessionData(sessionId: string): Promise<void>;
  upsertIngestedFile(path: string, size: number, mtime: Date, sessionId: string): Promise<void>;
  insertCompactSummary(sessionId: string, summary: string, trigger?: string): Promise<void>;
}

/**
 * Storage backend interface for all Anamnesis data access.
 */
export interface StorageBackend {
  // Lifecycle
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;

  // Ingested files
  getIngestedFile(path: string): Promise<IngestedFile | null>;
  getIngestedFilesMap(paths: string[]): Promise<Map<string, IngestedFile>>;
  upsertIngestedFile(path: string, size: number, mtime: Date, sessionId: string): Promise<void>;

  // Sessions
  getSessionTurnCount(sessionId: string): Promise<number>;
  getSession(sessionId: string): Promise<SessionDetail | null>;
  getRecentSessions(opts?: { project?: string; days?: number; file?: string; limit?: number }): Promise<RecentSession[]>;
  getSessionsForDate(date: string, project?: string): Promise<SessionSummary[]>;
  getSessionsWithoutTopics(limit?: number): Promise<SessionWithoutTopics[]>;

  // Search
  searchByEmbedding(embedding: number[], opts?: SearchOpts): Promise<SearchResult[]>;
  searchHybrid(embedding: number[], query: string, opts?: SearchOpts): Promise<SearchResult[]>;

  // Topics
  updateSessionTopics(sessionId: string, tags: string[], summary: string): Promise<void>;
  getFirstUserMessage(sessionId: string): Promise<string | null>;
  getSessionTurnTexts(sessionId: string): Promise<string[]>;

  // Linking
  getSessionFiles(sessionId: string): Promise<string[]>;
  getSessionsWithOverlappingFiles(sessionId: string, files: string[]): Promise<SessionFiles[]>;
  getSessionTags(sessionId: string): Promise<string[]>;
  getSessionsWithOverlappingTags(sessionId: string, tags: string[]): Promise<SessionTags[]>;
  findSimilarSessions(sessionId: string, topN?: number): Promise<SimilarSession[]>;
  upsertSessionLink(a: string, b: string, linkType: string, score: number, detail: string): Promise<void>;

  // Context builder
  getSessionMetaBatch(sessionIds: string[]): Promise<SessionMeta[]>;
  getLinksForSessions(sessionIds: string[]): Promise<SessionLink[]>;

  // Compact summaries
  getCompactSummaries(sessionId: string): Promise<CompactSummary[]>;
  insertCompactSummary(sessionId: string, summary: string, trigger?: string): Promise<void>;

  // Stats
  getStats(): Promise<Stats>;
}
