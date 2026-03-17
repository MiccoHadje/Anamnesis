import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { getStorage } from '../storage/index.js';
import { getConfig } from '../util/config.js';
import { embed } from '../etl/embedder.js';
import { discoverFiles, findFileBySessionId } from '../etl/discovery.js';
import { ingestFile } from '../etl/ingester.js';
import { getTimerState } from './timer.js';

const VERSION = '1.3.0';
const startTime = Date.now();

// --- Helpers ---

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function deriveProjectName(cwd: string): string | null {
  if (!cwd) return null;
  const m = cwd.match(/[A-Za-z]:[/\\]Projects[/\\]([^/\\]+)/i);
  return m ? m[1] : null;
}

// --- Route Handlers ---

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uptimeMs = Date.now() - startTime;
  json(res, {
    status: 'ok',
    version: VERSION,
    pid: process.pid,
    uptime_seconds: Math.floor(uptimeMs / 1000),
    timer: getTimerState(),
  });
}

export async function handleStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const storage = getStorage();
  const stats = await storage.getStats();
  json(res, {
    ...stats,
    timer: getTimerState(),
  });
}

export async function handleSessionStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const cwd = String(body.cwd || '');
  const projectName = deriveProjectName(cwd);

  if (!projectName) {
    json(res, {});
    return;
  }

  const storage = getStorage();

  // Get recent sessions for this project
  const sessions = await storage.getRecentSessions({
    project: projectName,
    days: 7,
    limit: 5,
  });

  if (sessions.length === 0) {
    json(res, {});
    return;
  }

  const displayLines: string[] = [];
  const contextLines: string[] = [];

  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  const DIM = '\x1b[2m';
  const MAGENTA = '\x1b[35m';

  displayLines.push(`${BOLD}${MAGENTA}RECALL:${RESET} ${DIM}Recent sessions on @${projectName}${RESET}`);
  contextLines.push(`Anamnesis - Recent sessions on @${projectName}:`);

  for (const s of sessions) {
    if (s.is_subagent) continue;
    const date = s.started_at ? `${new Date(s.started_at).getMonth() + 1}/${new Date(s.started_at).getDate()}` : '?';
    const files = (s.files_touched || []).slice(0, 3);
    const basenames = files.map((f: string) => f.replace(/\\/g, '/').split('/').pop() || f);
    const filesStr = basenames.join(', ') + (s.files_touched.length > 3 ? ` (+${s.files_touched.length - 3})` : '');
    const line = `  ${date}: ${s.turn_count} turns${filesStr ? ` - ${filesStr}` : ''}`;
    displayLines.push(`${DIM}${line}${RESET}`);
    contextLines.push(line);
  }

  // Check Nudge focus (optional, graceful)
  try {
    const config = getConfig();
    if (config.tasks?.provider === 'nudge' && config.tasks.nudge) {
      const pg = await import('pg');
      const pool = new pg.default.Pool({
        host: config.tasks.nudge.host,
        port: config.tasks.nudge.port,
        database: config.tasks.nudge.database,
        user: config.tasks.nudge.user,
        password: config.tasks.nudge.password,
      });
      try {
        const { rows } = await pool.query(`
          SELECT t.title
          FROM nudge_focus f
          LEFT JOIN nudge_tasks t ON f.task_id = t.id
          WHERE f.user_id = '00000000-0000-0000-0000-000000000001'
        `);
        if (rows[0]?.title) {
          // Search for focus-related sessions
          const { rows: focusSessions } = await pool.query(`
            SELECT DISTINCT s.session_id, s.started_at, s.turn_count
            FROM anamnesis_turns t
            JOIN anamnesis_sessions s ON s.session_id = t.session_id
            WHERE t.tsv @@ plainto_tsquery('english', $1)
              AND s.project_name = $2
              AND NOT s.is_subagent
              AND s.started_at >= NOW() - INTERVAL '30 days'
            ORDER BY s.started_at DESC
            LIMIT 3
          `, [rows[0].title, projectName]);
          // Note: this query goes to anamnesis DB, not nudge. We'd need a separate pool.
          // For now, just add the focus hint.
          const count = focusSessions.length;
          if (count > 0) {
            const hint = `[Focus: "${rows[0].title}" - ${count} past session${count !== 1 ? 's' : ''} found. Use anamnesis_search for details.]`;
            displayLines.push(`${DIM}${hint}${RESET}`);
            contextLines.push(hint);
          }
        }
      } finally {
        await pool.end();
      }
    }
  } catch {
    // Nudge not available — that's fine
  }

  json(res, {
    systemMessage: displayLines.join('\n'),
    context: contextLines.join('\n'),
  });
}

