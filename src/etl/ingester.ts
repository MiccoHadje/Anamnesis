import { statSync } from 'fs';
import { parseAllMessages } from './parser.js';
import { chunkIntoTurns } from './chunker.js';
import { extractSessionMetadata } from './metadata.js';
import { buildEmbeddingText } from '../util/text.js';
import { linkSession } from './linker.js';
import { extractTopics } from './topics.js';
import { embed, embedBatch, averageEmbeddings, ensureOllama } from './embedder.js';
import { getStorage } from '../storage/index.js';
import type { IngestResult } from '../types.js';

export type { IngestResult };

/**
 * Ingest a single JSONL transcript file:
 *   parse → chunk → embed → store (with embeddings)
 */
export async function ingestFile(
  filePath: string,
  opts?: { force?: boolean; onProgress?: (msg: string) => void }
): Promise<IngestResult> {
  const log = opts?.onProgress || console.log;
  const storage = getStorage();

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
    await storage.upsertIngestedFile(filePath, stat.size, stat.mtime, 'skipped');
    return { sessionId: '', turnCount: 0, skipped: true };
  }

  const meta = extractSessionMetadata(allMessages, turns, filePath);
  log(`  Session: ${meta.sessionId} (${meta.projectName || '?'}) — ${turns.length} turns`);

  // Build embedding texts
  const embTexts = turns.map(t => buildEmbeddingText(t, meta.projectName));

  // Generate embeddings
  log(`  Embedding ${embTexts.length} turns...`);
  const embeddings = await embedBatch(embTexts, undefined, (done, total) => {
    if (done % 10 === 0 || done === total) {
      log(`  Embedded ${done}/${total}`);
    }
  });

  // Compute session embedding (average of turn embeddings)
  const sessionEmbedding = averageEmbeddings(embeddings);

  // Store everything in a transaction
  await storage.transaction(async (tx) => {
    // Delete existing data if re-ingesting
    if (opts?.force) {
      await tx.deleteSessionData(meta.sessionId);
    }

    await tx.insertSession({
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
    });

    // Set session embedding
    await tx.updateSessionEmbedding(meta.sessionId, sessionEmbedding);

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      await tx.insertTurnWithEmbedding({
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
      });
    }

    // Record ingested file (inside transaction so it rolls back on error)
    const stat = statSync(filePath);
    await tx.upsertIngestedFile(filePath, stat.size, stat.mtime, meta.sessionId);
  });

  log(`  Stored ${turns.length} turns with embeddings.`);

  // Auto-link to related sessions
  const links = await linkSession(meta.sessionId);
  if (links.fileLinks || links.semanticLinks || links.topicLinks) {
    log(`  Linked: ${links.fileLinks} file overlap, ${links.semanticLinks} semantic, ${links.topicLinks} topic.`);
  }

  // Extract topics (best-effort, non-blocking)
  try {
    const topics = await extractTopics(meta.sessionId, meta.projectName || null, meta.filesTouched, meta.toolsUsed);
    if (topics) {
      await storage.updateSessionTopics(meta.sessionId, topics.tags, topics.summary);
      log(`  Topics: [${topics.tags.join(', ')}]`);
    }
  } catch (err) {
    // Topic extraction is optional — don't fail ingestion
    log(`  Topic extraction skipped: ${err instanceof Error ? err.message : err}`);
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
