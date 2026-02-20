import { getConfig } from '../util/config.js';
import {
  getSessionsWithoutTopics,
  getFirstUserMessage,
  updateSessionTopics,
} from '../db/queries.js';

interface TopicResult {
  tags: string[];
  summary: string;
}

/**
 * Extract topic tags and a summary for a session using Ollama.
 */
export async function extractTopics(
  sessionId: string,
  projectName: string | null,
  filesTouched: string[],
  toolsUsed: string[]
): Promise<TopicResult | null> {
  const config = getConfig();
  const firstMessage = await getFirstUserMessage(sessionId);
  if (!firstMessage) return null;

  // Build context for the LLM
  const contextParts: string[] = [];
  if (projectName) contextParts.push(`Project: ${projectName}`);
  if (filesTouched?.length) {
    contextParts.push(`Files: ${filesTouched.slice(0, 20).join(', ')}`);
  }
  if (toolsUsed?.length) {
    contextParts.push(`Tools: ${toolsUsed.join(', ')}`);
  }
  contextParts.push(`First user message: ${firstMessage.slice(0, 2000)}`);

  const prompt = `Extract 3-5 topic tags and a 1-sentence summary for this Claude Code session.
Tags should be specific (e.g., "drizzle-orm migration", "MCP server setup", not "coding" or "development").
Return ONLY valid JSON: {"tags": ["tag1", "tag2"], "summary": "One sentence summary."}

Session context:
${contextParts.join('\n')}`;

  try {
    const response = await fetch(`${config.topic_model.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.topic_model.model,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 256 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { response: string };
    const parsed = parseJsonResponse(data.response);
    if (!parsed) return null;

    // Validate
    if (!Array.isArray(parsed.tags) || typeof parsed.summary !== 'string') return null;
    const tags = parsed.tags.filter((t: unknown) => typeof t === 'string' && t.length > 0).slice(0, 8);
    const summary = parsed.summary.slice(0, 500);

    return { tags, summary };
  } catch (err) {
    console.error(`  Topic extraction failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Parse JSON from LLM response, handling markdown code blocks.
 */
function parseJsonResponse(text: string): TopicResult | null {
  // Strip markdown code blocks if present
  let cleaned = text.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Backfill topics for all sessions that don't have them.
 * Processes in batches with concurrency control.
 */
export async function backfillTopics(
  opts?: { batchSize?: number; concurrency?: number; onProgress?: (done: number, total: number, sessionId: string, project: string, tagCount: number) => void }
): Promise<{ processed: number; failed: number; skipped: number }> {
  const batchSize = opts?.batchSize || 10;
  const concurrency = opts?.concurrency || 2;
  const log = opts?.onProgress;

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let totalProcessed = 0;

  // Process in batches
  while (true) {
    const sessions = await getSessionsWithoutTopics(batchSize);
    if (sessions.length === 0) break;

    // Process with concurrency
    for (let i = 0; i < sessions.length; i += concurrency) {
      const batch = sessions.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (s) => {
          const result = await extractTopics(s.session_id, s.project_name, s.files_touched, s.tools_used);
          if (!result) {
            // Mark as processed with empty summary so it won't be re-fetched
            await updateSessionTopics(s.session_id, ['_no_content'], '');
            skipped++;
            return;
          }
          await updateSessionTopics(s.session_id, result.tags, result.summary);
          processed++;
          totalProcessed++;
          log?.(totalProcessed, -1, s.session_id, s.project_name || '?', result.tags.length);
        })
      );

      for (const r of results) {
        if (r.status === 'rejected') {
          failed++;
          console.error(`  Topic extraction error: ${r.reason}`);
        }
      }
    }
  }

  return { processed, failed, skipped };
}
