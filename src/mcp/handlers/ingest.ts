import { ingestFile, ingestFiles } from '../../etl/ingester.js';
import { discoverFiles, findFileBySessionId } from '../../etl/discovery.js';

export async function handleIngest(args: Record<string, unknown>): Promise<string> {
  const sessionId = args.session_id as string | undefined;
  const force = args.force as boolean | undefined;

  if (sessionId) {
    const filePath = findFileBySessionId(sessionId);
    if (!filePath) return `Transcript file not found for session: ${sessionId}`;

    const result = await ingestFile(filePath, { force });
    if (result.skipped) return `Session ${sessionId} skipped (no turns).`;
    if (result.error) return `Error: ${result.error}`;
    return `Ingested session ${result.sessionId} (${result.projectName || '?'}) — ${result.turnCount} turns.`;
  }

  // Discover and ingest all
  const files = await discoverFiles({ forceAll: force, minSize: 5120 });
  if (files.length === 0) return 'No new/changed transcript files found.';

  files.sort((a, b) => a.size - b.size);
  const results = await ingestFiles(files);
  const ok = results.filter(r => !r.error && !r.skipped).length;
  const errs = results.filter(r => r.error).length;
  const skipped = results.filter(r => r.skipped).length;

  return `Ingested ${ok} sessions, ${errs} errors, ${skipped} skipped out of ${files.length} files.`;
}
