/**
 * Browser terminals: resume an agent session under a PTY and proxy it to a websocket.
 *
 * Flow is two-phase on purpose — `preflight()` validates everything and hands back a single-use
 * ticket, then the socket upgrade redeems it. That way every failure is an ordinary HTTP status
 * with a JSON body (the convention the rest of this server and `web/src/api.ts` already use), the
 * user sees a real message before any terminal chrome mounts, and neither the session id nor an
 * absolute path ever rides in a websocket URL.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as pty from 'node-pty';
import { config } from '../config.js';
import { choreDir, bindChoreSession, createPendingChore } from './chores.js';
import {
  bindLearningSession,
  createDraftLearning,
  fillDraftInitialPrompt,
  safeJoin,
  scopeDir,
} from './learnings.js';
import {
  slugForDirectory,
  sessionOccupancy,
  markOwnedPid,
  unmarkOwnedPid,
} from './sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BUFFERED = 1 << 20; // 1 MiB in the socket before we pause the pty
const KILL_GRACE_MS = 2000;
const TRANSCRIPT_DRIFT_POLL_MS = 5000;
const TRANSCRIPT_DRIFT_IDLE_MS = 15_000;
const REAPER_FILE = path.join(os.homedir(), '.devboard', 'terminals.json');
const AGENTS = new Set(['claude', 'codex']);
const sessionKey = (agent, id) => `${agent}:${String(id).toLowerCase()}`;

function commandForResume(agent, sessionId) {
  if (agent === 'codex') return { bin: config.codexBin, args: ['resume', sessionId] };
  return { bin: config.claudeBin, args: ['--resume', sessionId] };
}

function commandForNew(agent) {
  if (agent === 'codex') return { bin: config.codexBin, args: [] };
  return { bin: config.claudeBin, args: [] };
}

function singleLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function startupChoreCommand(agent, scope, title, description, chorePath) {
  const cmd = scope === 'personal' ? '/start-personal-chore' : '/start-chore';
  const ask = singleLine(
    `${title}: ${description}. Use existing chore file ${chorePath}; do not create a duplicate. Read the whole file, update the ${agent} section only, and keep What is done / What is happening / What is pending current.`
  );
  return agent === 'codex' ? `run ${cmd} ${ask}\r` : `${cmd} ${ask}\r`;
}

function resumeChoreCommand(agent, chorePath) {
  const ask = singleLine(
    `${chorePath}. Read the whole chore file, resume the work from its current state, update only the ${agent} section, and keep What is done / What is happening / What is pending current.`
  );
  return agent === 'codex' ? `resume chore ${ask}\r` : `/resume-chore ${ask}\r`;
}

function resumeLearningCommand(agent, learningPath) {
  return singleLine(
    `Read the handoff/learning file ${learningPath}, continue from the latest state across all agents, and update only the ${agent} section with your progress.`
  ) + '\r';
}

/** terminalId -> record */
const registry = new Map();
/** agent:sessionId -> terminalId (O(1) "is this session already open here?") */
const bySession = new Map();
/** ticket -> { terminalId, spec, expiresAt } */
const tickets = new Map();
/**
 * terminalId -> { key, sessionId, expiresAt } for tickets minted but not yet attached.
 * Without this, two preflights for the same session both pass (nothing is in `registry` yet) and
 * both can attach — two agent processes interleaving one transcript, which is exactly what the
 * occupancy check exists to prevent.
 */
const reservations = new Map();

function releaseReservation(terminalId) {
  const r = reservations.get(terminalId);
  if (!r) return;
  reservations.delete(terminalId);
  if (r.key && bySession.get(r.key) === terminalId) bySession.delete(r.key);
  for (const [tk, entry] of tickets) if (entry.terminalId === terminalId) tickets.delete(tk);
}

// Reservations must not leak when a preflight is never followed by a socket (user hits Cancel,
// tab closed, network died).
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [terminalId, r] of [...reservations]) {
    if (r.expiresAt < now && !registry.has(terminalId)) releaseReservation(terminalId);
  }
}, 5000);
sweeper.unref?.();

function fail(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
};

function expandHome(dir) {
  const s = String(dir || '').trim();
  if (s === '~') return config.home;
  if (s.startsWith('~/')) return path.join(config.home, s.slice(2));
  return s;
}

/** `directory` comes off UI/disk — confine it to an allowlisted root. */
function assertDirectoryAllowed(dir) {
  const resolved = path.resolve(expandHome(dir));
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw fail(400, 'BAD_DIRECTORY', `directory does not exist: ${resolved}`);
  }
  if (!st.isDirectory()) throw fail(400, 'BAD_DIRECTORY', `not a directory: ${resolved}`);

  const ok = config.terminalRoots.some(
    (root) => resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep)
  );
  if (!ok) {
    throw fail(400, 'DIR_OUTSIDE_ROOTS', `directory is outside the allowed roots: ${resolved}`);
  }
  return resolved;
}

