import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { TaskProvider, TaskCompletion } from './interface.js';

/**
 * Reads task data from a local file (markdown or JSON).
 *
 * Markdown format:
 *   # 2026-02-25
 *   - [x] Fix the login bug
 *   - [x] Deploy v2.1
 *   - [ ] Write migration docs
 *   - [blocked] Waiting on API access
 *
 * JSON format:
 *   {
 *     "2026-02-25": {
 *       "completed": ["Fix the login bug", "Deploy v2.1"],
 *       "started": ["Write migration docs"],
 *       "blocked": ["Waiting on API access"]
 *     }
 *   }
 */
export class FileSystemProvider implements TaskProvider {
  readonly name: string;
  private filePath: string;

  constructor(config: { path: string; name?: string }) {
    this.filePath = resolvePath(config.path);
    this.name = config.name || 'TODO';
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.filePath);
  }

  async getCompletedTasks(_project: string, date: string): Promise<TaskCompletion[]> {
    const data = this.readDateBlock(date);
    if (!data) return [];
    return data.completed.map(title => ({ title }));
  }

  async getStartedCount(_project: string, date: string): Promise<number> {
    const data = this.readDateBlock(date);
    return data?.started.length || 0;
  }

  async getBlockedCount(_project: string): Promise<number> {
    // For filesystem, blocked count comes from the most recent date block
    const content = this.readFile();
    if (!content) return 0;

    if (this.filePath.endsWith('.json')) {
      const parsed = JSON.parse(content) as Record<string, JsonDateBlock>;
      const dates = Object.keys(parsed).sort().reverse();
      if (dates.length === 0) return 0;
      return parsed[dates[0]]?.blocked?.length || 0;
    }

    // Markdown: find the last date header's blocked items
    const blocks = parseMarkdown(content);
    const dates = Object.keys(blocks).sort().reverse();
    if (dates.length === 0) return 0;
    return blocks[dates[0]].blocked.length;
  }

  private readDateBlock(date: string): DateBlock | null {
    const content = this.readFile();
    if (!content) return null;

    if (this.filePath.endsWith('.json')) {
      return this.parseJsonDate(content, date);
    }
    return this.parseMarkdownDate(content, date);
  }

  private readFile(): string | null {
    try {
      return readFileSync(this.filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private parseJsonDate(content: string, date: string): DateBlock | null {
    try {
      const parsed = JSON.parse(content) as Record<string, JsonDateBlock>;
      const block = parsed[date];
      if (!block) return null;
      return {
        completed: block.completed || [],
        started: block.started || [],
        blocked: block.blocked || [],
      };
    } catch {
      return null;
    }
  }

  private parseMarkdownDate(content: string, date: string): DateBlock | null {
    const blocks = parseMarkdown(content);
    return blocks[date] || null;
  }
}

interface DateBlock {
  completed: string[];
  started: string[];
  blocked: string[];
}

interface JsonDateBlock {
  completed?: string[];
  started?: string[];
  blocked?: string[];
}

/** Parse markdown into date-keyed blocks. */
function parseMarkdown(content: string): Record<string, DateBlock> {
  const blocks: Record<string, DateBlock> = {};
  let currentDate: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Date header: # 2026-02-25
    const dateMatch = trimmed.match(/^#+\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      blocks[currentDate] = { completed: [], started: [], blocked: [] };
      continue;
    }

    if (!currentDate) continue;
    const block = blocks[currentDate];

    // Completed: - [x] Title
    const completedMatch = trimmed.match(/^-\s+\[x\]\s+(.+)/i);
    if (completedMatch) {
      block.completed.push(completedMatch[1]);
      continue;
    }

    // Blocked: - [blocked] Title
    const blockedMatch = trimmed.match(/^-\s+\[blocked\]\s+(.+)/i);
    if (blockedMatch) {
      block.blocked.push(blockedMatch[1]);
      continue;
    }

    // Open (started): - [ ] Title
    const openMatch = trimmed.match(/^-\s+\[\s*\]\s+(.+)/);
    if (openMatch) {
      block.started.push(openMatch[1]);
      continue;
    }
  }

  return blocks;
}

/** Resolve ~ and relative paths. */
function resolvePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}
