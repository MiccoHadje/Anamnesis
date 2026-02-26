import { embed } from '../../etl/embedder.js';
import { getStorage } from '../../storage/index.js';
import { getConfig } from '../../util/config.js';
import { truncate, formatDuration, formatRelevance } from '../format.js';
import { buildContext } from '../../context/builder.js';

export async function handleSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || '');
  if (!query) return 'Error: query is required';

  const budget = args.budget as number | undefined;

  // When budget is provided, dispatch to smart context builder
  if (budget && budget > 0) {
    const result = await buildContext({
      query,
      budget,
      project: args.project as string | undefined,
      since: args.since as string | undefined,
      hybrid: args.hybrid as boolean | undefined,
    });
    return result.markdown;
  }

  // Original top-N search behavior
  const project = args.project as string | undefined;
  const limit = (args.limit as number) || 5;
  const since = args.since as string | undefined;
  const hybrid = args.hybrid as boolean | undefined;
  const useHybrid = hybrid ?? (getConfig().search_mode === 'hybrid');

  const storage = getStorage();
  const queryEmb = await embed(query);

  const results = useHybrid
    ? await storage.searchHybrid(queryEmb, query, { project, limit, since })
    : await storage.searchByEmbedding(queryEmb, { project, limit, since });

  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [`Found ${results.length} results:\n`];
  for (const r of results) {
    const date = r.started_at ? new Date(r.started_at).toLocaleDateString() : '?';
    const turnDate = r.timestamp_start ? new Date(r.timestamp_start).toLocaleString() : null;
    const sim = useHybrid ? formatRelevance(r.similarity) : `${(r.similarity * 100).toFixed(1)}%`;
    lines.push(`## [${r.session_id.slice(0, 8)}] [${r.project_name || '?'}] turn ${r.turn_index} — ${sim} match — ${date}`);
    if (turnDate) lines.push(`Turn time: ${turnDate}`);
    if (r.user_content) {
      lines.push(`**User:** ${truncate(r.user_content, 500)}`);
    }
    if (r.assistant_content) {
      lines.push(`**Assistant:** ${truncate(r.assistant_content, 800)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function handleRecent(args: Record<string, unknown>): Promise<string> {
  const project = args.project as string | undefined;
  const days = (args.days as number) || 7;
  const file = args.file as string | undefined;
  const limit = (args.limit as number) || 10;

  const storage = getStorage();
  const sessions = await storage.getRecentSessions({ project, days, file, limit });

  if (sessions.length === 0) {
    return `No sessions found in the last ${days} days.`;
  }

  const lines: string[] = [`${sessions.length} recent sessions:\n`];
  for (const s of sessions) {
    const date = new Date(s.started_at!).toLocaleString();
    const tools = (s.tools_used || []).join(', ');
    const subagentLabel = s.is_subagent ? ' (subagent)' : '';
    const duration = s.started_at && s.ended_at ? formatDuration(new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) : null;
    lines.push(`## [${s.session_id.slice(0, 8)}] ${s.project_name || '?'}${subagentLabel} — ${date}${duration ? ` (${duration})` : ''}`);
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
