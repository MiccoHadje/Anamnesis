import { getStorage } from '../storage/index.js';
import type { SessionSummary } from '../types.js';

export interface DailyReportProject {
  name: string;
  anamnesis_project: string;
}

export interface DailyReportConfig {
  projects: DailyReportProject[];
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function activityLevel(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return 'None';
  if (sessions.length >= 3) return 'Heavy';
  return 'Light';
}

function formatDate(date: string): string {
  const d = new Date(date + 'T12:00:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Generate a daily report for a single project.
 */
export async function generateProjectReport(
  date: string,
  projectName: string,
  anamnesisProject: string
): Promise<string | null> {
  const storage = getStorage();
  const sessions = await storage.getSessionsForDate(date, anamnesisProject);

  if (sessions.length === 0) return null;

  const lines: string[] = [];
  lines.push(`# ${projectName} Daily Report — ${formatDate(date)}`);
  lines.push('');

  // Summary stats
  const totalTurns = sessions.reduce((sum, s) => sum + s.turn_count, 0);
  const totalTime = sessions.reduce((sum, s) => {
    if (s.started_at && s.ended_at) {
      return sum + (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime());
    }
    return sum;
  }, 0);
  lines.push(`**Sessions:** ${sessions.length} | **Turns:** ${totalTurns}${totalTime > 0 ? ` | **Time:** ~${formatDuration(totalTime)}` : ''}`);
  lines.push('');

  // Session details
  lines.push('## Sessions');
  lines.push('');
  for (const s of sessions) {
    const time = new Date(s.started_at).toLocaleTimeString();
    const duration = s.ended_at
      ? formatDuration(new Date(s.ended_at).getTime() - new Date(s.started_at).getTime())
      : '?';
    lines.push(`### [${s.session_id.slice(0, 8)}] ${time} (${duration}, ${s.turn_count} turns)`);
    if (s.summary) lines.push(`**Summary:** ${s.summary}`);
    if (s.tags?.length) lines.push(`**Tags:** ${s.tags.join(', ')}`);
    if (s.files_touched?.length) {
      const shown = s.files_touched.slice(0, 5);
      const extra = s.files_touched.length - shown.length;
      lines.push(`**Files:** ${shown.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
    }
    lines.push('');
  }

  // Collect all tags
  const allTags = new Set<string>();
  for (const s of sessions) {
    for (const t of s.tags || []) allTags.add(t);
  }
  if (allTags.size > 0) {
    lines.push('## Topics');
    lines.push(`${[...allTags].join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a cross-project daily report.
 */
export async function generateCrossProjectReport(
  date: string,
  projects: DailyReportProject[]
): Promise<string> {
  const storage = getStorage();
  const lines: string[] = [];
  lines.push(`# Cross-Project Daily Report — ${formatDate(date)}`);
  lines.push('');

  // Gather data per project
  const projectData: Array<{
    name: string;
    sessions: SessionSummary[];
  }> = [];

  for (const p of projects) {
    const sessions = await storage.getSessionsForDate(date, p.anamnesis_project);
    projectData.push({ name: p.name, sessions });
  }

  // Day at a Glance table
  lines.push('## Day at a Glance');
  lines.push('| Project | Activity | Sessions | Turns | Key Topics |');
  lines.push('|---------|----------|----------|-------|------------|');
  for (const pd of projectData) {
    const activity = activityLevel(pd.sessions);
    const turns = pd.sessions.reduce((s, x) => s + x.turn_count, 0);
    const tags = new Set<string>();
    for (const s of pd.sessions) {
      for (const t of s.tags || []) tags.add(t);
    }
    const topicStr = tags.size > 0 ? [...tags].slice(0, 3).join(', ') : '—';
    lines.push(`| ${pd.name} | ${activity} | ${pd.sessions.length} | ${turns} | ${topicStr} |`);
  }
  lines.push('');

  // Project summaries (only for active projects)
  const active = projectData.filter(p => p.sessions.length > 0);
  if (active.length > 0) {
    lines.push('## Project Summaries');
    lines.push('');
    for (const pd of active) {
      lines.push(`### ${pd.name}`);
      for (const s of pd.sessions) {
        if (s.summary) {
          lines.push(`- ${s.summary}`);
        } else {
          lines.push(`- Session ${s.session_id.slice(0, 8)}: ${s.turn_count} turns`);
        }
      }
      lines.push('');
    }
  }

  // Time allocation
  const totalSessions = projectData.reduce((s, p) => s + p.sessions.length, 0);
  if (totalSessions > 0) {
    lines.push('## Time Allocation');
    for (const pd of projectData) {
      if (pd.sessions.length > 0) {
        const pct = Math.round((pd.sessions.length / totalSessions) * 100);
        lines.push(`- ${pd.name}: ~${pct}% (${pd.sessions.length} session${pd.sessions.length !== 1 ? 's' : ''})`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
