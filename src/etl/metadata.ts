import type { RawMessage } from './parser.js';
import type { Turn } from './chunker.js';
import { basename, dirname } from 'path';

export interface SessionMetadata {
  sessionId: string;
  projectName?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  startedAt?: Date;
  endedAt?: Date;
  filesTouched: string[];
  toolsUsed: string[];
  isSubagent: boolean;
  parentSessionId?: string;
}

/**
 * Extract session-level metadata from all raw messages.
 * Scans for first user/assistant message to get sessionId, cwd, branch, etc.
 * Collects files and tools from turns.
 */
export function extractSessionMetadata(
  allMessages: RawMessage[],
  turns: Turn[],
  filePath: string
): SessionMetadata {
  let sessionId = '';
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let startedAt: Date | undefined;
  let endedAt: Date | undefined;

  // Get session info from first relevant message
  for (const msg of allMessages) {
    if (msg.sessionId && !sessionId) {
      sessionId = msg.sessionId;
    }
    if (msg.cwd && !cwd) {
      cwd = msg.cwd;
    }
    if (msg.gitBranch && !gitBranch) {
      gitBranch = msg.gitBranch;
    }
    if (msg.type === 'assistant' && msg.message?.model && !model) {
      model = msg.message.model;
    }
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp);
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
  }

  // Derive project name from the file path's parent directory name
  // e.g., C:/Users/clay/.claude/projects/d--Projects-RPGDash/abc123.jsonl → d--Projects-RPGDash
  const projectDir = basename(dirname(filePath));
  const projectName = projectDir !== 'projects' ? friendlyProjectName(projectDir) : undefined;

  // Check if subagent (file is in a subagents/ directory)
  const isSubagent = filePath.includes('/subagents/') || filePath.includes('\\subagents\\');
  const parentSessionId = isSubagent ? deriveParentSessionId(filePath) : undefined;

  // Collect files and tools from turns
  const filesSet = new Set<string>();
  const toolsSet = new Set<string>();
  for (const turn of turns) {
    for (const f of turn.filesInTurn) filesSet.add(f);
    for (const tc of turn.toolCalls) toolsSet.add(tc.name);
  }

  return {
    sessionId: sessionId || basename(filePath, '.jsonl'),
    projectName,
    cwd,
    gitBranch,
    model,
    startedAt,
    endedAt,
    filesTouched: [...filesSet],
    toolsUsed: [...toolsSet],
    isSubagent,
    parentSessionId,
  };
}

/**
 * Convert directory name to a friendly project name.
 * "d--Projects-RPGDash" → "RPGDash"
 * "D--Projects-Anamnesis" → "Anamnesis"
 * "D--MainVault-Main-Home" → "MainVault-Main-Home"
 */
function friendlyProjectName(dirName: string): string {
  // Strip drive letter prefix: "d--Projects-" or "D--Projects-"
  const match = dirName.match(/^[A-Za-z]--Projects-(.+)$/);
  if (match) return match[1];

  // Strip just drive letter prefix
  const driveMatch = dirName.match(/^[A-Za-z]--(.+)$/);
  if (driveMatch) return driveMatch[1];

  return dirName;
}

/**
 * For subagent files like .../abc123/subagents/agent-xyz.jsonl,
 * derive the parent session ID from the parent directory name.
 */
function deriveParentSessionId(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const subagentIdx = parts.indexOf('subagents');
  if (subagentIdx > 0) {
    return parts[subagentIdx - 1];
  }
  return undefined;
}
