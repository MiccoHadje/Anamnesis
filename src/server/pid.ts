import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Write the current process PID to a file. */
export function writePid(pidFile: string): void {
  const dir = dirname(pidFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(pidFile, String(process.pid), 'utf-8');
}

/** Read PID from a file. Returns null if file doesn't exist or is empty. */
export function readPid(pidFile: string): number | null {
  try {
    const content = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Check if a process with the given PID is running. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove the PID file. */
export function removePid(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore
  }
}
