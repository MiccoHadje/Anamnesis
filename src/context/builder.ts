/**
 * Smart context builder — orchestrates gather → allocate → render.
 */

import type { ContextRequest, ContextResult } from './types.js';
import { gather } from './gather.js';
import { allocate } from './allocate.js';
import { render } from './render.js';
import { embed } from '../etl/embedder.js';
import { getStorage } from '../storage/index.js';
import { getConfig } from '../util/config.js';

/**
 * Build token-budget-aware context from Anamnesis session data.
 * Leverages the link graph and deduplication for richer results than top-N search.
 */
export async function buildContext(request: ContextRequest): Promise<ContextResult> {
  const storage = getStorage();
  const useHybrid = request.hybrid ?? (getConfig().search_mode === 'hybrid');

  // Embed the query
  const queryEmbedding = await embed(request.query);

  // Phase 1: Gather
  const items = await gather({
    query: request.query,
    embedding: queryEmbedding,
    storage,
    project: request.project,
    since: request.since,
    hybrid: useHybrid,
    maxLinkDepth: Math.min(request.maxLinkDepth ?? 1, 2),
  });

  if (items.length === 0) {
    return { markdown: 'No relevant context found.', tokenEstimate: 5, sessionIds: [], truncated: false };
  }

  // Phase 2: Allocate
  const allocated = allocate(items, request.budget);

  if (allocated.length === 0) {
    return { markdown: 'No results fit within the token budget.', tokenEstimate: 8, sessionIds: [], truncated: true };
  }

  // Phase 3: Render
  return render(allocated, request.budget);
}
