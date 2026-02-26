/**
 * Phase 1: Gather — search, deduplicate by session, diversity re-rank, link traversal.
 */

import type { SearchResult, SessionLink } from '../types.js';
import type { ContextItem, LinkedSessionHint } from './types.js';
import { estimateTokens, COST_FULL_USER_CHARS, COST_FULL_ASSISTANT_CHARS, COST_SUMMARY_CHARS, COST_TITLE_CHARS } from './types.js';
import type { StorageBackend } from '../storage/interface.js';

/** Group search hits by session, keeping the best-scoring turn as primary. */
interface SessionGroup {
  sessionId: string;
  projectName: string;
  bestTurn: SearchResult;
  relatedTurns: { turnIndex: number; similarity: number }[];
  bestSimilarity: number;
}

function deduplicateBySession(results: SearchResult[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const r of results) {
    const existing = groups.get(r.session_id);
    if (!existing) {
      groups.set(r.session_id, {
        sessionId: r.session_id,
        projectName: r.project_name,
        bestTurn: r,
        relatedTurns: [],
        bestSimilarity: r.similarity,
      });
    } else if (r.similarity > existing.bestSimilarity) {
      // Demote current best to related
      existing.relatedTurns.push({
        turnIndex: existing.bestTurn.turn_index,
        similarity: existing.bestSimilarity,
      });
      existing.bestTurn = r;
      existing.bestSimilarity = r.similarity;
    } else {
      existing.relatedTurns.push({
        turnIndex: r.turn_index,
        similarity: r.similarity,
      });
    }
  }

  return Array.from(groups.values());
}

/**
 * MMR-style diversity re-ranking.
 * Penalizes candidates from the same session (1.0) or same project (0.3).
 */
