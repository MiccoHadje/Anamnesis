import { handleSearch, handleRecent } from './handlers/search.js';
import { handleSession } from './handlers/session.js';
import { handleIngest } from './handlers/ingest.js';
import { handleDailyReport } from './handlers/report.js';

export const tools = [
  {
    name: 'anamnesis_search',
    description:
      'Search past Claude Code sessions by semantic similarity. Returns the most relevant conversation turns from past sessions. Use for: finding past decisions, implementations, debugging sessions, or any historical context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        project: { type: 'string', description: 'Filter by project name (e.g., "RPGDash", "Anamnesis")' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        since: { type: 'string', description: 'Only search sessions after this date (ISO 8601)' },
        hybrid: { type: 'boolean', description: 'Use hybrid search (semantic + keyword). Better for exact terms.' },
        budget: { type: 'number', description: 'Target token budget for context assembly. Uses link-enriched, deduplicated results. Typical: 800 (hooks), 2000 (planning), 4000 (research).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'anamnesis_recent',
    description:
      'Browse recent Claude Code sessions. Shows session summaries with project, date, tools used, and files touched. Useful for: session continuity, reviewing recent work, finding what was done on a project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Filter by project name' },
        days: { type: 'number', description: 'Look back N days (default 7)' },
        file: { type: 'string', description: 'Filter sessions that touched this file path' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'anamnesis_session',
    description:
      'Get full details of a specific session by ID (partial ID OK). Includes all turns and related sessions. Use when you found a relevant session via search/recent and want the full context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Session ID (or first 8+ characters)' },
        turn_range: { type: 'string', description: 'Optional turn range, e.g., "0-3" or "5"' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'anamnesis_ingest',
    description:
      'Trigger ingestion of transcript files. Without arguments, discovers and ingests all new/changed files. With session_id, ingests that specific session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Specific session ID to ingest' },
        force: { type: 'boolean', description: 'Force re-ingestion even if already processed' },
      },
    },
  },
  {
    name: 'anamnesis_daily_report',
    description:
      'Generate a daily activity report from Anamnesis session data. Returns a markdown report summarizing sessions, topics, and time allocation for a given date. If project is specified, returns a per-project report; otherwise returns a cross-project summary. Requires the "reporting" section in config.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date to report on (YYYY-MM-DD). Defaults to yesterday.' },
        project: { type: 'string', description: 'Specific project name for a per-project report. Omit for cross-project summary.' },
      },
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'anamnesis_search':
      return handleSearch(args);
    case 'anamnesis_recent':
      return handleRecent(args);
    case 'anamnesis_session':
      return handleSession(args);
    case 'anamnesis_ingest':
      return handleIngest(args);
    case 'anamnesis_daily_report':
      return handleDailyReport(args);
    default:
      return `Unknown tool: ${name}`;
  }
}
