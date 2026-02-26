import { execFile } from 'child_process';
import type { TaskProvider, TaskCompletion } from './interface.js';

/**
 * Queries GitHub Issues via the `gh` CLI for task data.
 * Zero npm dependencies — auth handled by `gh auth`.
 */
export class GitHubProvider implements TaskProvider {
  readonly name = 'GitHub Issues';
  private repos: Record<string, string>;
  private blockedLabel: string;

  constructor(config: { repos: Record<string, string>; blocked_label?: string }) {
    this.repos = config.repos;
    this.blockedLabel = config.blocked_label || 'blocked';
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec(['auth', 'status'], 5000);
      return true;
    } catch {
      return false;
    }
  }

  async getCompletedTasks(project: string, date: string): Promise<TaskCompletion[]> {
    const repo = this.repos[project];
    if (!repo) return [];

    const items = await this.ghSearch(`repo:${repo} is:issue is:closed closed:${date}`);
    return items.map((item: { title: string; closed_at?: string }) => ({
      title: item.title,
      completed_at: item.closed_at ? new Date(item.closed_at) : undefined,
      project,
    }));
  }

  async getStartedCount(project: string, date: string): Promise<number> {
    const repo = this.repos[project];
    if (!repo) return 0;

    const items = await this.ghSearch(`repo:${repo} is:issue created:${date}`);
    return items.length;
  }

  async getBlockedCount(project: string): Promise<number> {
    const repo = this.repos[project];
    if (!repo) return 0;

    const items = await this.ghSearch(`repo:${repo} is:issue is:open label:${this.blockedLabel}`);
    return items.length;
  }

  private async ghSearch(query: string): Promise<Array<{ title: string; closed_at?: string }>> {
    try {
      const encoded = query.replace(/ /g, '+');
      const result = await this.exec(
        ['api', `search/issues?q=${encoded}`, '--jq', '.items'],
        15000
      );
      return JSON.parse(result || '[]');
    } catch {
      return [];
    }
  }

  private exec(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('gh', args, { timeout }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
  }
}
