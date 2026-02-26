/**
 * Types for the smart context builder pipeline.
 * Query + Budget → Gather → Allocate → Render → ContextResult
 */

export interface ContextRequest {
  query: string;
  budget: number;           // Target tokens (800, 2000, 4000, 8000)
  project?: string;
  since?: string;
  hybrid?: boolean;
  maxLinkDepth?: number;    // Default 1, max 2
}

export interface ContextResult {
  markdown: string;
  tokenEstimate: number;
  sessionIds: string[];
  truncated: boolean;
}

export type DetailLevel = 'full' | 'summary' | 'title' | 'omit';

export interface ContextItem {
  sessionId: string;
  turnIndex: number | null;
  projectName: string;
  similarity: number;
  source: 'search' | 'link';
  linkType?: string;
  userContent: string | null;
  assistantContent: string | null;
  sessionSummary: string | null;
  sessionTags: string[];
  startedAt: Date | null;
  // Token cost estimates at each detail level
  costFull: number;
  costSummary: number;
  costTitle: number;
  // Drill-down hints
  relatedTurns: { turnIndex: number; similarity: number }[];
  linkedSessions: LinkedSessionHint[];
}

export interface LinkedSessionHint {
  sessionId: string;
  projectName: string;
  linkType: string;
  score: number;
  detail: string | null;
}

/** Estimate token count from character length. ~4 chars per token for English. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Token cost constants for budget allocation. */
export const COST_FULL_USER_CHARS = 800;
export const COST_FULL_ASSISTANT_CHARS = 1500;
export const COST_SUMMARY_CHARS = 400;
export const COST_TITLE_CHARS = 80;