export async function handleSessionEnd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const sessionId = String(body.session_id || '');

  // Fire off ingestion
  try {
    if (sessionId) {
      const filePath = findFileBySessionId(sessionId);
      if (filePath) {
        const result = await ingestFile(filePath, {
          onProgress: (msg) => console.log(`[session-end] ${msg}`),
        });
        console.log(`[session-end] Ingested ${result.sessionId} (${result.turnCount} turns)`);
        json(res, { ingested: true, session_id: result.sessionId, turns: result.turnCount });
        return;
      }
    }

    // Fallback: discover most recent changed file
    const files = await discoverFiles({ minSize: 1024 });
    if (files.length > 0) {
      files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      const result = await ingestFile(files[0].path, {
        onProgress: (msg) => console.log(`[session-end] ${msg}`),
      });
      console.log(`[session-end] Ingested ${result.sessionId} (${result.turnCount} turns)`);
      json(res, { ingested: true, session_id: result.sessionId, turns: result.turnCount });
      return;
    }

    json(res, { ingested: false, reason: 'no transcript found' });
  } catch (err) {
    console.error(`[session-end] Error: ${err instanceof Error ? err.message : err}`);
    json(res, { ingested: false, error: String(err) });
  }
}

export async function handlePreCompact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const transcriptPath = String(body.transcript_path || '');
  const sessionId = String(body.session_id || 'unknown');
  const trigger = String(body.trigger || 'auto');
  const cwd = String(body.cwd || '');

  // Extract state from transcript tail
  const state = transcriptPath ? extractTranscriptState(transcriptPath) : {
    files_modified: [], bash_commands: [], task_context: [], errors: [], cwd,
  };
  if (!state.cwd) state.cwd = cwd;

  // Trigger ingestion (non-blocking — we don't await)
  if (sessionId && sessionId !== 'unknown') {
    const filePath = findFileBySessionId(sessionId);
    if (filePath) {
      ingestFile(filePath, {
        onProgress: (msg) => console.log(`[pre-compact] ${msg}`),
      }).catch((err) => {
        console.error(`[pre-compact] Ingest error: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  // Format continuation context
  const now = new Date().toLocaleString('en-US', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
  }) + ' Eastern';

  const continuation = `Current local time: ${now}\n${formatContinuation(state, trigger)}`;

  json(res, { systemMessage: continuation });
}

export async function handlePostCompact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const sessionId = String(body.session_id || '');
  const compactSummary = String(body.compact_summary || '');
  const trigger = String(body.trigger || 'auto');

  if (!sessionId || !compactSummary) {
    json(res, { stored: false, reason: 'missing session_id or compact_summary' });
    return;
  }

  try {
    const storage = getStorage();
    await storage.insertCompactSummary(sessionId, compactSummary, trigger);
    console.log(`[post-compact] Stored compact summary for ${sessionId.slice(0, 8)}`);

    // Also trigger ingestion
    const filePath = findFileBySessionId(sessionId);
    if (filePath) {
      ingestFile(filePath, {
        onProgress: (msg) => console.log(`[post-compact] ${msg}`),
      }).catch((err) => {
        console.error(`[post-compact] Ingest error: ${err instanceof Error ? err.message : err}`);
      });
    }

    json(res, { stored: true });
  } catch (err) {
    console.error(`[post-compact] Error: ${err instanceof Error ? err.message : err}`);
    json(res, { stored: false, error: String(err) });
  }
}

export async function handlePlanRecall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const cwd = String(body.cwd || '');
  const transcriptPath = String(body.transcript_path || '');

  let queryText: string | null = null;
  let source = 'transcript';

  // Extract query from last user message
  if (transcriptPath) {
    queryText = getLastUserMessage(transcriptPath);
    if (queryText) {
      // Strip /plan prefix
      let cleaned = queryText.trim();
      if (cleaned.toLowerCase().startsWith('/plan')) {
        cleaned = cleaned.slice(5).trim();
      }
      queryText = cleaned.length > 5 ? cleaned.slice(0, 500) : null;
    }
  }

  // Fallback to Nudge focus
  if (!queryText) {
    queryText = await getNudgeFocus();
    if (queryText) {
      source = 'nudge_focus';
    }
  }

  if (!queryText) {
    json(res, {});
    return;
  }

  const project = deriveProjectName(cwd);

  // Get embedding
  let embedding: number[];
  try {
    embedding = await embed(queryText);
  } catch (err) {
    console.error(`[plan-recall] Embedding error: ${err instanceof Error ? err.message : err}`);
    json(res, {});
    return;
  }

  // Search
  const storage = getStorage();
  const config = getConfig();
  const useHybrid = config.search_mode === 'hybrid';
  const results = useHybrid
    ? await storage.searchHybrid(embedding, queryText, { project: project || undefined, limit: 5, minSimilarity: 0.3 })
    : await storage.searchByEmbedding(embedding, { project: project || undefined, limit: 5, minSimilarity: 0.3 });

  // Format results
  const lines: string[] = [`Anamnesis recall for plan mode (query: "${queryText.slice(0, 100)}", source: ${source}):`];

  if (results.length === 0) {
    lines.push('No relevant past sessions found.');
  } else {
    for (const r of results) {
      const date = r.started_at ? `${new Date(r.started_at).getMonth() + 1}/${new Date(r.started_at).getDate()}` : '?';
      const sim = `${(r.similarity * 100).toFixed(0)}%`;
      lines.push(`- [${r.session_id.slice(0, 8)}] @${r.project_name || '?'} ${date} (${sim} match)`);
      if (r.user_content) {
        lines.push(`  User: ${r.user_content.slice(0, 200)}`);
      }
      if (r.assistant_content) {
        lines.push(`  Assistant: ${r.assistant_content.slice(0, 300)}`);
      }
    }
    lines.push('\nUse anamnesis_session(session_id) to get full context from any of these.');
  }

  const context = lines.join('\n');

  json(res, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  });
}

export async function handleIngestRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const sessionId = body.session_id as string | undefined;
  const force = body.force as boolean | undefined;

  try {
    if (sessionId) {
      const filePath = findFileBySessionId(sessionId);
      if (!filePath) {
        json(res, { ingested: false, reason: 'transcript not found' });
        return;
      }
      const result = await ingestFile(filePath, {
        force,
        onProgress: (msg) => console.log(`[ingest] ${msg}`),
      });
      json(res, { ingested: !result.skipped, session_id: result.sessionId, turns: result.turnCount });
      return;
    }

    // Discover and ingest new files
    const files = await discoverFiles({ minSize: 1024 });
    if (files.length === 0) {
      json(res, { ingested: false, discovered: 0 });
      return;
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const batch = files.slice(0, 10);
    let ingested = 0;
    for (const file of batch) {
      try {
        const result = await ingestFile(file.path, {
          onProgress: (msg) => console.log(`[ingest] ${msg}`),
        });
        if (!result.skipped) ingested++;
      } catch (err) {
        console.error(`[ingest] Error: ${err instanceof Error ? err.message : err}`);
      }
    }

    json(res, { ingested: ingested > 0, count: ingested, discovered: files.length });
  } catch (err) {
    json(res, { ingested: false, error: String(err) }, 500);
  }
}

// --- Internal helpers ---

interface TranscriptState {
  files_modified: string[];
  bash_commands: string[];
  task_context: string[];
  errors: string[];
  cwd: string | null;
}

function extractTranscriptState(transcriptPath: string): TranscriptState {
  const state: TranscriptState = {
    files_modified: [],
    bash_commands: [],
    task_context: [],
    errors: [],
    cwd: null,
  };

  let lines: string[];
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const allLines = content.split('\n');
    lines = allLines.slice(-200);
  } catch {
    return state;
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.cwd) state.cwd = String(entry.cwd);

    if (entry.type === 'assistant') {
      const message = entry.message as Record<string, unknown> | undefined;
      const content = (message?.content || []) as unknown[];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || !block) continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            const name = String(b.name || '');
            const inp = (b.input || {}) as Record<string, unknown>;
            if ((name === 'Edit' || name === 'Write') && inp.file_path) {
              const fp = String(inp.file_path);
              if (!state.files_modified.includes(fp)) state.files_modified.push(fp);
            } else if (name === 'Bash' && inp.command) {
              const cmd = String(inp.command);
              if (cmd.length < 200) state.bash_commands.push(cmd);
            }
          } else if (b.type === 'text') {
            const text = String(b.text || '');
            for (const tl of text.split('\n')) {
              const lower = tl.toLowerCase().trim();
              if (['focus:', 'working on', 'completed', 'in_progress', 'in progress', 'blocked', 'started:', 'done:', 'finished'].some(kw => lower.includes(kw))) {
                if (tl.trim().length > 5 && tl.trim().length < 150) {
                  state.task_context.push(tl.trim());
                }
              }
            }
          }
        }
      }
    } else if (entry.type === 'tool_result') {
      const rc = entry.content;
      if (typeof rc === 'string' && rc.toLowerCase().includes('error') && rc.length < 300) {
        state.errors.push(rc.slice(0, 200));
      }
    }
  }

  state.files_modified = state.files_modified.slice(-15);
  state.bash_commands = state.bash_commands.slice(-10);
  state.task_context = state.task_context.slice(-5);
  state.errors = state.errors.slice(-5);

  return state;
}

function formatContinuation(state: TranscriptState, trigger: string): string {
  const parts: string[] = [];

  if (state.files_modified.length > 0) {
    const basenames = state.files_modified.slice(-8).map(f => f.replace(/\\/g, '/').split('/').pop() || f);
    parts.push(`Files touched: ${basenames.map(b => '`' + b + '`').join(', ')}`);
  }
  if (state.bash_commands.length > 0) {
    const recent = state.bash_commands.slice(-3);
    parts.push(`Recent commands: ${recent.map(c => '`' + c.slice(0, 80) + '`').join('; ')}`);
  }
  if (state.task_context.length > 0) {
    parts.push(`Task context: ${state.task_context[state.task_context.length - 1]}`);
  }
  if (state.errors.length > 0) {
    parts.push(`Last error: ${state.errors[state.errors.length - 1].slice(0, 100)}`);
  }

  if (parts.length === 0) {
    return 'Context compacted. No significant pre-compaction state captured.';
  }

  return (
    `PRE-COMPACTION STATE (${trigger}): ${parts.join(' | ')}\n` +
    'Continue the current work. The session transcript has been ' +
    'ingested into Anamnesis — use anamnesis_search or anamnesis_session ' +
    'to retrieve detailed pre-compaction context if needed.'
  );
}

function getLastUserMessage(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    let lastMsg: string | null = null;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'human') {
        const message = entry.message as Record<string, unknown> | undefined;
        let text = message?.content;
        if (Array.isArray(text)) {
          const parts: string[] = [];
          for (const block of text) {
            if (typeof block === 'string') parts.push(block);
            else if (typeof block === 'object' && block && (block as Record<string, unknown>).type === 'text') {
              parts.push(String((block as Record<string, unknown>).text || ''));
            }
          }
          text = parts.join(' ');
        }
        if (typeof text === 'string' && text.trim().length > 5) {
          lastMsg = text.trim();
        }
      }
    }
    return lastMsg;
  } catch {
    return null;
  }
}

async function getNudgeFocus(): Promise<string | null> {
  try {
    const config = getConfig();
    if (config.tasks?.provider !== 'nudge' || !config.tasks.nudge) return null;

    const pg = await import('pg');
    const pool = new pg.default.Pool({
      host: config.tasks.nudge.host,
      port: config.tasks.nudge.port,
      database: config.tasks.nudge.database,
      user: config.tasks.nudge.user,
      password: config.tasks.nudge.password,
    });
    try {
      const { rows } = await pool.query(`
        SELECT t.title
        FROM nudge_focus f
        LEFT JOIN nudge_tasks t ON f.task_id = t.id
        WHERE f.user_id = '00000000-0000-0000-0000-000000000001'
      `);
      return rows[0]?.title || null;
    } finally {
      await pool.end();
    }
  } catch {
    return null;
  }
}
