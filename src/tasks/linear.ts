import type { TaskProvider, TaskCompletion } from './interface.js';

/**
 * Queries Linear's GraphQL API for task data.
 * Uses built-in fetch (Node 18+) — zero npm dependencies.
 */
export class LinearProvider implements TaskProvider {
  readonly name = 'Linear';
  private apiKey: string;
  private teams: Record<string, string>;
  private blockedLabel: string;

  constructor(config: { api_key: string; teams: Record<string, string>; blocked_label?: string }) {
    this.apiKey = config.api_key;
    this.teams = config.teams;
    this.blockedLabel = config.blocked_label || 'blocked';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const data = await this.graphql('{ viewer { id } }', {}, 5000);
      return !!data?.viewer?.id;
    } catch {
      return false;
    }
  }

  async getCompletedTasks(project: string, date: string): Promise<TaskCompletion[]> {
    const teamKey = this.teams[project];
    if (!teamKey) return [];

    try {
      const gte = `${date}T00:00:00.000Z`;
      const lt = this.nextDay(date);
      const query = `
        query($teamKey: String!, $gte: DateTime!, $lt: DateTime!) {
          issues(filter: {
            team: { key: { eq: $teamKey } }
            completedAt: { gte: $gte, lt: $lt }
          }) {
            nodes { title completedAt }
          }
        }
      `;
      const data = await this.graphql(query, { teamKey, gte, lt }, 15000);
      const nodes: Array<{ title: string; completedAt?: string }> = data?.issues?.nodes || [];
      return nodes.map(n => ({
        title: n.title,
        completed_at: n.completedAt ? new Date(n.completedAt) : undefined,
        project,
      }));
    } catch {
      return [];
    }
  }

  async getStartedCount(project: string, date: string): Promise<number> {
    const teamKey = this.teams[project];
    if (!teamKey) return 0;

    try {
      const gte = `${date}T00:00:00.000Z`;
      const lt = this.nextDay(date);
      const query = `
        query($teamKey: String!, $gte: DateTime!, $lt: DateTime!) {
          issues(filter: {
            team: { key: { eq: $teamKey } }
            startedAt: { gte: $gte, lt: $lt }
          }) {
            nodes { id }
          }
        }
      `;
      const data = await this.graphql(query, { teamKey, gte, lt }, 15000);
      return data?.issues?.nodes?.length || 0;
    } catch {
      return 0;
    }
  }

  async getBlockedCount(project: string): Promise<number> {
    const teamKey = this.teams[project];
    if (!teamKey) return 0;

    try {
      const query = `
        query($teamKey: String!, $label: String!) {
          issues(filter: {
            team: { key: { eq: $teamKey } }
            labels: { name: { eq: $label } }
            completedAt: { null: true }
          }) {
            nodes { id }
          }
        }
      `;
      const data = await this.graphql(query, { teamKey, label: this.blockedLabel }, 15000);
      return data?.issues?.nodes?.length || 0;
    } catch {
      return 0;
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async graphql(query: string, variables: Record<string, unknown>, timeout: number): Promise<any> {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Linear ${res.status}`);
    const json = await res.json() as { data?: any; errors?: unknown[] };
    if (json.errors?.length) throw new Error(`Linear GraphQL error`);
    return json.data;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private nextDay(date: string): string {
    const d = new Date(date + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
}
