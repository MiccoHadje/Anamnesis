import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { getConfig } from '../util/config.js';
import { getIngestedFile } from '../db/queries.js';

export interface DiscoveredFile {
  path: string;
  size: number;
  mtime: Date;
  projectDir: string;
  isSubagent: boolean;
}

/**
 * Discover JSONL transcript files that need ingestion.
 * Walks the transcripts root, filters by privacy config, checks idempotency.
 */
export async function discoverFiles(opts?: {
  forceAll?: boolean;
  minSize?: number;
}): Promise<DiscoveredFile[]> {
  const config = getConfig();
  const root = config.transcripts_root;
  const minSize = opts?.minSize ?? 0;
  const files: DiscoveredFile[] = [];

  // Walk project directories
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    console.error(`Cannot read transcripts root: ${root}`);
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir);

    // Skip non-directories (like .md files in the projects folder)
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Privacy: skip excluded projects
    if (config.exclude_projects.includes(projectDir)) continue;

    // Scan for JSONL files (top-level = main sessions)
    await scanDir(projectPath, projectDir, false, files, config, minSize);

    // Scan session subdirectories for subagents
    const entries = readdirSync(projectPath);
    for (const entry of entries) {
      const entryPath = join(projectPath, entry);
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Direct session dirs (UUID directories with subagents/)
      const subagentsPath = join(entryPath, 'subagents');
      try {
        if (statSync(subagentsPath).isDirectory()) {
          await scanDir(subagentsPath, projectDir, true, files, config, minSize);
        }
      } catch {
        // No subagents directory
      }
    }
  }

  if (!opts?.forceAll) {
    // Filter out already-ingested files with matching size/mtime
    const filtered: DiscoveredFile[] = [];
    for (const file of files) {
      const existing = await getIngestedFile(file.path);
      if (!existing) {
        filtered.push(file);
      } else if (
        existing.file_size !== file.size ||
        new Date(existing.file_mtime).getTime() !== file.mtime.getTime()
      ) {
        // File changed — needs re-ingestion
        filtered.push(file);
      }
    }
    return filtered;
  }

  return files;
}

async function scanDir(
  dirPath: string,
  projectDir: string,
  isSubagent: boolean,
  files: DiscoveredFile[],
  config: ReturnType<typeof getConfig>,
  minSize: number
) {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = join(dirPath, entry).replace(/\\/g, '/');
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size < minSize) continue;

      // Privacy: skip excluded sessions
      const sessionId = basename(entry, '.jsonl');
      if (config.exclude_sessions.includes(sessionId)) continue;

      files.push({
        path: filePath,
        size: stat.size,
        mtime: stat.mtime,
        projectDir,
        isSubagent,
      });
    } catch {
      continue;
    }
  }
}

/**
 * Discover a single file by session ID.
 */
export function findFileBySessionId(sessionId: string): string | null {
  const config = getConfig();
  const root = config.transcripts_root;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Check top-level JSONL
    const candidate = join(projectPath, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate.replace(/\\/g, '/');
    } catch {
      // not here
    }

    // Check session subdirs for subagents
    const entries = readdirSync(projectPath);
    for (const entry of entries) {
      const subagentPath = join(projectPath, entry, 'subagents', `${sessionId}.jsonl`);
      try {
        if (statSync(subagentPath).isFile()) return subagentPath.replace(/\\/g, '/');
      } catch {
        continue;
      }
    }
  }

  return null;
}
