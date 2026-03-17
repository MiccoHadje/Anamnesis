/**
 * Anamnesis HTTP Server — persistent background process.
 * Centralizes hook logic, runs periodic background ingestion,
 * stores compact summaries, and captures enriched session metadata.
 *
 * Usage: node dist/server.js [--port PORT]
 */
import { createServer } from 'http';
import { getConfig } from './util/config.js';
import { closeStorage } from './storage/index.js';
import { writePid, removePid } from './server/pid.js';
import { startTimer, stopTimer } from './server/timer.js';
import {
  handleHealth,
  handleStats,
  handleSessionStart,
  handleSessionEnd,
  handlePreCompact,
  handlePostCompact,
  handlePlanRecall,
  handleIngestRequest,
} from './server/routes.js';

// Parse CLI args
let port: number | undefined;
let host: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) {
    port = parseInt(process.argv[++i], 10);
  } else if (process.argv[i] === '--host' && process.argv[i + 1]) {
    host = process.argv[++i];
  }
}

const config = getConfig();
const serverConfig = config.server || { port: 3851, host: '127.0.0.1', ingest_interval_minutes: 15, pid_file: '' };
const finalPort = port || serverConfig.port;
const finalHost = host || serverConfig.host;
const pidFile = serverConfig.pid_file;

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  try {
    // Route dispatch
    if (url === '/health' && method === 'GET') {
      await handleHealth(req, res);
    } else if (url === '/stats' && method === 'GET') {
      await handleStats(req, res);
    } else if (url === '/hooks/session-start' && method === 'POST') {
      await handleSessionStart(req, res);
    } else if (url === '/hooks/session-end' && method === 'POST') {
      await handleSessionEnd(req, res);
    } else if (url === '/hooks/pre-compact' && method === 'POST') {
      await handlePreCompact(req, res);
    } else if (url === '/hooks/post-compact' && method === 'POST') {
      await handlePostCompact(req, res);
    } else if (url === '/hooks/plan-recall' && method === 'POST') {
      await handlePlanRecall(req, res);
    } else if (url === '/ingest' && method === 'POST') {
      await handleIngestRequest(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  } catch (err) {
    console.error(`[server] Error handling ${method} ${url}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
  }
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received, shutting down...`);
  stopTimer();
  server.close();
  await closeStorage();
  if (pidFile) removePid(pidFile);
  console.log('[server] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
server.listen(finalPort, finalHost, () => {
  console.log(`[server] Anamnesis HTTP server listening on ${finalHost}:${finalPort}`);
  if (pidFile) {
    writePid(pidFile);
    console.log(`[server] PID ${process.pid} written to ${pidFile}`);
  }
  startTimer(serverConfig.ingest_interval_minutes);
});