async function walkJsonl(root) {
  const files = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await visit(full);
        else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
      })
    );
  }
  await visit(root);
  return files;
}

async function readStart(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function agentSessionsInDirectory(agent, cwd) {
  const out = new Map();
  if (agent === 'claude') {
    const dir = path.join(config.claudeProjectsDir, slugForDirectory(cwd));
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      return out;
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map(async (f) => {
          const id = f.slice(0, -'.jsonl'.length);
          if (!UUID_RE.test(id)) return;
          const full = path.join(dir, f);
          try {
            const st = await fsp.stat(full);
            out.set(id, { id, transcript: full, mtimeMs: st.mtimeMs });
          } catch {
            /* raced with creation */
          }
        })
    );
    return out;
  }

  const files = await walkJsonl(config.codexSessionsDir);
  await Promise.all(
    files.map(async (full) => {
      try {
        const [st, start] = await Promise.all([fsp.stat(full), readStart(full)]);
        const id = start.match(/"type":"session_meta","payload":\{"id":"([^"]+)"/)?.[1];
        if (!id) return;
        const foundCwd = start.match(/"cwd":"([^"]+)"/)?.[1]?.replace(/\\\//g, '/');
        if (foundCwd !== cwd) return;
        out.set(id, { id, transcript: full, mtimeMs: st.mtimeMs });
      } catch {
        /* skip unreadable or racing files */
      }
    })
  );
  return out;
}

