/**
 * Read-only task data for daily report enrichment.
 * Providers fetch completions, started counts, and blocked counts
 * without any task CRUD — that stays in Nudge or whatever manages tasks.
 */

export interface TaskCompletion {
  title: string;
  completed_at?: Date;
  project?: string;
}

export interface TaskProvider {
  /** Human-readable name for reports (e.g., "Nudge", "TODO.md") */
  readonly name: string;

  /** Check if this provider is available (DB reachable, file exists, etc.) */
  isAvailable(): Promise<boolean>;

  /** Tasks completed on the given date for the given project */
  getCompletedTasks(project: string, date: string): Promise<TaskCompletion[]>;

  /** Count of tasks moved to in_progress on the given date */
  getStartedCount(project: string, date: string): Promise<number>;

  /** Count of currently blocked tasks for the project */
  getBlockedCount(project: string): Promise<number>;

  /** Release resources (optional) */
  close?(): Promise<void>;
}
