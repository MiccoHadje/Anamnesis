import { discoverFiles } from '../etl/discovery.js';
import { ingestFile } from '../etl/ingester.js';

export interface TimerState {
  running: boolean;
  lastRun: Date | null;
  lastResult: { ingested: number; skipped: number; errors: number } | null;
  inProgress: boolean;
  intervalMinutes: number;
}

const BATCH_SIZE = 10;
const INITIAL_DELAY_MS = 30_000;

let timerHandle: ReturnType<typeof setInterval> | null = null;
let inProgress = false;
let lastRun: Date | null = null;
let lastResult: TimerState['lastResult'] = null;
let intervalMinutes = 15;

async function tick(): Promise<void> {
  if (inProgress) return;
  inProgress = true;

  try {
    const files = await discoverFiles({ minSize: 1024 });
    if (files.length === 0) {
      lastRun = new Date();
      lastResult = { ingested: 0, skipped: 0, errors: 0 };
      return;
    }

    // Sort by mtime desc — most recently changed first
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const batch = files.slice(0, BATCH_SIZE);

    let ingested = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of batch) {
      try {
        const result = await ingestFile(file.path, {
          onProgress: (msg) => console.log(`[timer] ${msg}`),
        });
        if (result.skipped) skipped++;
        else ingested++;
      } catch (err) {
        errors++;
        console.error(`[timer] Error ingesting ${file.path}: ${err instanceof Error ? err.message : err}`);
      }
    }

    lastRun = new Date();
    lastResult = { ingested, skipped, errors };

    if (ingested > 0) {
      console.log(`[timer] Ingested ${ingested}, skipped ${skipped}, errors ${errors} (${files.length - batch.length} remaining)`);
    }
  } catch (err) {
    console.error(`[timer] Tick error: ${err instanceof Error ? err.message : err}`);
  } finally {
    inProgress = false;
  }
}

export function startTimer(minutes: number): void {
  intervalMinutes = minutes;
  // Initial delay before first run
  setTimeout(() => {
    tick();
    timerHandle = setInterval(tick, minutes * 60_000);
  }, INITIAL_DELAY_MS);
  console.log(`[timer] Periodic ingest every ${minutes}min (first run in ${INITIAL_DELAY_MS / 1000}s)`);
}

export function stopTimer(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

export function getTimerState(): TimerState {
  return {
    running: timerHandle !== null,
    lastRun,
    lastResult,
    inProgress,
    intervalMinutes,
  };
}
