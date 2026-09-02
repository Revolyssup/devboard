import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = os.homedir();

const agentDataRoot = process.env.DEVBOARD_DATA_ROOT || path.join(home, '.agents', 'data');
const preferExisting = (primary, fallback) => (fs.existsSync(primary) ? primary : fallback);

export const config = {
  port: Number(process.env.PORT || 5178),
  home,
  agentDataRoot,

  // Data roots
  workLearningsDir:
    process.env.DEVBOARD_WORK_DIR ||
    preferExisting(path.join(agentDataRoot, 'learnings', 'work'), path.join(home, '.claude', 'learnings')),
  personalLearningsDir:
    process.env.DEVBOARD_PERSONAL_DIR ||
    preferExisting(
      path.join(agentDataRoot, 'learnings', 'personal'),
      path.join(home, '.claude', 'personal', 'learnings')
    ),

  // Chores are scoped the same way learnings are: each section tracks its own.
  workChoresDir:
    process.env.DEVBOARD_CHORES_DIR ||
    preferExisting(path.join(agentDataRoot, 'chores', 'work'), path.join(home, '.claude', 'chores')),
  personalChoresDir:
    process.env.DEVBOARD_PERSONAL_CHORES_DIR ||
    preferExisting(
      path.join(agentDataRoot, 'chores', 'personal'),
      path.join(home, '.claude', 'personal', 'chores')
    ),

  // Agent session transcripts. Claude uses project slugs; Codex stores dated JSONL rollouts.
  projectsDir: path.join(home, '.claude', 'projects'),
  claudeProjectsDir: path.join(home, '.claude', 'projects'),
  codexSessionsDir: path.join(home, '.codex', 'sessions'),
  codexSessionIndex: path.join(home, '.codex', 'session_index.jsonl'),

  // Learning-shit progress reports (HTML)
  reportsDir: process.env.DEVBOARD_REPORTS_DIR || path.join(home, 'dev', 'learning-shit', 'reports'),

  // A session counts as "active" when its transcript was touched within this window
  // AND a live agent process is rooted in the matching project directory.
  activeWindowMs: Number(process.env.DEVBOARD_ACTIVE_WINDOW_MS || 15 * 60 * 1000),

  // Cache TTL for the (relatively expensive) process scan
  sessionScanTtlMs: 5000,

  // --- Run session (browser terminal) ---------------------------------------
  // Agent binaries a terminal resumes with. Injectable so verifiers can point at stand-ins.
  claudeBin: process.env.DEVBOARD_CLAUDE_BIN || 'claude',
  codexBin: process.env.DEVBOARD_CODEX_BIN || 'codex',

  // A terminal may only be opened with a cwd under one of these roots. `directory` comes from
  // an index.txt row on disk, so it is treated as untrusted input.
  terminalRoots: (process.env.DEVBOARD_TERMINAL_ROOTS || home)
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean),

  maxTerminals: Number(process.env.DEVBOARD_MAX_TERMINALS || 3),
  terminalIdleMs: Number(process.env.DEVBOARD_TERMINAL_IDLE_MS || 30 * 60 * 1000),
  ticketTtlMs: 30_000,

  // Origins allowed to open a terminal websocket. `ws` does not check Origin itself, so without
  // this any page you visit could open a socket to the loopback server.
  allowedOrigins: (
    process.env.DEVBOARD_ALLOWED_ORIGINS ||
    `http://localhost:${Number(process.env.PORT || 5178)},http://127.0.0.1:${Number(process.env.PORT || 5178)},http://localhost:5177,http://127.0.0.1:5177`
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

/** Files in a learnings dir that are never learnings. */
export const EXCLUDED_BASENAMES = new Set(['index.txt', 'STEERING.md', 'MEMORY.md']);
