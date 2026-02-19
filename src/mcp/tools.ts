import { embed } from '../etl/embedder.js';
import { ingestFile } from '../etl/ingester.js';
import { discoverFiles, findFileBySessionId } from '../etl/discovery.js';
import { ingestFiles } from '../etl/ingester.js';
import {
  searchByEmbedding,
  searchHybrid,
  getRecentSessions,
  getSession,
  getStats,
} from '../db/queries.js';

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
    default:
      return `Unknown tool: ${name}`;
  }
}

async function handleSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || '');
  if (!query) return 'Error: query is required';

  const project = args.project as string | undefined;
  const limit = (args.limit as number) || 5;
  const since = args.since as string | undefined;
  const hybrid = args.hybrid as boolean | undefined;

  const queryEmb = await embed(query);

  const results = hybrid
    ? await searchHybrid(queryEmb, query, { project, limit, since })
    : await searchByEmbedding(queryEmb, { project, limit, since });

  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [`Found ${results.length} results:\n`];
  for (const r of results) {
    const date = r.started_at ? new Date(r.started_at).toLocaleDateString() : '?';
    const sim = typeof r.similarity === 'number' ? `${(r.similarity * 100).toFixed(1)}%` : '?';
    lines.push(`## [${r.project_name || '?'}] ${r.session_id.slice(0, 8)} turn ${r.turn_index} — ${sim} match — ${date}`);
    if (r.user_content) {
      lines.push(`**User:** ${truncate(r.user_content, 300)}`);
    }
    if (r.assistant_content) {
      lines.push(`**Assistant:** ${truncate(r.assistant_content, 500)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function handleRecent(args: Record<string, unknown>): Promise<string> {
  const project = args.project as string | undefined;
  const days = (args.days as number) || 7;
  const file = args.file as string | undefined;
  const limit = (args.limit as number) || 10;

  const sessions = await getRecentSessions({ project, days, file, limit });

  if (sessions.length === 0) {
    return `No sessions found in the last ${days} days.`;
  }

  const lines: string[] = [`${sessions.length} recent sessions:\n`];
  for (const s of sessions) {
    const date = new Date(s.started_at).toLocaleString();
    const tools = (s.tools_used || []).join(', ');
    lines.push(`## ${s.session_id.slice(0, 8)} — ${s.project_name || '?'} — ${date}`);
    lines.push(`  Turns: ${s.turn_count} | Model: ${s.model || '?'}`);
    if (tools) lines.push(`  Tools: ${tools}`);
    if (s.summary) lines.push(`  Summary: ${s.summary}`);
    if (s.files_touched?.length) {
      lines.push(`  Files: ${s.files_touched.slice(0, 5).join(', ')}${s.files_touched.length > 5 ? ` (+${s.files_touched.length - 5} more)` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function handleSession(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args.session_id || '');
  if (!sessionId) return 'Error: session_id is required';

  const session = await getSession(sessionId);
  if (!session) return `Session not found: ${sessionId}`;

  let turns = session.turns;

  // Apply turn range filter
  if (args.turn_range) {
    const range = String(args.turn_range);
    const [start, end] = range.split('-').map(Number);
    if (!isNaN(start)) {
      const endIdx = isNaN(end) ? start : end;
      turns = turns.filter((t: { turn_index: number }) => t.turn_index >= start && t.turn_index <= endIdx);
    }
  }

  const lines: string[] = [];
  lines.push(`# Session ${session.session_id.slice(0, 8)}`);
  lines.push(`Project: ${session.project_name || '?'}`);
  lines.push(`CWD: ${session.cwd || '?'}`);
  lines.push(`Model: ${session.model || '?'}`);
  lines.push(`Time: ${session.started_at ? new Date(session.started_at).toLocaleString() : '?'} → ${session.ended_at ? new Date(session.ended_at).toLocaleString() : '?'}`);
  lines.push(`Turns: ${session.turn_count}`);
  if (session.files_touched?.length) {
    lines.push(`Files: ${session.files_touched.join(', ')}`);
  }
  if (session.summary) {
    lines.push(`Summary: ${session.summary}`);
  }

  // Related sessions
  if (session.related_sessions?.length) {
    lines.push('\n## Related Sessions');
    for (const link of session.related_sessions) {
      const other = link.session_a === session.session_id ? link.session_b : link.session_a;
      lines.push(`- [${link.project_name || '?'}] ${other.slice(0, 8)} — ${link.link_type} (${(link.score * 100).toFixed(0)}%) — ${link.shared_detail || ''}`);
    }
  }

  // Turns
  lines.push('\n## Turns');
  for (const t of turns) {
    lines.push(`\n### Turn ${t.turn_index}`);
    if (t.user_content) lines.push(`**User:** ${truncate(t.user_content, 500)}`);
    if (t.assistant_content) lines.push(`**Assistant:** ${truncate(t.assistant_content, 1000)}`);
    if (t.tool_calls?.length) {
      const toolNames = JSON.parse(t.tool_calls).map((tc: { name: string }) => tc.name);
      if (toolNames.length) lines.push(`**Tools:** ${toolNames.join(', ')}`);
    }
  }

  return lines.join('\n');
}

async function handleIngest(args: Record<string, unknown>): Promise<string> {
  const sessionId = args.session_id as string | undefined;
  const force = args.force as boolean | undefined;

  if (sessionId) {
    const filePath = findFileBySessionId(sessionId);
    if (!filePath) return `Transcript file not found for session: ${sessionId}`;

    const result = await ingestFile(filePath, { force });
    if (result.skipped) return `Session ${sessionId} skipped (no turns).`;
    if (result.error) return `Error: ${result.error}`;
    return `Ingested session ${result.sessionId} (${result.projectName || '?'}) — ${result.turnCount} turns.`;
  }

  // Discover and ingest all
  const files = await discoverFiles({ forceAll: force, minSize: 5120 });
  if (files.length === 0) return 'No new/changed transcript files found.';

  files.sort((a, b) => a.size - b.size);
  const results = await ingestFiles(files);
  const ok = results.filter(r => !r.error && !r.skipped).length;
  const errs = results.filter(r => r.error).length;
  const skipped = results.filter(r => r.skipped).length;

  return `Ingested ${ok} sessions, ${errs} errors, ${skipped} skipped out of ${files.length} files.`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
