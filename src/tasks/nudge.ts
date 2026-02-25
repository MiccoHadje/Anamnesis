import pg from 'pg';
import type { TaskProvider, TaskCompletion } from './interface.js';

const { Pool } = pg;

/**
 * Queries the Nudge PostgreSQL database directly for task data.
 * No MCP dependency — direct DB access via pg.
 *
 * Nudge schema notes:
 * - nudge_projects.name stores bare names (no @ prefix)
 * - nudge_tasks.blocked_by is UUID[] (empty = '{}')
 * - Status values: icebox, backlog, in_progress, done, cancelled
 */
export class NudgeProvider implements TaskProvider {
  readonly name = 'Nudge';
  private pool: pg.Pool;

  constructor(config: { host: string; port: number; database: string; user: string; password?: string }) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      ...(config.password ? { password: config.password } : {}),
      max: 3,
      connectionTimeoutMillis: 5000,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async getCompletedTasks(project: string, date: string): Promise<TaskCompletion[]> {
    const name = stripAtPrefix(project);
    const { rows } = await this.pool.query(
      `SELECT t.title, t.completed_at
       FROM nudge_tasks t
       JOIN nudge_projects p ON t.project_id = p.id
       WHERE p.name = $1
         AND t.status = 'done'
         AND t.completed_at >= $2::date
         AND t.completed_at < ($2::date + INTERVAL '1 day')
       ORDER BY t.completed_at`,
      [name, date]
    );
    return rows.map(r => ({
      title: r.title,
      completed_at: r.completed_at,
      project: name,
    }));
  }

  async getStartedCount(project: string, date: string): Promise<number> {
    const name = stripAtPrefix(project);
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS count
       FROM nudge_tasks t
       JOIN nudge_projects p ON t.project_id = p.id
       WHERE p.name = $1
         AND t.status = 'in_progress'
         AND t.updated_at >= $2::date
         AND t.updated_at < ($2::date + INTERVAL '1 day')`,
      [name, date]
    );
    return rows[0]?.count || 0;
  }

  async getBlockedCount(project: string): Promise<number> {
    const name = stripAtPrefix(project);
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS count
       FROM nudge_tasks t
       JOIN nudge_projects p ON t.project_id = p.id
       WHERE p.name = $1
         AND t.blocked_by IS NOT NULL AND t.blocked_by != '{}'
         AND t.status NOT IN ('done', 'cancelled')`,
      [name]
    );
    return rows[0]?.count || 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Strip leading @ from project name if present (Nudge DB stores bare names). */
function stripAtPrefix(name: string): string {
  return name.startsWith('@') ? name.slice(1) : name;
}
