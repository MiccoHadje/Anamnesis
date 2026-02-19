import type pg from 'pg';
import { getPool } from './client.js';

// --- Ingested Files ---

export async function getIngestedFile(filePath: string) {
  const { rows } = await getPool().query(
    'SELECT * FROM anamnesis_ingested_files WHERE file_path = $1',
    [filePath]
  );
  return rows[0] || null;
}

export async function upsertIngestedFile(
  filePath: string,
  fileSize: number,
  fileMtime: Date,
  sessionId: string
) {
  await getPool().query(
    `INSERT INTO anamnesis_ingested_files (file_path, file_size, file_mtime, session_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (file_path) DO UPDATE SET
       file_size = $2, file_mtime = $3, session_id = $4, ingested_at = NOW()`,
    [filePath, fileSize, fileMtime, sessionId]
  );
}

// --- Sessions ---

export async function insertSession(
  session: {
    session_id: string;
    project_name?: string;
    cwd?: string;
    git_branch?: string;
    model?: string;
    started_at?: Date;
    ended_at?: Date;
    turn_count: number;
    files_touched: string[];
    tools_used: string[];
    is_subagent: boolean;
    parent_session_id?: string;
    metadata?: Record<string, unknown>;
  },
  client?: pg.PoolClient
) {
  const q = client || getPool();
  await q.query(
    `INSERT INTO anamnesis_sessions
       (session_id, project_name, cwd, git_branch, model, started_at, ended_at,
        turn_count, files_touched, tools_used, is_subagent, parent_session_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (session_id) DO UPDATE SET
       project_name=$2, cwd=$3, git_branch=$4, model=$5, started_at=$6, ended_at=$7,
       turn_count=$8, files_touched=$9, tools_used=$10, is_subagent=$11,
       parent_session_id=$12, metadata=$13`,
    [
      session.session_id,
      session.project_name || null,
      session.cwd || null,
      session.git_branch || null,
      session.model || null,
      session.started_at || null,
      session.ended_at || null,
      session.turn_count,
      session.files_touched,
      session.tools_used,
      session.is_subagent,
      session.parent_session_id || null,
      JSON.stringify(session.metadata || {}),
    ]
  );
}

export async function deleteSessionData(sessionId: string, client?: pg.PoolClient) {
  const q = client || getPool();
  // Turns and links cascade-delete from session
  await q.query('DELETE FROM anamnesis_sessions WHERE session_id = $1', [sessionId]);
}

// --- Turns ---

