import { statSync } from 'fs';
import { parseAllMessages } from './parser.js';
import { chunkIntoTurns } from './chunker.js';
import { extractSessionMetadata } from './metadata.js';
import { buildEmbeddingText } from '../util/text.js';
import { linkSession } from './linker.js';
import { embed, embedBatch, averageEmbeddings, ensureOllama } from './embedder.js';
import {
  insertSession,
  insertTurnWithEmbedding,
  deleteSessionData,
  upsertIngestedFile,
} from '../db/queries.js';
import { withTransaction } from '../db/client.js';

export interface IngestResult {
  sessionId: string;
  turnCount: number;
  projectName?: string;
  skipped: boolean;
  error?: string;
}

/**
 * Ingest a single JSONL transcript file:
 *   parse → chunk → embed → store (with embeddings)
 */
export async function ingestFile(
  filePath: string,
  opts?: { force?: boolean; onProgress?: (msg: string) => void }
): Promise<IngestResult> {
  const log = opts?.onProgress || console.log;

  // Fail fast if Ollama isn't available
  await ensureOllama();

  // Collect all messages
  const allMessages = [];
  for await (const msg of parseAllMessages(filePath)) {
    allMessages.push(msg);
  }

  // Filter to user/assistant and chunk
  const relevant = allMessages.filter(m => m.type === 'user' || m.type === 'assistant');
  const turns = chunkIntoTurns(relevant);

  if (turns.length === 0) {
    // Record the file so we don't rediscover it
    const stat = statSync(filePath);
    await upsertIngestedFile(filePath, stat.size, stat.mtime, 'skipped');
    return { sessionId: '', turnCount: 0, skipped: true };
  }

  const meta = extractSessionMetadata(allMessages, turns, filePath);
  log(`  Session: ${meta.sessionId} (${meta.projectName || '?'}) — ${turns.length} turns`);

  // Build embedding texts
  const embTexts = turns.map(t => buildEmbeddingText(t, meta.projectName));

  // Generate embeddings
  log(`  Embedding ${embTexts.length} turns...`);
  const embeddings = await embedBatch(embTexts, 4, (done, total) => {
    if (done % 10 === 0 || done === total) {
      log(`  Embedded ${done}/${total}`);
    }
  });

  // Compute session embedding (average of turn embeddings)
  const sessionEmbedding = averageEmbeddings(embeddings);
  const sessionEmbStr = `[${sessionEmbedding.join(',')}]`;

  // Store everything in a transaction
  await withTransaction(async (client) => {
    // Delete existing data if re-ingesting
    if (opts?.force) {
      await deleteSessionData(meta.sessionId, client);
    }

    await insertSession({
      session_id: meta.sessionId,
      project_name: meta.projectName,
      cwd: meta.cwd,
      git_branch: meta.gitBranch,
      model: meta.model,
      started_at: meta.startedAt,
      ended_at: meta.endedAt,
      turn_count: turns.length,
      files_touched: meta.filesTouched,
      tools_used: meta.toolsUsed,
      is_subagent: meta.isSubagent,
      parent_session_id: meta.parentSessionId,
    }, client);

    // Set session embedding
    await client.query(
      'UPDATE anamnesis_sessions SET session_embedding = $1::vector WHERE session_id = $2',
      [sessionEmbStr, meta.sessionId]
    );

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      await insertTurnWithEmbedding({
        session_id: meta.sessionId,
        turn_index: turn.turnIndex,
        user_content: turn.userContent,
        assistant_content: turn.assistantContent,
        tool_calls: turn.toolCalls,
        files_in_turn: turn.filesInTurn,
        timestamp_start: turn.timestampStart,
        timestamp_end: turn.timestampEnd,
        token_count: turn.tokenCount,
        embedding_text: embTexts[i],
        embedding: embeddings[i],
      }, client);
    }

    // Record ingested file (inside transaction so it rolls back on error)
    const stat = statSync(filePath);
    await upsertIngestedFile(filePath, stat.size, stat.mtime, meta.sessionId, client);
  });

  log(`  Stored ${turns.length} turns with embeddings.`);

  // Auto-link to related sessions
  const links = await linkSession(meta.sessionId);
  if (links.fileLinks || links.semanticLinks) {
    log(`  Linked: ${links.fileLinks} file overlap, ${links.semanticLinks} semantic.`);
  }

  return {
    sessionId: meta.sessionId,
    turnCount: turns.length,
    projectName: meta.projectName,
    skipped: false,
  };
}

/**
 * Ingest multiple files with progress reporting.
 */
export async function ingestFiles(
  files: { path: string }[],
  opts?: { force?: boolean; onProgress?: (msg: string) => void }
): Promise<IngestResult[]> {
  const log = opts?.onProgress || console.log;
  const results: IngestResult[] = [];

  // Fail fast if Ollama isn't available
  await ensureOllama();

  for (let i = 0; i < files.length; i++) {
    log(`[${i + 1}/${files.length}] ${files[i].path}`);
    try {
      const result = await ingestFile(files[i].path, opts);
      results.push(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`  ERROR: ${errMsg}`);
      results.push({
        sessionId: '',
        turnCount: 0,
        skipped: false,
        error: errMsg,
      });
    }
  }

  return results;
}
