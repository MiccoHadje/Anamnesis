import pg from 'pg';
import type { StorageBackend, Transaction } from './interface.js';
import type {
  SessionDetail,
  RecentSession,
  SessionSummary,
  SessionWithoutTopics,
  SessionInsert,
  TurnInsert,
  SearchResult,
  SearchOpts,
  Stats,
  IngestedFile,
  SessionFiles,
  SessionTags,
  SimilarSession,
  SessionMeta,
  SessionLink,
} from '../types.js';
import { getPool } from '../db/client.js';

const { Pool } = pg;

/** Convert a number[] embedding to PostgreSQL vector literal. */
function vectorStr(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// --- PgTransaction ---

class PgTransaction implements Transaction {
  constructor(private client: pg.PoolClient) {}

  async insertSession(session: SessionInsert): Promise<void> {
    await this.client.query(
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

  async insertTurnWithEmbedding(turn: TurnInsert): Promise<void> {
    const embStr = vectorStr(turn.embedding);
    await this.client.query(
      `INSERT INTO anamnesis_turns
         (session_id, turn_index, user_content, assistant_content, tool_calls,
          files_in_turn, timestamp_start, timestamp_end, token_count, embedding_text, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
       ON CONFLICT (session_id, turn_index) DO UPDATE SET
         user_content=$3, assistant_content=$4, tool_calls=$5, files_in_turn=$6,
         timestamp_start=$7, timestamp_end=$8, token_count=$9, embedding_text=$10, embedding=$11::vector`,
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
        embStr,
      ]
    );
  }

  async updateSessionEmbedding(sessionId: string, embedding: number[]): Promise<void> {
    await this.client.query(
      'UPDATE anamnesis_sessions SET session_embedding = $1::vector WHERE session_id = $2',
      [vectorStr(embedding), sessionId]
    );
  }

  async mergeSessionEmbedding(sessionId: string, newEmbeddings: number[][], existingCount: number): Promise<void> {
    // Fetch existing session embedding, then compute weighted average with new turns
    const { rows } = await this.client.query(
      'SELECT session_embedding FROM anamnesis_sessions WHERE session_id = $1',
      [sessionId]
    );
    if (!rows[0]?.session_embedding) {
      // No existing embedding — just average the new ones
      const avg = newEmbeddings[0].map((_, dim) => {
        const sum = newEmbeddings.reduce((s, e) => s + e[dim], 0);
        return sum / newEmbeddings.length;
      });
      await this.updateSessionEmbedding(sessionId, avg);
      return;
    }

    // Parse existing embedding from pgvector format
    const oldEmb: number[] = typeof rows[0].session_embedding === 'string'
      ? JSON.parse(rows[0].session_embedding.replace('[', '[').replace(']', ']'))
      : rows[0].session_embedding;

    const newCount = newEmbeddings.length;
    const totalCount = existingCount + newCount;

    // Weighted merge: (old_avg * old_n + sum(new)) / total_n
    const merged = oldEmb.map((oldVal, dim) => {
      const newSum = newEmbeddings.reduce((s, e) => s + e[dim], 0);
      return (oldVal * existingCount + newSum) / totalCount;
    });

    await this.updateSessionEmbedding(sessionId, merged);
  }

  async deleteSessionData(sessionId: string): Promise<void> {
    await this.client.query('DELETE FROM anamnesis_sessions WHERE session_id = $1', [sessionId]);
  }

  async upsertIngestedFile(path: string, size: number, mtime: Date, sessionId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO anamnesis_ingested_files (file_path, file_size, file_mtime, session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (file_path) DO UPDATE SET
         file_size = $2, file_mtime = $3, session_id = $4, ingested_at = NOW()`,
      [path, size, mtime, sessionId]
    );
  }
}

// --- PgStorage ---

export class PgStorage implements StorageBackend {
  private pool: pg.Pool;

  constructor(pool?: pg.Pool) {
    this.pool = pool || getPool();
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PgTransaction(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // --- Ingested files ---

  async getIngestedFile(path: string): Promise<IngestedFile | null> {
    const { rows } = await this.pool.query(
      'SELECT file_path, file_size, file_mtime FROM anamnesis_ingested_files WHERE file_path = $1',
      [path]
    );
    if (rows.length === 0) return null;
    return { file_path: rows[0].file_path, file_size: Number(rows[0].file_size), file_mtime: rows[0].file_mtime };
  }

  async getIngestedFilesMap(paths: string[]): Promise<Map<string, IngestedFile>> {
    if (paths.length === 0) return new Map();
    const { rows } = await this.pool.query(
      'SELECT file_path, file_size, file_mtime FROM anamnesis_ingested_files WHERE file_path = ANY($1)',
      [paths]
    );
    const map = new Map<string, IngestedFile>();
    for (const row of rows) {
      map.set(row.file_path, { file_path: row.file_path, file_size: Number(row.file_size), file_mtime: row.file_mtime });
    }
    return map;
  }

  async upsertIngestedFile(path: string, size: number, mtime: Date, sessionId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO anamnesis_ingested_files (file_path, file_size, file_mtime, session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (file_path) DO UPDATE SET
         file_size = $2, file_mtime = $3, session_id = $4, ingested_at = NOW()`,
      [path, size, mtime, sessionId]
    );
  }

  // --- Sessions ---

  async getSessionTurnCount(sessionId: string): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT turn_count FROM anamnesis_sessions WHERE session_id = $1',
      [sessionId]
    );
    return rows.length > 0 ? Number(rows[0].turn_count) : 0;
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const { rows: sessions } = await this.pool.query(
      `SELECT * FROM anamnesis_sessions WHERE session_id LIKE $1 || '%' LIMIT 1`,
      [sessionId]
    );
    if (sessions.length === 0) return null;

    const session = sessions[0];

    const { rows: turns } = await this.pool.query(
      `SELECT turn_index, user_content, assistant_content, tool_calls,
              files_in_turn, timestamp_start, timestamp_end, token_count
       FROM anamnesis_turns
       WHERE session_id = $1
       ORDER BY turn_index`,
      [session.session_id]
    );

    const { rows: links } = await this.pool.query(
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

  async getRecentSessions(opts?: {
    project?: string;
    days?: number;
    file?: string;
    limit?: number;
  }): Promise<RecentSession[]> {
    const days = opts?.days || 7;
    const limit = opts?.limit || 10;
    const conditions = [`started_at >= NOW() - $1::interval`];
    const params: unknown[] = [`${days} days`, limit];

    if (opts?.project) {
      params.push(opts.project);
      conditions.push(`LOWER(project_name) = LOWER($${params.length})`);
    }
    if (opts?.file) {
      params.push(opts.file);
      conditions.push(`$${params.length} = ANY(files_touched)`);
    }

    const where = conditions.join(' AND ');

    const { rows } = await this.pool.query(
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

  async getSessionsForDate(date: string, project?: string): Promise<SessionSummary[]> {
    const conditions = [
      `started_at >= $1::date`,
      `started_at < ($1::date + INTERVAL '1 day')`,
      `NOT is_subagent`,
    ];
    const params: unknown[] = [date];

    if (project) {
      params.push(project);
      conditions.push(`LOWER(project_name) = LOWER($${params.length})`);
    }

    const { rows } = await this.pool.query(
      `SELECT session_id, project_name, started_at, ended_at, turn_count,
              model, summary, tags, files_touched, tools_used, is_subagent
       FROM anamnesis_sessions
       WHERE ${conditions.join(' AND ')}
       ORDER BY started_at`,
      params
    );
    return rows;
  }

  async getSessionsWithoutTopics(limit = 50): Promise<SessionWithoutTopics[]> {
    const { rows } = await this.pool.query(
      `SELECT session_id, project_name, files_touched, tools_used, turn_count
       FROM anamnesis_sessions
       WHERE (tags = '{}' OR tags IS NULL) AND turn_count > 0
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  // --- Search ---

  async searchByEmbedding(embedding: number[], opts?: SearchOpts): Promise<SearchResult[]> {
    const embStr = vectorStr(embedding);
    const limit = opts?.limit || 5;
    const minSim = opts?.minSimilarity ?? 0.3;
    const conditions: string[] = [];
    const params: unknown[] = [embStr, limit];

    if (opts?.project) {
      params.push(opts.project);
      conditions.push(`LOWER(s.project_name) = LOWER($${params.length})`);
    }
    if (opts?.since) {
      params.push(opts.since);
      conditions.push(`s.started_at >= $${params.length}::timestamptz`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.pool.query(
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
    return rows.filter((r: SearchResult) => r.similarity >= minSim);
  }

  async searchHybrid(embedding: number[], query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const embStr = vectorStr(embedding);
    const limit = opts?.limit || 5;
    const conditions: string[] = [];
    const params: unknown[] = [embStr, query, limit];

    if (opts?.project) {
      params.push(opts.project);
      conditions.push(`LOWER(s.project_name) = LOWER($${params.length})`);
    }
    if (opts?.since) {
      params.push(opts.since);
      conditions.push(`s.started_at >= $${params.length}::timestamptz`);
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const { rows } = await this.pool.query(
      `WITH semantic AS (
         SELECT t.id, ROW_NUMBER() OVER (ORDER BY t.embedding <=> $1::vector) AS rank
         FROM anamnesis_turns t
         JOIN anamnesis_sessions s ON s.session_id = t.session_id
         WHERE t.embedding IS NOT NULL ${where}
         LIMIT 100
       ),
       keyword AS (
         SELECT t.id, ROW_NUMBER() OVER (ORDER BY ts_rank(t.tsv, plainto_tsquery('english', $2)) DESC) AS rank
         FROM anamnesis_turns t
         JOIN anamnesis_sessions s ON s.session_id = t.session_id
         WHERE t.tsv @@ plainto_tsquery('english', $2) ${where}
         LIMIT 100
       ),
       combined AS (
         SELECT COALESCE(s.id, k.id) AS id,
                COALESCE(1.0 / (60 + s.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS rrf_score
         FROM semantic s
         FULL OUTER JOIN keyword k ON s.id = k.id
       )
       SELECT t.session_id, t.turn_index, ses.project_name,
              t.user_content, t.assistant_content,
              c.rrf_score * (1.0 + 0.1 / (1.0 + EXTRACT(EPOCH FROM (NOW() - COALESCE(ses.started_at, NOW()))) / 86400.0)) AS similarity,
              t.timestamp_start, ses.started_at
       FROM combined c
       JOIN anamnesis_turns t ON t.id = c.id
       JOIN anamnesis_sessions ses ON ses.session_id = t.session_id
       ORDER BY similarity DESC
       LIMIT $3`,
      params
    );
    return rows;
  }

  // --- Topics ---

  async updateSessionTopics(sessionId: string, tags: string[], summary: string): Promise<void> {
    await this.pool.query(
      `UPDATE anamnesis_sessions SET tags = $2, summary = $3 WHERE session_id = $1`,
      [sessionId, tags, summary]
    );
  }

  async getFirstUserMessage(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT user_content FROM anamnesis_turns
       WHERE session_id = $1 AND user_content IS NOT NULL
       ORDER BY turn_index LIMIT 1`,
      [sessionId]
    );
    return rows[0]?.user_content || null;
  }

  async getSessionTurnTexts(sessionId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT embedding_text FROM anamnesis_turns
       WHERE session_id = $1 AND embedding_text IS NOT NULL AND embedding_text != ''
       ORDER BY turn_index`,
      [sessionId]
    );
    return rows.map((r: { embedding_text: string }) => r.embedding_text);
  }

  // --- Linking ---

  async getSessionFiles(sessionId: string): Promise<string[]> {
    const { rows: [session] } = await this.pool.query(
      'SELECT files_touched FROM anamnesis_sessions WHERE session_id = $1',
      [sessionId]
    );
    return session?.files_touched || [];
  }

  async getSessionsWithOverlappingFiles(sessionId: string, files: string[]): Promise<SessionFiles[]> {
    if (files.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT session_id, files_touched
       FROM anamnesis_sessions
       WHERE session_id != $1
         AND files_touched && $2::text[]`,
      [sessionId, files]
    );
    return rows;
  }

  async getSessionTags(sessionId: string): Promise<string[]> {
    const { rows: [session] } = await this.pool.query(
      'SELECT tags FROM anamnesis_sessions WHERE session_id = $1',
      [sessionId]
    );
    return session?.tags || [];
  }

  async getSessionsWithOverlappingTags(sessionId: string, tags: string[]): Promise<SessionTags[]> {
    if (tags.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT session_id, tags
       FROM anamnesis_sessions
       WHERE session_id != $1
         AND tags && $2::text[]
         AND array_length(tags, 1) > 0`,
      [sessionId, tags]
    );
    return rows;
  }

  async findSimilarSessions(sessionId: string, topN = 5): Promise<SimilarSession[]> {
    const { rows: [session] } = await this.pool.query(
      'SELECT session_embedding FROM anamnesis_sessions WHERE session_id = $1',
      [sessionId]
    );
    if (!session?.session_embedding) return [];

    const { rows } = await this.pool.query(
      `SELECT session_id, 1 - (session_embedding <=> $1::vector) AS similarity
       FROM anamnesis_sessions
       WHERE session_id != $2
         AND session_embedding IS NOT NULL
       ORDER BY session_embedding <=> $1::vector
       LIMIT $3`,
      [session.session_embedding, sessionId, topN]
    );
    return rows;
  }

  async upsertSessionLink(a: string, b: string, linkType: string, score: number, detail: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO anamnesis_session_links (session_a, session_b, link_type, score, shared_detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_a, session_b, link_type) DO UPDATE SET score = $4, shared_detail = $5`,
      [a, b, linkType, score, detail]
    );
  }

  // --- Context builder ---

  async getSessionMetaBatch(sessionIds: string[]): Promise<SessionMeta[]> {
    if (sessionIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT session_id, project_name, summary, tags, started_at, turn_count
       FROM anamnesis_sessions
       WHERE session_id = ANY($1)`,
      [sessionIds]
    );
    return rows;
  }

  async getLinksForSessions(sessionIds: string[]): Promise<SessionLink[]> {
    if (sessionIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT l.session_a, l.session_b, l.link_type, l.score, l.shared_detail,
              s.project_name, s.started_at, s.summary
       FROM anamnesis_session_links l
       JOIN anamnesis_sessions s ON s.session_id = CASE
         WHEN l.session_a = ANY($1) THEN l.session_b ELSE l.session_a END
       WHERE (l.session_a = ANY($1) OR l.session_b = ANY($1))
         AND l.score >= 0.3
       ORDER BY l.score DESC`,
      [sessionIds]
    );
    return rows;
  }

  // --- Stats ---

  async getStats(): Promise<Stats> {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT count(*) FROM anamnesis_sessions) AS sessions,
        (SELECT count(*) FROM anamnesis_turns) AS turns,
        (SELECT count(*) FROM anamnesis_ingested_files) AS files,
        (SELECT count(*) FROM anamnesis_session_links) AS links
    `);
    return rows[0];
  }
}