function diversityRerank(groups: SessionGroup[], maxItems: number): SessionGroup[] {
  if (groups.length <= 1) return groups;

  const remaining = [...groups];
  const selected: SessionGroup[] = [];

  // Always pick the best hit first
  remaining.sort((a, b) => b.bestSimilarity - a.bestSimilarity);
  selected.push(remaining.shift()!);

  while (selected.length < maxItems && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      let penalty = 0;

      for (const s of selected) {
        if (s.sessionId === candidate.sessionId) {
          penalty = Math.max(penalty, 1.0);
        } else if (s.projectName === candidate.projectName) {
          penalty = Math.max(penalty, 0.3);
        }
      }

      const diverseScore = candidate.bestSimilarity * (1 - penalty);
      if (diverseScore > bestScore) {
        bestScore = diverseScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

/** Resolve a link to the "other" session ID relative to the source sessions. */
function resolveLinkedSessionId(link: SessionLink, sourceSessionIds: Set<string>): string | null {
  if (sourceSessionIds.has(link.session_a) && !sourceSessionIds.has(link.session_b)) {
    return link.session_b;
  }
  if (sourceSessionIds.has(link.session_b) && !sourceSessionIds.has(link.session_a)) {
    return link.session_a;
  }
  return null; // Both sides are already in results
}

function computeCosts(userContent: string | null, assistantContent: string | null, summary: string | null): {
  costFull: number;
  costSummary: number;
  costTitle: number;
} {
  const userTrunc = userContent ? userContent.slice(0, COST_FULL_USER_CHARS) : '';
  const assistTrunc = assistantContent ? assistantContent.slice(0, COST_FULL_ASSISTANT_CHARS) : '';
  const fullText = userTrunc + assistTrunc;
  const summaryText = summary || (userContent ? userContent.slice(0, COST_SUMMARY_CHARS) : '');

  return {
    costFull: estimateTokens(fullText) + 30,     // +30 for headers/metadata
    costSummary: estimateTokens(summaryText) + 15,
    costTitle: 20,
  };
}

export interface GatherOpts {
  query: string;
  embedding: number[];
  storage: StorageBackend;
  project?: string;
  since?: string;
  hybrid?: boolean;
  maxLinkDepth?: number;
}

/**
 * Gather phase: search → dedup → diversity re-rank → link traversal.
 * Returns ranked ContextItems ready for budget allocation.
 */
export async function gather(opts: GatherOpts): Promise<ContextItem[]> {
  const { embedding, storage, project, since, hybrid, maxLinkDepth = 1 } = opts;

  // Step 1: Overfetch search results for budget selection
  const searchOpts = { project, since, limit: 20, minSimilarity: 0.3 };
  const results = hybrid
    ? await storage.searchHybrid(embedding, opts.query, searchOpts)
    : await storage.searchByEmbedding(embedding, searchOpts);

  if (results.length === 0) return [];

  // Step 2: Deduplicate by session
  const groups = deduplicateBySession(results);

  // Step 3: Diversity re-rank (keep up to 15 for link expansion)
  const ranked = diversityRerank(groups, 15);

  // Step 4: Bounded link traversal for top 3 sessions
  const topSessionIds = ranked.slice(0, 3).map(g => g.sessionId);
  const allSessionIds = new Set(ranked.map(g => g.sessionId));
  const linkHintsBySession = new Map<string, LinkedSessionHint[]>();

  let linkSourcedItems: ContextItem[] = [];

  if (maxLinkDepth >= 1 && topSessionIds.length > 0) {
    const links = await storage.getLinksForSessions(topSessionIds);

    // Group links by their target (non-source) session
    const linkedSessionIds = new Set<string>();
    const linksByTarget = new Map<string, SessionLink[]>();

    for (const link of links) {
      const targetId = resolveLinkedSessionId(link, allSessionIds);
      if (!targetId) continue;

      linkedSessionIds.add(targetId);
      const existing = linksByTarget.get(targetId) || [];
      existing.push(link);
      linksByTarget.set(targetId, existing);

      // Also build link hints for the source sessions
      for (const sourceId of topSessionIds) {
        if (link.session_a === sourceId || link.session_b === sourceId) {
          const hints = linkHintsBySession.get(sourceId) || [];
          hints.push({
            sessionId: targetId,
            projectName: link.project_name || '?',
            linkType: link.link_type,
            score: link.score,
            detail: link.shared_detail,
          });
          linkHintsBySession.set(sourceId, hints);
        }
      }
    }

    // Fetch metadata for linked sessions (max 10)
    const linkedIds = Array.from(linkedSessionIds).slice(0, 10);
    if (linkedIds.length > 0) {
      const metas = await storage.getSessionMetaBatch(linkedIds);
      const metaMap = new Map(metas.map(m => [m.session_id, m]));

      for (const [targetId, targetLinks] of linksByTarget) {
        if (!metaMap.has(targetId)) continue;
        const meta = metaMap.get(targetId)!;
        const bestLink = targetLinks.reduce((a, b) => a.score > b.score ? a : b);

        const costs = computeCosts(null, null, meta.summary);
        linkSourcedItems.push({
          sessionId: targetId,
          turnIndex: null,
          projectName: meta.project_name || '?',
          similarity: bestLink.score * 0.5, // Discount link-sourced items
          source: 'link',
          linkType: bestLink.link_type,
          userContent: null,
          assistantContent: null,
          sessionSummary: meta.summary,
          sessionTags: meta.tags || [],
          startedAt: meta.started_at,
          costFull: costs.costFull,
          costSummary: costs.costSummary,
          costTitle: costs.costTitle,
          relatedTurns: [],
          linkedSessions: [],
        });
      }
    }
  }

  // Build ContextItems from search groups
  const searchItems: ContextItem[] = ranked.map(group => {
    const turn = group.bestTurn;
    const costs = computeCosts(turn.user_content, turn.assistant_content, null);
    const linkedHints = linkHintsBySession.get(group.sessionId) || [];

    return {
      sessionId: group.sessionId,
      turnIndex: turn.turn_index,
      projectName: group.projectName,
      similarity: group.bestSimilarity,
      source: 'search' as const,
      userContent: turn.user_content,
      assistantContent: turn.assistant_content,
      sessionSummary: null,
      sessionTags: [],
      startedAt: turn.started_at,
      costFull: costs.costFull,
      costSummary: costs.costSummary,
      costTitle: costs.costTitle,
      relatedTurns: group.relatedTurns,
      linkedSessions: linkedHints,
    };
  });

  // Fetch session metadata for search items (summaries, tags)
  const searchSessionIds = searchItems.map(i => i.sessionId);
  if (searchSessionIds.length > 0) {
    const metas = await storage.getSessionMetaBatch(searchSessionIds);
    const metaMap = new Map(metas.map(m => [m.session_id, m]));
    for (const item of searchItems) {
      const meta = metaMap.get(item.sessionId);
      if (meta) {
        item.sessionSummary = meta.summary;
        item.sessionTags = meta.tags || [];
      }
    }
  }

  // Merge: search items first (already diversity-ranked), then link-sourced
  return [...searchItems, ...linkSourcedItems];
}
