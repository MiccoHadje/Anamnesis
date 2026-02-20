import { getPool } from '../db/client.js';

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
  const pool = getPool();

  // Get this session's files
  const { rows: [session] } = await pool.query(
    'SELECT files_touched FROM anamnesis_sessions WHERE session_id = $1',
    [sessionId]
  );
  if (!session || !session.files_touched?.length) return 0;

  // Find sessions with overlapping files (using array overlap operator)
  const { rows: overlapping } = await pool.query(
    `SELECT session_id, files_touched
     FROM anamnesis_sessions
     WHERE session_id != $1
       AND files_touched && $2::text[]`,
    [sessionId, session.files_touched]
  );

  let count = 0;
  for (const other of overlapping) {
    const setA = new Set(session.files_touched as string[]);
    const setB = new Set(other.files_touched as string[]);
    const shared = [...setA].filter(f => setB.has(f));
    const union = new Set([...setA, ...setB]);
    const score = shared.length / union.size;

    if (score < 0.05) continue; // Skip trivial overlap

    // Pick one shared file as detail
    const detail = shared[0];

    // Ensure consistent ordering (smaller ID first)
    const [a, b] = sessionId < other.session_id
      ? [sessionId, other.session_id]
      : [other.session_id, sessionId];

    await pool.query(
      `INSERT INTO anamnesis_session_links (session_a, session_b, link_type, score, shared_detail)
       VALUES ($1, $2, 'file_overlap', $3, $4)
       ON CONFLICT (session_a, session_b, link_type) DO UPDATE SET score = $3, shared_detail = $4`,
      [a, b, score, `${shared.length} shared files (e.g., ${detail})`]
    );
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
  const pool = getPool();

  // Get this session's embedding
  const { rows: [session] } = await pool.query(
    'SELECT session_embedding FROM anamnesis_sessions WHERE session_id = $1',
    [sessionId]
  );
  if (!session?.session_embedding) return 0;

  // Find most similar sessions
  const { rows: similar } = await pool.query(
    `SELECT session_id, 1 - (session_embedding <=> $1::vector) AS similarity
     FROM anamnesis_sessions
     WHERE session_id != $2
       AND session_embedding IS NOT NULL
     ORDER BY session_embedding <=> $1::vector
     LIMIT $3`,
    [session.session_embedding, sessionId, topN]
  );

  let count = 0;
  for (const other of similar) {
    if (other.similarity < threshold) continue;

    const [a, b] = sessionId < other.session_id
      ? [sessionId, other.session_id]
      : [other.session_id, sessionId];

    await pool.query(
      `INSERT INTO anamnesis_session_links (session_a, session_b, link_type, score, shared_detail)
       VALUES ($1, $2, 'semantic', $3, $4)
       ON CONFLICT (session_a, session_b, link_type) DO UPDATE SET score = $3`,
      [a, b, other.similarity, `${(other.similarity * 100).toFixed(0)}% similar`]
    );
    count++;
  }

  return count;
}

/**
 * Layer 3: Topic tag linking.
 * Link sessions that share 2+ tags. Score = Jaccard similarity (shared / union).
 */
async function linkByTopic(sessionId: string): Promise<number> {
  const pool = getPool();

  const { rows: [session] } = await pool.query(
    'SELECT tags FROM anamnesis_sessions WHERE session_id = $1',
    [sessionId]
  );
  if (!session?.tags?.length) return 0;

  const myTags = new Set(session.tags as string[]);
  if (myTags.size === 0) return 0;

  // Find sessions with overlapping tags (array overlap operator)
  const { rows: overlapping } = await pool.query(
    `SELECT session_id, tags
     FROM anamnesis_sessions
     WHERE session_id != $1
       AND tags && $2::text[]
       AND array_length(tags, 1) > 0`,
    [sessionId, session.tags]
  );

  let count = 0;
  for (const other of overlapping) {
    const otherTags = new Set(other.tags as string[]);
    const shared = [...myTags].filter(t => otherTags.has(t));
    if (shared.length < 2) continue; // Require at least 2 shared tags

    const union = new Set([...myTags, ...otherTags]);
    const score = shared.length / union.size;

    const [a, b] = sessionId < other.session_id
      ? [sessionId, other.session_id]
      : [other.session_id, sessionId];

    await pool.query(
      `INSERT INTO anamnesis_session_links (session_a, session_b, link_type, score, shared_detail)
       VALUES ($1, $2, 'topic', $3, $4)
       ON CONFLICT (session_a, session_b, link_type) DO UPDATE SET score = $3, shared_detail = $4`,
      [a, b, score, `shared tags: ${shared.join(', ')}`]
    );
    count++;
  }

  return count;
}
