import type { Turn } from '../etl/chunker.js';

const MAX_TOOL_OUTPUT_CHARS = 500;
const MAX_EMBEDDING_CHARS = 8000; // bge-m3 has 8192 token context; ~1 char/token for code-heavy text

/**
 * Build the text that will be embedded for a turn.
 * Format:
 *   [Project: RPGDash]
 *   User: <user content>
 *   [Read: path/to/file]
 *   <truncated output>
 *   Assistant: <assistant content>
 */
export function buildEmbeddingText(turn: Turn, projectName?: string): string {
  const parts: string[] = [];

  if (projectName) {
    parts.push(`[Project: ${projectName}]`);
  }

  if (turn.userContent) {
    parts.push(`User: ${turn.userContent}`);
  }

  // Include tool call summaries
  for (const tc of turn.toolCalls) {
    const summary = tc.input_summary
      ? `[${tc.name}: ${truncate(tc.input_summary, MAX_TOOL_OUTPUT_CHARS)}]`
      : `[${tc.name}]`;
    parts.push(summary);
  }

  if (turn.assistantContent) {
    parts.push(`Assistant: ${turn.assistantContent}`);
  }

  const text = parts.join('\n');
  return text.length > MAX_EMBEDDING_CHARS
    ? text.slice(0, MAX_EMBEDDING_CHARS)
    : text;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
