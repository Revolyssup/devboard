import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { learningsRouter } from './routes/learnings.js';
import { choresRouter } from './routes/chores.js';
import { reportsRouter, reportsFileRouter } from './routes/reports.js';
import { terminalRouter } from './routes/terminal.js';
import { envRouter } from './routes/env.js';
import { codeRouter } from './routes/code.js';
import { codontRouter } from './routes/codont.js';
import { designRouter } from './routes/design.js';
import { subscribe as subscribeRun } from './lib/env/executor.js';
import { sessionSnapshot } from './lib/sessions.js';
import { attach, redeemTicket, reapOrphans, shutdownAll } from './lib/terminals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, '..', 'web', 'dist');

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    paths: {
      work: config.workLearningsDir,
      personal: config.personalLearningsDir,
      workChores: config.workChoresDir,
      personalChores: config.personalChoresDir,
      reports: config.reportsDir,
    },
    sessions: await sessionSnapshot(),
  });
});

app.use('/api/learnings', learningsRouter);
app.use('/api/chores', choresRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/terminal', terminalRouter);
app.use('/api/env', envRouter);
app.use('/api/code', codeRouter);
app.use('/api/codont', codontRouter);
app.use('/api/design', designRouter);
app.use('/reports', reportsFileRouter);

// Serve the built SPA when it exists (production / `npm run build`).
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/reports).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error', code: err.code });
});

const server = http.createServer(app);

// --- terminal websocket -------------------------------------------------------------------
// `noServer` so we can reject bad upgrades ourselves before any socket is accepted.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const reject = (why) => {
    socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${why}`);
    socket.destroy(); // not destroying here leaks the fd
  };

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return reject('bad url');
  }
  if (url.pathname !== '/api/terminal' && url.pathname !== '/api/env/stream') {
    return reject('unknown endpoint');
  }

  // `ws` does not check Origin. Without this, any page you visit could open a socket to the
  // loopback server and drive a claude session.
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) return reject('origin not allowed');

  // Environment run logs are read-only: no ticket, but also no way to send anything back. The
  // socket only ever receives, so it cannot be used to drive an environment change.
  if (url.pathname === '/api/env/stream') {
    const runId = url.searchParams.get('run') || '';
    if (!runId) return reject('run id required');
    return wss.handleUpgrade(req, socket, head, (ws) => {
      const off = subscribeRun(runId, (ev) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
      });
      ws.on('close', off);
      ws.on('error', off);
      // Ignore anything the client sends; this endpoint is strictly one-directional.
      ws.on('message', () => {});
    });
  }

  const entry = redeemTicket(url.searchParams.get('ticket') || '');
  if (!entry) return reject('bad or expired ticket');

  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, entry));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shutdownAll('server-shutdown');
    process.exit(0);
  });
}

// Bound to loopback deliberately: this server can spawn a claude session with the user's
// credentials, so it must never be reachable from the network.
server.listen(config.port, '127.0.0.1', async () => {
  const reaped = await reapOrphans(promisify(execFile));
  if (reaped) console.log(`  reaped      ${reaped} orphaned terminal(s)`);
  console.log(`devboard api  → http://localhost:${config.port}`);
  console.log(`  work        ${config.workLearningsDir}`);
  console.log(`  personal    ${config.personalLearningsDir}`);
  console.log(`  chores      ${config.workChoresDir}`);
  console.log(`  p. chores   ${config.personalChoresDir}`);
  console.log(`  reports     ${config.reportsDir}`);
});
