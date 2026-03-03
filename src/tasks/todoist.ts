import type { TaskProvider, TaskCompletion } from './interface.js';

/**
 * Queries Todoist REST + Sync APIs for task data.
 * Uses built-in fetch (Node 18+) — zero npm dependencies.
 */
export class TodoistProvider implements TaskProvider {
  readonly name = 'Todoist';
  private apiToken: string;
  private projects: Record<string, string>;
  private blockedLabel: string;

  constructor(config: { api_token: string; projects: Record<string, string>; blocked_label?: string }) {
    this.apiToken = config.api_token;
    this.projects = config.projects;
    this.blockedLabel = config.blocked_label || 'blocked';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.rest('/rest/v2/projects', 5000);
      return Array.isArray(res);
    } catch {
      return false;
    }
  }

  async getCompletedTasks(project: string, date: string): Promise<TaskCompletion[]> {
    const projectId = this.projects[project];
    if (!projectId) return [];

    try {
      const since = `${date}T00:00:00`;
      const until = `${date}T23:59:59`;
      const params = new URLSearchParams({ since, until, project_id: projectId });
      const data = await this.sync(`/sync/v9/completed/get_all?${params}`, 15000);
      const items = (data?.items || []) as Array<{ content: string; completed_at?: string }>;
      return items.map(item => ({
        title: item.content,
        completed_at: item.completed_at ? new Date(item.completed_at) : undefined,
        project,
      }));
    } catch {
      return [];
    }
  }

  async getStartedCount(project: string, date: string): Promise<number> {
    const projectId = this.projects[project];
    if (!projectId) return 0;

    try {
      const tasks = await this.rest(`/rest/v2/tasks?project_id=${projectId}`, 15000);
      if (!Array.isArray(tasks)) return 0;
      return tasks.filter((t: { created_at?: string }) =>
        t.created_at?.startsWith(date)
      ).length;
    } catch {
      return 0;
    }
  }

  async getBlockedCount(project: string): Promise<number> {
    const projectId = this.projects[project];
    if (!projectId) return 0;

    try {
      const tasks = await this.rest(
        `/rest/v2/tasks?project_id=${projectId}&label=${this.blockedLabel}`,
        15000
      );
      return Array.isArray(tasks) ? tasks.length : 0;
    } catch {
      return 0;
    }
  }

  private async rest(path: string, timeout: number): Promise<unknown> {
    const res = await fetch(`https://api.todoist.com${path}`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Todoist ${res.status}`);
    return res.json();
  }

  private async sync(path: string, timeout: number): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.todoist.com${path}`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Todoist Sync ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }
}
