import { getStorage } from '../../storage/index.js';
import { truncate, formatDuration } from '../format.js';

export async function handleSession(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args.session_id || '');
  if (!sessionId) return 'Error: session_id is required';

  const storage = getStorage();
  const session = await storage.getSession(sessionId);
  if (!session) return `Session not found: ${sessionId}`;

  let turns = session.turns;

  // Apply turn range filter
  if (args.turn_range) {
    const range = String(args.turn_range);
    const [start, end] = range.split('-').map(Number);
    if (!isNaN(start)) {
      const endIdx = isNaN(end) ? start : end;
      turns = turns.filter(t => t.turn_index >= start && t.turn_index <= endIdx);
    }
  }

  const lines: string[] = [];
  lines.push(`# Session ${session.session_id.slice(0, 8)}`);
  lines.push(`Project: ${session.project_name || '?'}`);
  lines.push(`CWD: ${session.cwd || '?'}`);
  lines.push(`Model: ${session.model || '?'}`);
  lines.push(`Time: ${session.started_at ? new Date(session.started_at).toLocaleString() : '?'} → ${session.ended_at ? new Date(session.ended_at).toLocaleString() : '?'}`);
  lines.push(`Turns: ${session.turn_count}`);
  if (session.started_at && session.ended_at) {
    lines.push(`Duration: ${formatDuration(new Date(session.ended_at).getTime() - new Date(session.started_at).getTime())}`);
  }
  if (session.is_subagent) lines.push(`Type: subagent`);
  if (session.tags?.length) {
    lines.push(`Tags: ${session.tags.join(', ')}`);
  }
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

  // Turns — paginate if >20 turns and no explicit range
  lines.push('\n## Turns');
  let displayTurns = turns;
  const MAX_AUTO_TURNS = 20;
  if (!args.turn_range && turns.length > MAX_AUTO_TURNS) {
    const firstN = 10;
    const lastN = 5;
    displayTurns = [...turns.slice(0, firstN), null as unknown as typeof turns[0], ...turns.slice(-lastN)];
    lines.push(`*Showing first ${firstN} + last ${lastN} of ${turns.length} turns. Use turn_range for specific turns.*\n`);
  }

  for (const t of displayTurns) {
    if (t === null) {
      const omitted = turns.length - 10 - 5;
      lines.push(`\n*... ${omitted} turns omitted ...*\n`);
      continue;
    }
    const turnTime = t.timestamp_start ? new Date(t.timestamp_start).toLocaleTimeString() : '';
    lines.push(`\n### Turn ${t.turn_index}${turnTime ? ` (${turnTime})` : ''}`);
    if (t.user_content) lines.push(`**User:** ${truncate(t.user_content, 1200)}`);
    if (t.assistant_content) lines.push(`**Assistant:** ${truncate(t.assistant_content, 2500)}`);
    if (t.tool_calls?.length) {
      const parsed = typeof t.tool_calls === 'string' ? JSON.parse(t.tool_calls) : t.tool_calls;
      const toolNames = parsed.map((tc: { name: string }) => tc.name);
      if (toolNames.length) lines.push(`**Tools:** ${toolNames.join(', ')}`);
    }
  }

  return lines.join('\n');
}
