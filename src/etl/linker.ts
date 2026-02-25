import { getStorage } from '../storage/index.js';

/**
 * Run auto-linking for a newly ingested session.
 * Layer 1: File overlap — link sessions that share files_touched entries.
 * Layer 2: Semantic similarity — compare session embeddings.
 * Layer 3: Topic overlap — link sessions sharing 2+ tags (Jaccard similarity).
 */
export async function linkSession(sessionId: string): Promise<{ fileLinks: number; semanticLinks: number; topicLinks: number }> {
  const fileLinks = await linkByFileOverlap(sessionId);
  const semanticLinks = await linkBySemantic(sessionId);
  const topicLinks = await linkByTopic(sessionId);
  return { fileLinks, semanticLinks, topicLinks };
}

/**
 * Layer 1: File overlap linking.
 * Find other sessions that share files_touched with this session.
 * Score = number of shared files / total unique files across both sessions.
 */
async function linkByFileOverlap(sessionId: string): Promise<number> {
  const storage = getStorage();

  const files = await storage.getSessionFiles(sessionId);
  if (files.length === 0) return 0;

  const overlapping = await storage.getSessionsWithOverlappingFiles(sessionId, files);

  let count = 0;
  for (const other of overlapping) {
    const setA = new Set(files);
    const setB = new Set(other.files_touched);
    const shared = [...setA].filter(f => setB.has(f));
    const union = new Set([...setA, ...setB]);
    const score = shared.length / union.size;

    if (score < 0.05) continue; // Skip trivial overlap

    const detail = shared[0];

    // Ensure consistent ordering (smaller ID first)
    const [a, b] = sessionId < other.session_id
      ? [sessionId, other.session_id]
      : [other.session_id, sessionId];

    await storage.upsertSessionLink(a, b, 'file_overlap', score, `${shared.length} shared files (e.g., ${detail})`);
    count++;
  }

  return count;
}

/**
 * Layer 2: Semantic similarity linking.
 * Compare this session's averaged embedding against all other sessions.
 * Link the top N most similar sessions above a threshold.
 */
async function linkBySemantic(sessionId: string, topN = 5, threshold = 0.5): Promise<number> {
  const storage = getStorage();

  const similar = await storage.findSimilarSessions(sessionId, topN);

  let count = 0;
  for (const other of similar) {
    if (other.similarity < threshold) continue;

    const [a, b] = sessionId < other.session_id
      ? [sessionId, other.session_id]
      : [other.session_id, sessionId];

    await storage.upsertSessionLink(a, b, 'semantic', other.similarity, `${(other.similarity * 100).toFixed(0)}% similar`);
    count++;
  }

  return count;
}

/**
 * Layer 3: Topic tag linking.
 * Link sessions that share 2+ tags. Score = Jaccard similarity (shared / union).
 */
async function linkByTopic(sessionId: string): Promise<number> {
  const storage = getStorage();

  const tags = await storage.getSessionTags(sessionId);
  if (tags.length === 0) return 0;

  const myTags = new Set(tags);
  const overlapping = await storage.getSessionsWithOverlappingTags(sessionId, tags);

  let count = 0;
  for (const other of overlapping) {
    const otherTags = new Set(other.tags);
    const shared = [...myTags].filter(t => otherTags.has(t));
    if (shared.length < 2) continue; // Require at least 2 shared tags

    const union = new Set([...myTags, ...otherTags]);
    const score = shared.length / union.size;

    const [a, b] = sessionId < other.session_id
      ? [sessionId, other.session_id]
      : [other.session_id, sessionId];

    await storage.upsertSessionLink(a, b, 'topic', score, `shared tags: ${shared.join(', ')}`);
    count++;
  }

  return count;
}
