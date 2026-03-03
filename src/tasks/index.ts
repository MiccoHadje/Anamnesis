import type { AnamnesisConfig } from '../util/config.js';
import type { TaskProvider } from './interface.js';
import { NudgeProvider } from './nudge.js';
import { FileSystemProvider } from './filesystem.js';
import { GitHubProvider } from './github.js';
import { TodoistProvider } from './todoist.js';
import { LinearProvider } from './linear.js';

export type { TaskProvider, TaskCompletion } from './interface.js';

/**
 * Create a TaskProvider from config. Returns null if no tasks config
 * or if the provider type is unrecognized.
 */
export function createTaskProvider(config: AnamnesisConfig): TaskProvider | null {
  if (!config.tasks) return null;

  switch (config.tasks.provider) {
    case 'nudge':
      if (!config.tasks.nudge) return null;
      return new NudgeProvider(config.tasks.nudge);
    case 'filesystem':
      if (!config.tasks.filesystem) return null;
      return new FileSystemProvider(config.tasks.filesystem);
    case 'github':
      if (!config.tasks.github) return null;
      return new GitHubProvider(config.tasks.github);
    case 'todoist':
      if (!config.tasks.todoist) return null;
      return new TodoistProvider(config.tasks.todoist);
    case 'linear':
      if (!config.tasks.linear) return null;
      return new LinearProvider(config.tasks.linear);
    default:
      return null;
  }
}