async function discoverNewSession(agent, cwd, baseline, startedAt) {
  const sessions = await agentSessionsInDirectory(agent, cwd);
  const candidates = [...sessions.values()]
    .filter((s) => !baseline.has(s.id) || s.mtimeMs > (baseline.get(s.id)?.mtimeMs || 0) + 100)
    .filter((s) => s.mtimeMs >= startedAt - 3000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function listDirs(root, max = 2500) {
  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && out.length < max) {
    const { dir, depth } = queue.shift();
    if (depth > 4) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries = entries
      .filter((e) => e.isDirectory() && !['.git', 'node_modules', 'vendor', 'dist', 'build'].includes(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      out.push(full);
      if (out.length >= max) return out;
      queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return out;
}

function prettyHome(p) {
  return p === config.home ? '~' : p.startsWith(config.home + path.sep) ? `~/${p.slice(config.home.length + 1)}` : p;
}

function fuzzyDirScore(display, q) {
  const hay = display.toLowerCase();
  const raw = q.toLowerCase().replace(/^~\/?/, '');
  const tokens = raw.split(/[^a-z0-9._-]+/).filter(Boolean);
  if (tokens.length === 0) return display === '~/dev' ? 100 : 10;
  let score = 0;
  for (const tok of tokens) {
    const i = hay.indexOf(tok);
    if (i < 0) return -1;
    score += Math.max(1, 80 - i);
  }
  return score - display.length / 100;
}

export async function suggestDirectories(q = '') {
  const root = path.join(config.home, 'dev');
  const resolvedRoot = assertDirectoryAllowed(root);
  const dirs = [resolvedRoot, ...(await listDirs(resolvedRoot))];
  const items = dirs
    .map((p) => ({ path: p, display: prettyHome(p), score: fuzzyDirScore(prettyHome(p), q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.display.localeCompare(b.display))
    .slice(0, 20)
    .map(({ path: p, display }) => ({ path: p, display }));
  return { root: prettyHome(resolvedRoot), items };
}

/**
 * Validate a terminal request and mint a ticket. Throws with `status`/`code` on every rejection.
 */
export async function preflight(spec) {
  const { scope, kind, filename, sessionId, cols, rows } = spec || {};
  const agent = String(spec?.agent || 'claude').toLowerCase();

  if (!AGENTS.has(agent)) throw fail(400, 'BAD_AGENT', `unknown agent: ${agent}`);
  if (!sessionId || !UUID_RE.test(String(sessionId))) {
    throw fail(400, 'NO_SESSION', 'a valid session id is required to resume a session');
  }
  if (!['work', 'personal'].includes(scope)) throw fail(400, 'BAD_SCOPE', `unknown scope: ${scope}`);
  if (!['chore', 'learning'].includes(kind)) throw fail(400, 'BAD_KIND', `unknown kind: ${kind}`);
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    throw fail(400, 'BAD_FILENAME', 'invalid filename');
  }

  const cwd = assertDirectoryAllowed(spec.directory);

  // Without a transcript at the matching slug, `claude --resume` dies about a second after spawn
  // with nothing actionable on screen. Catch it here instead. Codex can resume from thread
  // history even when the local JSONL scanner cannot map the file, so treat that case leniently.
  const slug = slugForDirectory(cwd);
  const transcript = path.join(config.projectsDir, slug, `${sessionId}.jsonl`);
  const occupancy = await sessionOccupancy(agent, sessionId);
  const transcriptPath = agent === 'claude' ? transcript : occupancy.transcript;
  let transcriptMtimeMs = null;

  if (agent === 'claude' && !fs.existsSync(transcript)) {
    if (occupancy.projectSlug && occupancy.projectSlug !== slug) {
      throw fail(
        400,
        'SLUG_MISMATCH',
        `session ${sessionId} was last used from a different directory — its transcript lives under ${occupancy.projectSlug}, not ${slug}`
      );
    }
    throw fail(400, 'NO_TRANSCRIPT', `no transcript for session ${sessionId} under ${slug}`);
  }
  if (transcriptPath) {
    try {
      transcriptMtimeMs = fs.statSync(transcriptPath).mtimeMs;
    } catch {
      transcriptMtimeMs = null;
    }
  }

  const key = sessionKey(agent, sessionId);
  if (bySession.has(key)) {
    throw fail(409, 'ALREADY_OPEN_HERE', 'this session already has a terminal open on the board', {
      terminalId: bySession.get(key),
    });
  }
  if (occupancy.resumedPid) {
    throw fail(
      409,
      'ALREADY_LIVE',
      `${agent} session is already running in another terminal (pid ${occupancy.resumedPid}) — resuming it twice would interleave one transcript`
    );
  }
  // Pending reservations count toward the cap too, or N rapid preflights all pass.
  if (registry.size + reservations.size >= config.maxTerminals) {
    throw fail(429, 'LIMIT', `at most ${config.maxTerminals} terminals can be open at once`);
  }

  // The weak signal: some agent session is live in this directory, but possibly a *different* session
  // (three of the current work chores share one directory). Warn, do not block.
  const warnings = [];
  if (occupancy.slugBusy) {
    warnings.push({
      code: 'MAYBE_LIVE',
      message: `another ${agent} session appears to be running in ${cwd}. This is a directory-level guess, not this session.`,
    });
  }

  const terminalId = `t_${crypto.randomBytes(8).toString('hex')}`;
  const ticket = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + config.ticketTtlMs;
  reservations.set(terminalId, { key, sessionId, expiresAt });
  bySession.set(key, terminalId); // hold the session from the moment we promise it
  tickets.set(ticket, {
    terminalId,
    expiresAt,
    spec: {
      scope,
      kind,
      agent,
      filename,
      sessionId,
      cwd,
      cols: clamp(cols, 20, 500, 120),
      rows: clamp(rows, 5, 200, 32),
      transcriptPath,
      transcriptMtimeMs,
    },
  });

  return { terminalId, ticket, agent, sessionId, cwd, warnings };
}

export async function preflightNew(spec) {
  const scope = String(spec?.scope || '').toLowerCase();
  const agent = String(spec?.agent || 'codex').toLowerCase();
  const newKind = String(spec?.newKind || 'learning').toLowerCase();

  if (!AGENTS.has(agent)) throw fail(400, 'BAD_AGENT', `unknown agent: ${agent}`);
  if (!['work', 'personal'].includes(scope)) throw fail(400, 'BAD_SCOPE', `unknown scope: ${scope}`);
  if (!['learning', 'chore'].includes(newKind)) throw fail(400, 'BAD_NEW_KIND', `unknown new session kind: ${newKind}`);

  const requestedDirectory =
    scope === 'personal' ? path.join(config.home, 'dev', 'learning-shit') : spec?.directory;
  const cwd = assertDirectoryAllowed(requestedDirectory);
  const learningTitle = String(spec?.learningTitle || '').trim().slice(0, 160);
  const choreTitle = String(spec?.choreTitle || '').trim().slice(0, 160);
  const choreDescription = String(spec?.choreDescription || '').trim().slice(0, 2000);
  const requestedFilename = String(spec?.filename || '').trim();
  const existingFilename =
    requestedFilename && path.basename(requestedFilename) === requestedFilename
      ? requestedFilename
      : '';
  if (requestedFilename && !existingFilename) {
    throw fail(400, 'BAD_FILENAME', 'invalid filename');
  }

  if (newKind === 'chore' && !existingFilename) {
    if (!choreTitle) throw fail(400, 'CHORE_TITLE_REQUIRED', 'chore title is required');
    if (!choreDescription) throw fail(400, 'CHORE_DESCRIPTION_REQUIRED', 'chore description is required');
  }

  if (registry.size + reservations.size >= config.maxTerminals) {
    throw fail(429, 'LIMIT', `at most ${config.maxTerminals} terminals can be open at once`);
  }

  const warnings = [];
  let existingPath = null;
  if (existingFilename) {
    existingPath = safeJoin(newKind === 'chore' ? choreDir(scope) : scopeDir(scope), existingFilename);
    try {
      await fsp.access(existingPath);
    } catch {
      throw fail(404, 'FILE_NOT_FOUND', `file not found: ${existingFilename}`);
    }
  }

  const pendingChore =
    newKind === 'chore' && !existingFilename
      ? await createPendingChore({
          scope,
          agent,
          directory: cwd,
          title: choreTitle,
          description: choreDescription,
        })
      : null;

  const terminalId = `t_${crypto.randomBytes(8).toString('hex')}`;
  const ticket = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + config.ticketTtlMs;
  const baseline = await agentSessionsInDirectory(agent, cwd);
  reservations.set(terminalId, { key: null, sessionId: null, expiresAt });
  tickets.set(ticket, {
    terminalId,
    expiresAt,
    spec: {
      scope,
      kind: 'new',
      newKind,
      agent,
      filename: existingFilename || pendingChore?.filename || '',
      sessionId: null,
      cwd,
      cols: clamp(spec?.cols, 20, 500, 120),
      rows: clamp(spec?.rows, 5, 200, 32),
      transcriptPath: null,
      transcriptMtimeMs: null,
      newSessionBaseline: baseline,
      learningTitle: existingFilename && newKind === 'learning' ? '' : learningTitle,
      choreTitle,
      choreDescription,
      chorePath: existingFilename && newKind === 'chore' ? existingPath : pendingChore?.path || null,
      learningPath: existingFilename && newKind === 'learning' ? existingPath : null,
      autoInput:
        existingFilename && newKind === 'chore'
          ? resumeChoreCommand(agent, existingPath)
          : existingFilename && newKind === 'learning'
            ? resumeLearningCommand(agent, existingPath)
            : newKind === 'chore'
              ? startupChoreCommand(agent, scope, choreTitle, choreDescription, pendingChore?.path)
              : null,
      startedAt: Date.now(),
    },
  });

  return {
    terminalId,
    ticket,
    agent,
    sessionId: null,
    cwd,
    filename: existingFilename || pendingChore?.filename || null,
    filePath: existingPath || pendingChore?.path || null,
    warnings,
  };
}

/** Redeem a ticket. Single use, short TTL — a replay must fail. */
export function redeemTicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt < Date.now()) {
    releaseReservation(entry.terminalId);
    return null;
  }
  // Attach happens immediately after; give it a moment before the sweeper could reclaim it.
  const r = reservations.get(entry.terminalId);
  if (r) r.expiresAt = Date.now() + 10_000;
  return entry;
}

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

// --- agent activity (busy vs waiting-for-you) --------------------------------------------------
// ~/.claude/hooks/claude-notifier-on-*.js already write every Stop/UserPromptSubmit/
// PermissionRequest/AskUserQuestion event — for Claude and Codex alike — to one shared signal
// file as "<reason> <ts> <sessionId> ...". We tail that instead of inventing a second notifier:
// "prompt" means the agent just started working, "done"/"input"/"question" mean it is blocked on
// the human again. "subagent_done" fires mid-turn (the main agent is still working) so it is
// deliberately not in either set.
const AGENT_BUSY_REASONS = new Set(['prompt']);
const AGENT_IDLE_REASONS = new Set(['done', 'input', 'question']);

function parseAgentSignal(raw) {
  const [reason, , sessionId] = String(raw).trim().split(/\s+/);
  return { reason, sessionId: sessionId && sessionId !== '-' ? sessionId : null };
}

function agentStateForReason(reason) {
  if (AGENT_BUSY_REASONS.has(reason)) return 'busy';
  if (AGENT_IDLE_REASONS.has(reason)) return 'idle';
  return null;
}

/** Push a state onto every open terminal (Claude or Codex) resuming this session id, if any. */
function applyAgentState(sessionId, state) {
  const sid = String(sessionId).toLowerCase();
  for (const agent of AGENTS) {
    const terminalId = bySession.get(sessionKey(agent, sid));
    const rec = terminalId && registry.get(terminalId);
    if (!rec || rec.agentState === state) continue;
    rec.agentState = state;
    send(rec.ws, { t: 'agent-state', state });
  }
}

// A resumed/attached terminal is a *freshly spawned* process — even if the session id has a long
// history elsewhere, this particular pty has done nothing yet, so it always starts 'idle'
// (see the `agentState: 'idle'` literal at rec creation below). Only a live signal for this exact
// terminal's session, from here on, ever moves it to 'busy'.
let lastAgentSignalRaw = null;
function handleAgentSignalChange() {
  let raw;
  try {
    raw = fs.readFileSync(config.agentSignalFile, 'utf8');
  } catch {
    return;
  }
  if (raw === lastAgentSignalRaw) return;
  lastAgentSignalRaw = raw;
  const { reason, sessionId } = parseAgentSignal(raw);
  const state = reason && agentStateForReason(reason);
  if (!state || !sessionId) return;
  applyAgentState(sessionId, state);
}

// Best-effort: older deployments or a fresh machine may not have the notifier hooks installed at
// all, and that must not stop terminals from working — busy/waiting just stays at its default.
try {
  fs.watch(config.agentSignalFile, { persistent: false }, handleAgentSignalChange).unref?.();
} catch {
  /* no signal file on this machine */
}

/**
 * Spawn the pty for a redeemed ticket and wire it to the socket.
 * PTY output goes over **binary** frames: JSON-wrapping it would split multi-byte UTF-8 across
 * chunk boundaries, and the agent TUI is wall-to-wall box-drawing.
 */
export function attach(ws, entry) {
  const { terminalId, spec } = entry;
  const {
    scope,
    kind,
    agent,
    filename,
    sessionId,
    cwd,
    cols,
    rows,
    transcriptPath,
    transcriptMtimeMs,
    newKind,
    newSessionBaseline,
    learningTitle,
    choreTitle,
    choreDescription,
    chorePath,
    learningPath,
    autoInput,
    startedAt,
  } = spec;

  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  env.LANG = env.LANG || 'en_US.UTF-8';
  // `node --watch` and npm scripts leak these into children and confuse anything that itself
  // runs node tooling.
  delete env.NODE_OPTIONS;
  delete env.NODE_ENV;
  for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];

  let child;
  try {
    // argv array, never a shell: the session id is regex-validated and nothing else reaches argv.
    const cmd = kind === 'new' ? commandForNew(agent) : commandForResume(agent, sessionId);
    child = pty.spawn(cmd.bin, cmd.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      encoding: null, // Buffers, not strings — see above
    });
  } catch (err) {
    releaseReservation(terminalId); // never hold a session we failed to start
    send(ws, { t: 'error', code: 'SPAWN_FAILED', message: err.message, fatal: true });
    ws.close(1011, 'spawn failed');
    return;
  }

  const rec = {
    terminalId,
    child,
    ws,
    scope,
    kind,
    agent,
    filename,
    sessionId,
    cwd,
    closing: false,
    watcher: null,
    statTimer: null,
    transcriptTimer: null,
    idleTimer: null,
    lastActivity: Date.now(),
    lastPtyDataAt: Date.now(),
    transcriptPath,
    transcriptMtimeMs,
    transcriptWarned: false,
    newKind: newKind || null,
    newSessionBaseline,
    learningTitle,
    choreTitle,
    choreDescription,
    chorePath,
    learningPath,
    autoInput,
    autoInputSent: false,
    discovered: kind !== 'new',
    learningFile: null,
    choreFile: newKind === 'chore' ? filename : null,
    draftCreating: false,
    firstInput: '',
    inputLine: '',
    discoveryTimer: null,
    // Always starts 'idle' — a freshly spawned pty hasn't done anything yet regardless of what
    // this session id was doing elsewhere in the past. Only a live signal moves it to 'busy'.
    agentState: 'idle',
  };
  registry.set(terminalId, rec);
  reservations.delete(terminalId); // the registry owns the session hold from here
  if (sessionId) bySession.set(sessionKey(agent, sessionId), terminalId);
  markOwnedPid(child.pid);
  recordForReaper();

  const cmd = kind === 'new' ? commandForNew(agent) : commandForResume(agent, sessionId);
  send(ws, {
    t: 'ready',
    terminalId,
    agent,
    sessionId,
    cwd,
    pid: child.pid,
    cols,
    rows,
    argv: [cmd.bin, ...cmd.args],
  });
  send(ws, { t: 'agent-state', state: rec.agentState });

  if (kind === 'new') watchNewSession(rec, Number(startedAt || Date.now()));
  if (kind === 'new' && newKind === 'chore' && filename) {
    watchChore(rec);
    send(ws, {
      t: 'chore-created',
      scope,
      filename,
      path: chorePath,
      title: choreTitle,
    });
    sendAutoInput(rec);
  }
  if (kind === 'chore' && filename) {
    rec.chorePath = path.join(choreDir(scope), filename);
    rec.autoInput = resumeChoreCommand(agent, rec.chorePath);
    sendAutoInput(rec);
  }

  child.onData((data) => {
    if (ws.readyState !== 1) return;
    rec.lastPtyDataAt = Date.now();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    ws.send(buf);
    // Backpressure: a runaway command inside the session can outrun the browser.
    if (ws.bufferedAmount > MAX_BUFFERED && !rec.paused) {
      rec.paused = true;
      try {
        child.pause();
      } catch {
        /* older node-pty without pause() */
      }
      const drain = setInterval(() => {
        if (ws.readyState !== 1 || ws.bufferedAmount <= MAX_BUFFERED / 2) {
          clearInterval(drain);
          rec.paused = false;
          try {
            child.resume();
          } catch {
            /* ignore */
          }
        }
      }, 50);
    }
    if (
      rec.kind === 'new' &&
      rec.newKind === 'learning' &&
      rec.firstInput &&
      rec.discovered &&
      !rec.learningFile
    ) {
      setTimeout(() => ensureDraftLearning(rec, 'first-response').catch(() => {}), 1500).unref?.();
    }
  });

  child.onExit(({ exitCode, signal }) => {
    send(ws, { t: 'exit', code: exitCode, signal: signal ?? null, reason: 'process-exit' });
    // Do NOT close inside onExit — trailing output may still be buffered, and closing here
    // truncates the last screen. Wait for the socket to drain.
    const closeWhenDrained = setInterval(() => {
      if (ws.readyState !== 1 || ws.bufferedAmount === 0) {
        clearInterval(closeWhenDrained);
        cleanup(terminalId, 'process-exit');
        if (ws.readyState === 1) ws.close(1000, 'process exited');
      }
    }, 30);
    setTimeout(() => clearInterval(closeWhenDrained), 5000).unref?.();
  });

  ws.on('message', (raw, isBinary) => {
    rec.lastActivity = Date.now();
    if (isBinary) return; // client never sends binary
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      captureFirstInput(rec, msg.d);
      child.write(msg.d);
    } else if (msg.t === 'resize') {
      try {
        child.resize(clamp(msg.cols, 20, 500, cols), clamp(msg.rows, 5, 200, rows));
      } catch {
        /* pty already gone */
      }
    } else if (msg.t === 'ping') {
      send(ws, { t: 'pong', ts: msg.ts });
    } else if (msg.t === 'kill') {
      cleanup(terminalId, 'client-close');
    }
  });

  ws.on('close', () => cleanup(terminalId, 'client-close'));
  ws.on('error', () => cleanup(terminalId, 'socket-error'));

  // Idle reaper — a forgotten tab should not hold an agent session open forever.
  rec.idleTimer = setInterval(() => {
    if (Date.now() - rec.lastActivity > config.terminalIdleMs) {
      send(ws, { t: 'exit', code: null, signal: null, reason: 'idle-timeout' });
      cleanup(terminalId, 'idle-timeout');
    }
  }, 60_000);
  rec.idleTimer.unref?.();

  if (kind === 'chore') watchChore(rec);
  watchTranscript(rec);
}

function captureFirstInput(rec, chunk) {
  if (rec.kind !== 'new' || rec.newKind !== 'learning' || rec.firstInput) return;
  for (const ch of String(chunk)) {
    if (ch === '\r' || ch === '\n') {
      const line = rec.inputLine.trim();
      rec.inputLine = '';
      if (line) {
        rec.firstInput = line;
        if (rec.learningFile) {
          fillDraftInitialPrompt(rec.scope, rec.learningFile, rec.firstInput).catch(() => {});
        }
      }
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      rec.inputLine = rec.inputLine.slice(0, -1);
      continue;
    }
    if (ch >= ' ' && ch !== '\x1b') rec.inputLine += ch;
  }
}

async function ensureDraftLearning(rec, reason) {
  if (
    rec.kind !== 'new' ||
    rec.newKind !== 'learning' ||
    rec.learningFile ||
    rec.draftCreating ||
    !rec.sessionId
  ) {
    return null;
  }
  if (!rec.filename && !rec.learningTitle && !rec.firstInput) return null;
  rec.draftCreating = true;
  try {
    if (rec.filename) {
      const draft = await bindLearningSession({
        scope: rec.scope,
        filename: rec.filename,
        agent: rec.agent,
        sessionId: rec.sessionId,
        directory: rec.cwd,
      });
      rec.learningFile = draft.filename;
      send(rec.ws, {
        t: 'learning-created',
        scope: rec.scope,
        filename: draft.filename,
        path: draft.path,
        title: draft.title,
      });
      return draft;
    }
    const draft = await createDraftLearning({
      scope: rec.scope,
      agent: rec.agent,
      sessionId: rec.sessionId,
      directory: rec.cwd,
      title: rec.learningTitle,
      initialPrompt: rec.firstInput,
      reason,
    });
    rec.learningFile = draft.filename;
    send(rec.ws, {
      t: 'learning-created',
      scope: rec.scope,
      filename: draft.filename,
      path: draft.path,
      title: draft.title,
    });
    return draft;
  } catch (err) {
    send(rec.ws, {
      t: 'warning',
      code: 'LEARNING_DRAFT_FAILED',
      message: `Could not create standing handoff file: ${err.message}`,
    });
    return null;
  } finally {
    rec.draftCreating = false;
  }
}

async function ensureDraftChore(rec) {
  if (
    rec.kind !== 'new' ||
    rec.newKind !== 'chore' ||
    rec.draftCreating ||
    !rec.sessionId ||
    !rec.choreFile
  ) {
    return null;
  }
  rec.draftCreating = true;
  try {
    const draft = await bindChoreSession({
      scope: rec.scope,
      filename: rec.choreFile,
      agent: rec.agent,
      sessionId: rec.sessionId,
      directory: rec.cwd,
      title: rec.choreTitle,
      description: rec.choreDescription,
    });
    rec.filename = draft.filename;
    send(rec.ws, { t: 'chore-bound', scope: rec.scope, filename: draft.filename });
    return draft;
  } catch (err) {
    send(rec.ws, {
      t: 'warning',
      code: 'CHORE_DRAFT_FAILED',
      message: `Could not create chore file: ${err.message}`,
    });
    return null;
  } finally {
    rec.draftCreating = false;
  }
}

function sendAutoInput(rec) {
  if (!rec.autoInput || rec.autoInputSent) return;
  rec.autoInputSent = true;
  setTimeout(() => {
    if (rec.closing) return;
    try {
      rec.child.write(rec.autoInput);
    } catch {
      /* pty already gone */
    }
  }, 300).unref?.();
}

function watchNewSession(rec, startedAt) {
  let polling = false;
  rec.discoveryTimer = setInterval(async () => {
    if (rec.closing || rec.discovered || polling) return;
    polling = true;
    try {
      const found = await discoverNewSession(
        rec.agent,
        rec.cwd,
        rec.newSessionBaseline || new Map(),
        startedAt
      );
      if (!found) return;
      rec.discovered = true;
      clearInterval(rec.discoveryTimer);
      rec.discoveryTimer = null;
      rec.sessionId = found.id;
      rec.transcriptPath = found.transcript;
      rec.transcriptMtimeMs = found.mtimeMs;
      bySession.set(sessionKey(rec.agent, rec.sessionId), rec.terminalId);
      recordForReaper();
      send(rec.ws, {
        t: 'session-ready',
        agent: rec.agent,
        sessionId: rec.sessionId,
        transcript: rec.transcriptPath,
      });
      if (rec.newKind === 'learning' && (rec.filename || rec.learningTitle)) {
        await ensureDraftLearning(rec, 'title');
        sendAutoInput(rec);
      } else if (rec.newKind === 'chore') {
        await ensureDraftChore(rec);
        sendAutoInput(rec);
      }
    } finally {
      polling = false;
    }
  }, 1000);
  rec.discoveryTimer.unref?.();
}

function watchTranscript(rec) {
  if (!rec.transcriptPath || !rec.transcriptMtimeMs) return;

  let baseline = rec.transcriptMtimeMs;
  rec.transcriptTimer = setInterval(async () => {
    if (rec.closing) return;
    let stat;
    try {
      stat = await fsp.stat(rec.transcriptPath);
    } catch {
      return;
    }
    if (stat.mtimeMs <= baseline + 100) return;

    const idleFor = Date.now() - rec.lastPtyDataAt;
    if (idleFor >= TRANSCRIPT_DRIFT_IDLE_MS && !rec.transcriptWarned) {
      rec.transcriptWarned = true;
      send(rec.ws, {
        t: 'transcript-drift',
        code: 'TRANSCRIPT_DRIFT',
        message:
          'This session transcript changed while the board terminal was idle. If you resumed it locally, close and reopen this terminal to attach to the newer state.',
        transcriptMtime: new Date(stat.mtimeMs).toISOString(),
      });
    }
    baseline = stat.mtimeMs;
  }, TRANSCRIPT_DRIFT_POLL_MS);
  rec.transcriptTimer.unref?.();
}

/**
 * Watch for the chore file disappearing — that, not anything the user typed, is the honest signal
 * that `/end-chore` actually completed. (`/end-chore` is conversational: it asks which chore when
 * the session id doesn't match a row, asks again if work is still pending, and offers `/handoff`
 * first. Inferring the outcome from keystrokes would be wrong more often than right.)
 *
 * Watches the *directory*: on macOS a watch on a file stops delivering events once it is unlinked.
 * Chore files are rewritten constantly as the agent works, so only a failed access counts.
 */
function watchChore(rec) {
  let dir;
  try {
    dir = choreDir(rec.scope);
  } catch {
    return;
  }
  const full = path.join(dir, rec.filename);
  let gone = false;

  const check = async () => {
    if (rec.closing) return;
    let exists = true;
    try {
      await fsp.access(full);
    } catch {
      exists = false;
    }
    if (!exists && !gone) {
      gone = true;
      send(rec.ws, { t: 'chore-gone', scope: rec.scope, filename: rec.filename, at: Date.now() });
    } else if (exists && gone) {
      gone = false;
      send(rec.ws, { t: 'chore-back', scope: rec.scope, filename: rec.filename });
    }
  };

  let debounce;
  try {
    rec.watcher = fs.watch(dir, () => {
      clearTimeout(debounce);
      debounce = setTimeout(check, 250);
    });
  } catch {
    /* fs.watch unavailable — the poll below is the backstop */
  }
  // fs.watch is unreliable (kqueue limits, network volumes, atomic-rename writes). One stat every
  // 3s costs nothing at this scale and is what actually guarantees correctness.
  rec.statTimer = setInterval(check, 3000);
  rec.statTimer.unref?.();
}

/** Terminate the pty and drop every timer/watcher for a terminal. Idempotent. */
export function cleanup(terminalId, reason = 'server-shutdown') {
  const rec = registry.get(terminalId);
  if (!rec || rec.closing) return;
  rec.closing = true;

  clearInterval(rec.statTimer);
  clearInterval(rec.transcriptTimer);
  clearInterval(rec.idleTimer);
  clearInterval(rec.discoveryTimer);
  try {
    rec.watcher?.close();
  } catch {
    /* ignore */
  }

  const pid = rec.child?.pid;
  try {
    rec.child.kill('SIGHUP'); // interactive agents exit cleanly on SIGHUP in normal terminal use
  } catch {
    /* already gone */
  }
  if (pid > 0) {
    setTimeout(() => {
      try {
        // Negative pid = the whole process group, which reaps the agent's own children
        // (Bash tool, MCP servers) rather than orphaning them.
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* ESRCH: already reaped */
      }
    }, KILL_GRACE_MS).unref?.();
  }

  registry.delete(terminalId);
  reservations.delete(terminalId);
  if (rec.sessionId) {
    const key = sessionKey(rec.agent, rec.sessionId);
    if (bySession.get(key) === terminalId) bySession.delete(key);
  }
  if (pid) unmarkOwnedPid(pid);
  recordForReaper();

  if (rec.ws?.readyState === 1) rec.ws.close(1000, reason);
}

export function shutdownAll(reason = 'server-shutdown') {
  for (const id of [...registry.keys()]) cleanup(id, reason);
}

export const terminalSnapshot = () => ({
  open: registry.size,
  max: config.maxTerminals,
  sessions: [...bySession.keys()],
});

// --- orphan reaping ---------------------------------------------------------------------------
// Closing the pty master delivers SIGHUP to the child, so a clean server exit already reaps its
// terminals. This covers SIGKILL and hard crashes, where no handler runs at all.

function recordForReaper() {
  const rows = [...registry.values()].map((r) => ({
    pid: r.child?.pid,
    agent: r.agent,
    sessionId: r.sessionId || null,
    startedAt: Date.now(),
  }));
  try {
    fs.mkdirSync(path.dirname(REAPER_FILE), { recursive: true });
    fs.writeFileSync(REAPER_FILE, JSON.stringify(rows), 'utf8');
  } catch {
    /* best effort */
  }
}

/**
 * Kill terminals left behind by a previous server process — but only after confirming the pid's
 * argv still names that session. Skipping that check is how reapers turn into "why did my editor
 * just die" bugs after a pid gets recycled.
 */
export async function reapOrphans(execFileAsync) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(REAPER_FILE, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let killed = 0;
  for (const row of rows) {
    if (!row?.pid || !row?.sessionId) continue;
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'args=', '-p', String(row.pid)]);
      if (!stdout.includes(row.sessionId)) continue; // pid recycled — leave it alone
      process.kill(-row.pid, 'SIGKILL');
      killed++;
    } catch {
      /* not running, or not ours */
    }
  }
  try {
    fs.writeFileSync(REAPER_FILE, '[]', 'utf8');
  } catch {
    /* ignore */
  }
  return killed;
}
