import { parseAllMessages } from './etl/parser.js';
import { chunkIntoTurns } from './etl/chunker.js';
import { extractSessionMetadata } from './etl/metadata.js';
import { buildEmbeddingText } from './util/text.js';
import { statSync } from 'fs';
import { getStats, searchByEmbedding, upsertIngestedFile } from './db/queries.js';
import { closePool } from './db/client.js';
import { ingestFile, ingestFiles } from './etl/ingester.js';
import { discoverFiles, findFileBySessionId } from './etl/discovery.js';
import { embed } from './etl/embedder.js';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'ingest-session': {
      // Called by SessionEnd hook. Tries to ingest the most recent session.
      // Hook may pass session ID as arg, or we discover it.
      const sessionId = process.argv[3];
      await ingestSession(sessionId);
      break;
    }
    case 'ingest': {
      const filePath = process.argv[3];
      if (!filePath) { console.error('Usage: anamnesis ingest <file>'); process.exit(1); }
      const force = process.argv.includes('--force');
      await ingestFile(filePath, { force });
      break;
    }
    case 'ingest-all': {
      const forceAll = process.argv.includes('--force');
      await ingestAll(forceAll);
      break;
    }
    case 'backfill': {
      await backfill();
      break;
    }
    case 'search': {
      const query = process.argv.slice(3).join(' ');
      if (!query) { console.error('Usage: anamnesis search <query>'); process.exit(1); }
      await searchCli(query);
      break;
    }
    case 'stats': {
      const stats = await getStats();
      console.log('Anamnesis stats:');
      console.log(`  Sessions: ${stats.sessions}`);
      console.log(`  Turns:    ${stats.turns}`);
      console.log(`  Files:    ${stats.files}`);
      console.log(`  Links:    ${stats.links}`);
      break;
    }
    default:
      console.log('Anamnesis - Persistent semantic memory for Claude Code');
      console.log('');
      console.log('Commands:');
      console.log('  ingest-session [id]   Ingest a session (for hooks)');
      console.log('  ingest <file>         Ingest a single JSONL file');
      console.log('  ingest-all            Discover and ingest new transcripts');
      console.log('  backfill              Full backfill of all transcripts');
      console.log('  search <query>        Semantic search across turns');
      console.log('  stats                 Show database statistics');
      break;
  }

  await closePool();
}

async function ingestSession(sessionId?: string) {
  if (sessionId) {
    const filePath = findFileBySessionId(sessionId);
    if (!filePath) {
      console.error(`Transcript not found for session: ${sessionId}`);
      // Not an error — the JSONL may not be flushed yet. Scheduled task will catch it.
      process.exit(0);
    }
    try {
      const result = await ingestFile(filePath);
      console.log(`Ingested ${result.sessionId} (${result.turnCount} turns)`);
    } catch (err) {
      console.error(`Failed to ingest: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  // No session ID — discover and ingest any new files
  const files = await discoverFiles({ minSize: 1024 });
  if (files.length === 0) {
    console.log('No new sessions to ingest.');
    return;
  }
  // Ingest only the most recent file (most likely the just-ended session)
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  try {
    const result = await ingestFile(files[0].path);
    console.log(`Ingested ${result.sessionId} (${result.turnCount} turns)`);
  } catch (err) {
    console.error(`Failed to ingest: ${err instanceof Error ? err.message : err}`);
  }
}

async function ingestAll(forceAll: boolean) {
  console.log('Discovering new/changed transcript files...');
  const files = await discoverFiles({ forceAll, minSize: 5120 });
  console.log(`Found ${files.length} files to ingest.`);
  if (files.length === 0) return;

  files.sort((a, b) => a.size - b.size);
  const results = await ingestFiles(files);
  const ok = results.filter(r => !r.error && !r.skipped).length;
  const errs = results.filter(r => r.error).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`\nDone: ${ok} ingested, ${errs} errors, ${skipped} skipped.`);
}

async function backfill() {
  console.log('Full backfill — discovering ALL transcript files...');
  const files = await discoverFiles({ forceAll: false, minSize: 1024 });
  console.log(`Found ${files.length} files to process.`);
  if (files.length === 0) {
    console.log('All files already ingested.');
    return;
  }

  // Sort smallest first for quick progress
  files.sort((a, b) => a.size - b.size);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

  let processedSize = 0;
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pct = ((processedSize / totalSize) * 100).toFixed(1);
    console.log(`\n[${i + 1}/${files.length}] (${pct}%) ${file.path}`);
    try {
      const result = await ingestFile(file.path);
      if (!result.skipped) successCount++;
    } catch (err) {
      errorCount++;
      console.error(`  ERROR: ${err instanceof Error ? err.message : err}`);
      // Record errored file so it doesn't get rediscovered every run
      try {
        const stat = statSync(file.path);
        await upsertIngestedFile(file.path, stat.size, stat.mtime, 'error');
      } catch { /* ignore */ }
    }
    processedSize += file.size;
  }

  console.log(`\nBackfill complete: ${successCount} ingested, ${errorCount} errors.`);
  const stats = await getStats();
  console.log(`DB totals: ${stats.sessions} sessions, ${stats.turns} turns, ${stats.links} links`);
}

async function searchCli(query: string) {
  console.log(`Searching: "${query}"`);
  const queryEmb = await embed(query);
  const results = await searchByEmbedding(queryEmb, { limit: 5 });

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of results) {
    console.log(`\n--- [${r.project_name || '?'}] ${r.session_id.slice(0, 8)} turn ${r.turn_index} (${(r.similarity * 100).toFixed(1)}%) ---`);
    console.log(`  Date: ${r.started_at ? new Date(r.started_at).toLocaleDateString() : '?'}`);
    if (r.user_content) {
      console.log(`  User: ${r.user_content.slice(0, 150)}${r.user_content.length > 150 ? '...' : ''}`);
    }
    if (r.assistant_content) {
      console.log(`  Assistant: ${r.assistant_content.slice(0, 150)}${r.assistant_content.length > 150 ? '...' : ''}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
