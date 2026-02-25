import { getStorage } from '../storage/index.js';
import type { SessionSummary } from '../types.js';
import type { TaskProvider } from '../tasks/interface.js';
import { formatDuration } from './format.js';

export interface DailyReportProject {
  name: string;
  anamnesis_project: string;
  nudge_project?: string;
}

export interface DailyReportConfig {
  projects: DailyReportProject[];
}

function activityLevel(sessions: SessionSummary[], taskCompletions = 0): string {
  if (sessions.length === 0 && taskCompletions === 0) return 'None';
  if (sessions.length >= 3 || taskCompletions >= 3) return 'Heavy';
  if (sessions.length > 0 || taskCompletions > 0) return 'Light';
  return 'None';
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
  anamnesisProject: string,
  taskProvider?: TaskProvider,
  nudgeProject?: string
): Promise<string | null> {
  const storage = getStorage();
  const sessions = await storage.getSessionsForDate(date, anamnesisProject);

  // Fetch task data if provider available
  const taskData = await getTaskData(taskProvider, nudgeProject || projectName, date);

  if (sessions.length === 0 && !taskData) return null;

  const lines: string[] = [];
  lines.push(`# ${projectName} Daily Report — ${formatDate(date)}`);
  lines.push('');

  // Summary stats
  if (sessions.length > 0) {
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
  }

  // Task flow section
  if (taskData) {
    lines.push(`## Task Flow (${taskData.providerName})`);
    if (taskData.completions.length > 0) {
      const titles = taskData.completions.map(t => t.title).join(', ');
      lines.push(`- **Completed**: ${taskData.completions.length} — ${titles}`);
    }
    if (taskData.startedCount > 0) {
      lines.push(`- **Started**: ${taskData.startedCount}`);
    }
    if (taskData.blockedCount > 0) {
      lines.push(`- **Blocked**: ${taskData.blockedCount}`);
    }
    lines.push('');
  }

  // Collect all tags
  if (sessions.length > 0) {
    const allTags = new Set<string>();
    for (const s of sessions) {
      for (const t of s.tags || []) allTags.add(t);
    }
    if (allTags.size > 0) {
      lines.push('## Topics');
      lines.push(`${[...allTags].join(', ')}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate a cross-project daily report.
 */
export async function generateCrossProjectReport(
  date: string,
  projects: DailyReportProject[],
  taskProvider?: TaskProvider
): Promise<string> {
  const storage = getStorage();
  const lines: string[] = [];
  lines.push(`# Cross-Project Daily Report — ${formatDate(date)}`);
  lines.push('');

  // Gather data per project
  const projectData: Array<{
    name: string;
    sessions: SessionSummary[];
    taskData: TaskFlowData | null;
  }> = [];

  for (const p of projects) {
    const sessions = await storage.getSessionsForDate(date, p.anamnesis_project);
    const taskData = await getTaskData(taskProvider, p.nudge_project || p.name, date);
    projectData.push({ name: p.name, sessions, taskData });
  }

  // Day at a Glance table
  lines.push('## Day at a Glance');
  const hasTaskProvider = projectData.some(pd => pd.taskData);
  if (hasTaskProvider) {
    lines.push('| Project | Activity | Sessions | Turns | Completed | Key Topics |');
    lines.push('|---------|----------|----------|-------|-----------|------------|');
  } else {
    lines.push('| Project | Activity | Sessions | Turns | Key Topics |');
    lines.push('|---------|----------|----------|-------|------------|');
  }
  for (const pd of projectData) {
    const completions = pd.taskData?.completions.length || 0;
    const activity = activityLevel(pd.sessions, completions);
    const turns = pd.sessions.reduce((s, x) => s + x.turn_count, 0);
    const tags = new Set<string>();
    for (const s of pd.sessions) {
      for (const t of s.tags || []) tags.add(t);
    }
    const topicStr = tags.size > 0 ? [...tags].slice(0, 3).join(', ') : '—';
    if (hasTaskProvider) {
      lines.push(`| ${pd.name} | ${activity} | ${pd.sessions.length} | ${turns} | ${completions} | ${topicStr} |`);
    } else {
      lines.push(`| ${pd.name} | ${activity} | ${pd.sessions.length} | ${turns} | ${topicStr} |`);
    }
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

  // Task flow (cross-project aggregate)
  const projectsWithTasks = projectData.filter(pd => pd.taskData);
  if (projectsWithTasks.length > 0) {
    const providerName = projectsWithTasks[0].taskData!.providerName;
    const totalCompleted = projectsWithTasks.reduce((s, pd) => s + (pd.taskData?.completions.length || 0), 0);
    const totalStarted = projectsWithTasks.reduce((s, pd) => s + (pd.taskData?.startedCount || 0), 0);
    const totalBlocked = projectsWithTasks.reduce((s, pd) => s + (pd.taskData?.blockedCount || 0), 0);

    lines.push(`## Task Flow (${providerName})`);
    if (totalCompleted > 0) {
      lines.push(`- **Completed**: ${totalCompleted}`);
      for (const pd of projectsWithTasks) {
        if (pd.taskData && pd.taskData.completions.length > 0) {
          const titles = pd.taskData.completions.map(t => t.title).join(', ');
          lines.push(`  - ${pd.name}: ${titles}`);
        }
      }
    }
    if (totalStarted > 0) lines.push(`- **Started**: ${totalStarted}`);
    if (totalBlocked > 0) lines.push(`- **Blocked**: ${totalBlocked}`);
    lines.push('');
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

// --- Task data helpers ---

interface TaskFlowData {
  providerName: string;
  completions: Array<{ title: string }>;
  startedCount: number;
  blockedCount: number;
}

async function getTaskData(
  provider: TaskProvider | undefined | null,
  project: string,
  date: string
): Promise<TaskFlowData | null> {
  if (!provider) return null;
  try {
    const available = await provider.isAvailable();
    if (!available) return null;

    const completions = await provider.getCompletedTasks(project, date);
    const startedCount = await provider.getStartedCount(project, date);
    const blockedCount = await provider.getBlockedCount(project);

    // Only return data if there's something to report
    if (completions.length === 0 && startedCount === 0 && blockedCount === 0) return null;

    return {
      providerName: provider.name,
      completions,
      startedCount,
      blockedCount,
    };
  } catch {
    // Task data is optional — don't fail the report
    return null;
  }
}