export async function insertTurn(
  turn: {
    session_id: string;
    turn_index: number;
    user_content?: string;
    assistant_content?: string;
    tool_calls: unknown[];
    files_in_turn: string[];
    timestamp_start?: Date;
    timestamp_end?: Date;
    token_count?: number;
    embedding_text?: string;
  },
  client?: pg.PoolClient
) {
  const q = client || getPool();
  await q.query(
    `INSERT INTO anamnesis_turns
       (session_id, turn_index, user_content, assistant_content, tool_calls,
        files_in_turn, timestamp_start, timestamp_end, token_count, embedding_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      turn.session_id,
      turn.turn_index,
      turn.user_content || null,
      turn.assistant_content || null,
      JSON.stringify(turn.tool_calls),
      turn.files_in_turn,
      turn.timestamp_start || null,
      turn.timestamp_end || null,
      turn.token_count || null,
      turn.embedding_text || null,
    ]
  );
}

export async function insertTurnWithEmbedding(
  turn: {
    session_id: string;
    turn_index: number;
    user_content?: string;
    assistant_content?: string;
    tool_calls: unknown[];
    files_in_turn: string[];
    timestamp_start?: Date;
    timestamp_end?: Date;
    token_count?: number;
    embedding_text?: string;
    embedding: number[];
  },
  client?: pg.PoolClient
) {
  const q = client || getPool();
  const embeddingStr = `[${turn.embedding.join(',')}]`;
  await q.query(
    `INSERT INTO anamnesis_turns
       (session_id, turn_index, user_content, assistant_content, tool_calls,
        files_in_turn, timestamp_start, timestamp_end, token_count, embedding_text, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,
    [
      turn.session_id,
      turn.turn_index,
      turn.user_content || null,
      turn.assistant_content || null,
      JSON.stringify(turn.tool_calls),
      turn.files_in_turn,
      turn.timestamp_start || null,
      turn.timestamp_end || null,
      turn.token_count || null,
      turn.embedding_text || null,
      embeddingStr,
    ]
  );
}

// --- Search ---

export interface SearchResult {
  session_id: string;
  turn_index: number;
  project_name: string;
  user_content: string;
  assistant_content: string;
  similarity: number;
  timestamp_start: Date;
  started_at: Date;
}

export async function searchByEmbedding(
  embedding: number[],
  opts?: { project?: string; limit?: number; since?: string }
): Promise<SearchResult[]> {
  const embStr = `[${embedding.join(',')}]`;
  const limit = opts?.limit || 5;
  const conditions: string[] = [];
  const params: unknown[] = [embStr, limit];

  if (opts?.project) {
    params.push(opts.project);
    conditions.push(`s.project_name = $${params.length}`);
  }
  if (opts?.since) {
    params.push(opts.since);
    conditions.push(`s.started_at >= $${params.length}::timestamptz`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await getPool().query(
    `SELECT t.session_id, t.turn_index, s.project_name,
            t.user_content, t.assistant_content,
            1 - (t.embedding <=> $1::vector) as similarity,
            t.timestamp_start, s.started_at
     FROM anamnesis_turns t
     JOIN anamnesis_sessions s ON s.session_id = t.session_id
     ${where}
     ORDER BY t.embedding <=> $1::vector
     LIMIT $2`,
    params
  );
  return rows;
}

export async function searchHybrid(
  embedding: number[],
  query: string,
  opts?: { project?: string; limit?: number; since?: string }
): Promise<SearchResult[]> {
  const embStr = `[${embedding.join(',')}]`;
  const limit = opts?.limit || 5;
  const conditions: string[] = [];
  const params: unknown[] = [embStr, query, limit];

  if (opts?.project) {
    params.push(opts.project);
    conditions.push(`s.project_name = $${params.length}`);
  }
  if (opts?.since) {
    params.push(opts.since);
    conditions.push(`s.started_at >= $${params.length}::timestamptz`);
  }

  const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  // Combine vector similarity and full-text relevance with RRF (Reciprocal Rank Fusion)
  const { rows } = await getPool().query(
    `WITH semantic AS (
       SELECT t.id, ROW_NUMBER() OVER (ORDER BY t.embedding <=> $1::vector) AS rank
       FROM anamnesis_turns t
       JOIN anamnesis_sessions s ON s.session_id = t.session_id
       WHERE t.embedding IS NOT NULL ${where}
       LIMIT 50
     ),
     keyword AS (
       SELECT t.id, ROW_NUMBER() OVER (ORDER BY ts_rank(t.tsv, plainto_tsquery('english', $2)) DESC) AS rank
       FROM anamnesis_turns t
       JOIN anamnesis_sessions s ON s.session_id = t.session_id
       WHERE t.tsv @@ plainto_tsquery('english', $2) ${where}
       LIMIT 50
     ),
     combined AS (
       SELECT COALESCE(s.id, k.id) AS id,
              COALESCE(1.0 / (60 + s.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS rrf_score
       FROM semantic s
       FULL OUTER JOIN keyword k ON s.id = k.id
     )
     SELECT t.session_id, t.turn_index, ses.project_name,
            t.user_content, t.assistant_content,
            c.rrf_score AS similarity,
            t.timestamp_start, ses.started_at
     FROM combined c
     JOIN anamnesis_turns t ON t.id = c.id
     JOIN anamnesis_sessions ses ON ses.session_id = t.session_id
     ORDER BY c.rrf_score DESC
     LIMIT $3`,
    params
  );
  return rows;
}

// --- Recent Sessions ---

export async function getRecentSessions(opts?: {
  project?: string;
  days?: number;
  file?: string;
  limit?: number;
}) {
  const days = opts?.days || 7;
  const limit = opts?.limit || 10;
  const conditions = [`started_at >= NOW() - $1::interval`];
  const params: unknown[] = [`${days} days`, limit];

  if (opts?.project) {
    params.push(opts.project);
    conditions.push(`project_name = $${params.length}`);
  }
  if (opts?.file) {
    params.push(opts.file);
    conditions.push(`$${params.length} = ANY(files_touched)`);
  }

  const where = conditions.join(' AND ');

  const { rows } = await getPool().query(
    `SELECT session_id, project_name, cwd, model, started_at, ended_at,
            turn_count, files_touched, tools_used, summary, is_subagent
     FROM anamnesis_sessions
     WHERE ${where}
     ORDER BY started_at DESC
     LIMIT $2`,
    params
  );
  return rows;
}

// --- Session Detail ---

export async function getSession(sessionId: string) {
  // Support partial session ID matching
  const { rows: sessions } = await getPool().query(
    `SELECT * FROM anamnesis_sessions WHERE session_id LIKE $1 || '%' LIMIT 1`,
    [sessionId]
  );
  if (sessions.length === 0) return null;

  const session = sessions[0];

  const { rows: turns } = await getPool().query(
    `SELECT turn_index, user_content, assistant_content, tool_calls,
            files_in_turn, timestamp_start, timestamp_end, token_count
     FROM anamnesis_turns
     WHERE session_id = $1
     ORDER BY turn_index`,
    [session.session_id]
  );

  const { rows: links } = await getPool().query(
    `SELECT l.*, s.project_name, s.started_at, s.summary
     FROM anamnesis_session_links l
     JOIN anamnesis_sessions s ON s.session_id = CASE
       WHEN l.session_a = $1 THEN l.session_b ELSE l.session_a END
     WHERE l.session_a = $1 OR l.session_b = $1
     ORDER BY l.score DESC`,
    [session.session_id]
  );

  return { ...session, turns, related_sessions: links };
}

// --- Stats ---

export async function getStats() {
  const { rows } = await getPool().query(`
    SELECT
      (SELECT count(*) FROM anamnesis_sessions) AS sessions,
      (SELECT count(*) FROM anamnesis_turns) AS turns,
      (SELECT count(*) FROM anamnesis_ingested_files) AS files,
      (SELECT count(*) FROM anamnesis_session_links) AS links
  `);
  return rows[0];
}
