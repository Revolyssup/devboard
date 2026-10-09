import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { findSymbolLine } from './codont.js';

const execFileP = promisify(execFile);

/**
 * Design documents: Ashish's prose on the left, and the facts / flags / targets the session's agent
 * derives from it on the right.
 *
 * Contract: ~/.agents/specs/design-facts.md. Three things are enforced HERE rather than left to the
 * agent's good behaviour, because each is a place where an agent would quietly cheat:
 *
 *   1. Every source fragment an item cites must actually be in the prose. An item that quotes text
 *      Ashish never wrote is refused.
 *   2. verify.sh is run by this server, never reported by the agent. The exit code is the result.
 *   3. A target's script is frozen once it has failed on base, and a target can only become a fact
 *      when the SAME script (by hash) failed on base and passed on the branch.
 */

const KINDS = new Set(['fact', 'flag', 'target']);
const RUN_MODES = new Set(['normal', 'control', 'baseline']);
const RUN_TIMEOUT_MS = Number(process.env.DEVBOARD_DESIGN_RUN_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_FILE_BYTES = 512 * 1024;

const fail = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// --- keys --------------------------------------------------------------------------------------

/**
 * A design hangs off a learning or chore file. `ref` is the compact form the agent sees in the
 * terminal ("work/learning/2026-10-08-foo.md"); the UI sends the three fields.
 */
export function parseKey(src = {}) {
  let { scope, kind, filename } = src;
  if (src.ref && !(scope && kind && filename)) {
    const parts = String(src.ref).split('/');
    if (parts.length !== 3) throw fail(400, `ref must look like <scope>/<kind>/<file.md>, got '${src.ref}'`);
    [scope, kind, filename] = parts;
  }
  scope = String(scope || '');
  kind = String(kind || '');
  filename = String(filename || '');
  if (!['work', 'personal'].includes(scope)) throw fail(400, `scope must be work|personal, got '${scope}'`);
  if (!['learning', 'chore'].includes(kind)) throw fail(400, `kind must be learning|chore, got '${kind}'`);
  if (!filename.endsWith('.md') || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
    throw fail(400, `bad filename '${filename}'`);
  }
  return { scope, kind, filename };
}

export const keyRef = (k) => `${k.scope}/${k.kind}/${k.filename}`;

function baseDirFor(key) {
  if (key.kind === 'learning') return key.scope === 'work' ? config.workLearningsDir : config.personalLearningsDir;
  return key.scope === 'work' ? config.workChoresDir : config.personalChoresDir;
}

export function designDir(key) {
  return path.join(baseDirFor(key), `${key.filename.replace(/\.md$/, '')}.design`);
}

const P = (key) => {
  const root = designDir(key);
  return {
    root,
    binding: path.join(root, 'binding.json'),
    doc: path.join(root, 'design.md'),
    journal: path.join(root, 'journal.md'),
    items: path.join(root, 'items'),
    removed: path.join(root, 'removed'),
    item: (n) => path.join(root, 'items', String(n)),
  };
};

// --- bindings ----------------------------------------------------------------------------------

export function getBinding(key) {
  return readJson(P(key).binding);
}

function requireBinding(key) {
  const b = getBinding(key);
  if (!b) throw fail(404, `no design for ${keyRef(key)} — open it from devboard first`);
  return b;
}

function saveBinding(key, b) {
  writeJson(P(key).binding, b);
}

/** Opening the Design view creates the construct. Idempotent; `repo` only fills in when unset. */
export function ensureDesign(key, { repo } = {}) {
  const p = P(key);
  const existing = getBinding(key);
  if (existing) {
    if (!existing.repo && repo) {
      existing.repo = realDir(repo);
      saveBinding(key, existing);
    }
    return existing;
  }
  if (!fs.existsSync(path.join(baseDirFor(key), key.filename))) {
    throw fail(404, `${keyRef(key)} does not exist`);
  }
  const b = {
    ...key,
    repo: repo ? realDir(repo) : null,
    nextId: 1,
    request: null,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(p.items, { recursive: true });
  if (!fs.existsSync(p.doc)) fs.writeFileSync(p.doc, '');
  if (!fs.existsSync(p.journal)) fs.writeFileSync(p.journal, '');
  saveBinding(key, b);
  return b;
}

function realDir(dir) {
  const expanded = String(dir).replace(/^~(?=\/|$)/, config.home);
  try {
    return fs.realpathSync(path.resolve(expanded));
  } catch {
    throw fail(400, `directory does not exist: ${dir}`);
  }
}

/** Every design on disk — drives whether a row's Design button is lit. Directory listing only. */
export function listDesigns() {
  const out = [];
  for (const scope of ['work', 'personal']) {
    for (const kind of ['learning', 'chore']) {
      const dir = baseDirFor({ scope, kind });
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.endsWith('.design')) continue;
        const b = readJson(path.join(dir, e.name, 'binding.json'));
        if (b) out.push({ scope, kind, filename: b.filename, ref: keyRef(b) });
      }
    }
  }
  return out;
}

// --- the prose ---------------------------------------------------------------------------------

export function readDoc(key) {
  return readText(P(key).doc);
}

/** The UI's autosave. The agent has no route to this by contract: the prose is Ashish's. */
export function writeDoc(key, content) {
  requireBinding(key);
  if (typeof content !== 'string') throw fail(400, 'content must be a string');
  fs.writeFileSync(P(key).doc, content);
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function sourceState(doc, quotes) {
  const d = norm(doc);
  const found = quotes.map((q) => d.includes(norm(q)));
  const n = found.filter(Boolean).length;
  return { state: n === quotes.length ? 'ok' : n === 0 ? 'gone' : 'changed', found };
}

// --- journal -----------------------------------------------------------------------------------

function journal(key, line) {
  fs.appendFileSync(P(key).journal, `- ${new Date().toISOString()} ${line}\n`);
}

export function readJournal(key) {
  return readText(P(key).journal);
}

// --- git helpers -------------------------------------------------------------------------------

async function git(repo, args) {
  const { stdout } = await execFileP('git', ['-C', repo, ...args], { maxBuffer: 16 << 20, timeout: 15_000 });
  return stdout;
}

async function resolveSha(repo, ref) {
  try {
    return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  } catch {
    throw fail(400, `unknown ref '${ref}' in ${repo}`);
  }
}

/**
 * Anchors are checked against the item's sha with `git show`, never the working tree: a fact is a
 * claim about one exact version. Symbols resolve to lines server-side so they cannot drift.
 */
async function verifyAnchors(item) {
  const results = [];
  const notes = [];
  const cache = new Map();
  const load = async (repo, rel) => {
    const k = `${repo}\0${rel}`;
    if (!cache.has(k)) {
      try {
        const text = await git(repo, ['show', `${item.sha}:${rel}`]);
        cache.set(k, { text, lines: text.split('\n').length });
      } catch {
        cache.set(k, { err: `does not exist at ${String(item.sha).slice(0, 10)}` });
      }
    }
    return cache.get(k);
  };
  for (const a of item.anchors) {
    const repo = a.repo || item.repo;
    if (!repo || !item.sha) {
      results.push({ ok: false, error: 'item has no repo/sha to check this anchor against' });
      continue;
    }
    const r = await load(repo, a.path);
    if (r.err) {
      results.push({ ok: false, error: `${a.path}: ${r.err}` });
      continue;
    }
    if (a.symbol) {
      const found = findSymbolLine(r.text, a.symbol);
      if (found && a.line && found !== a.line) notes.push(`${a.path}: '${a.symbol}' is at ${found}, not ${a.line}`);
      if (found) {
        if (a.endLine && a.line) a.endLine = found + (a.endLine - a.line);
        a.line = found;
      } else if (!a.line) {
        results.push({ ok: false, error: `${a.path}: symbol '${a.symbol}' not found` });
        continue;
      }
    }
    if (!a.line || a.line < 1 || a.line > r.lines) {
      results.push({ ok: false, error: `${a.path} has ${r.lines} lines; anchor says ${a.line}` });
      continue;
    }
    if (a.endLine && (a.endLine < a.line || a.endLine > r.lines)) a.endLine = Math.min(Math.max(a.line, a.endLine), r.lines);
    results.push({ ok: true });
  }
  return { results, notes };
}

// --- items -------------------------------------------------------------------------------------

function readItem(key, n) {
  return readJson(path.join(P(key).item(n), 'item.json'));
}

function requireItem(key, n) {
  const item = readItem(key, n);
  if (!item) throw fail(404, `no item #${n} in ${keyRef(key)}`);
  return item;
}

function saveItem(key, item) {
  item.updatedAt = new Date().toISOString();
  writeJson(path.join(P(key).item(item.n), 'item.json'), item);
}

export const label = (item) => `${{ fact: 'F', flag: 'X', target: 'T' }[item.kind] || '?'}-${item.n}`;

/** "F-7", "X-7", "T-7" and "7" all mean item 7 — the number is stable, the letter is the kind. */
export function parseItemRef(ref) {
  const m = String(ref ?? '').trim().match(/^(?:[FXT?]-?)?(\d+)$/i);
  if (!m) throw fail(400, `bad item reference '${ref}' — use e.g. F-7`);
  return Number(m[1]);
}

function normalizeAnchors(anchors, where) {
  if (anchors === undefined) return undefined;
  if (!Array.isArray(anchors)) throw fail(400, `${where}: anchors must be an array`);
  return anchors.map((a, i) => {
    if (!a || !a.path) throw fail(400, `${where}: anchors[${i}].path is required`);
    if (!a.line && !a.symbol) throw fail(400, `${where}: anchors[${i}] needs a line or a symbol`);
    const out = { path: String(a.path) };
    if (a.line) out.line = Number(a.line);
    if (a.endLine) out.endLine = Number(a.endLine);
    if (a.symbol) out.symbol = String(a.symbol);
    if (a.repo) out.repo = realDir(a.repo);
    if (a.note) out.note = String(a.note);
    return out;
  });
}

/** Fill sha from branch, check anchors and a prototype diff. Mutates and returns notes. */
async function settleCode(item) {
  const notes = [];
  if (item.repo && item.branch && !item.sha) item.sha = await resolveSha(item.repo, item.branch);
  if (item.repo && item.sha && !/^[0-9a-f]{40}$/.test(item.sha)) item.sha = await resolveSha(item.repo, item.sha);
  if (item.anchors?.length) {
    const v = await verifyAnchors(item);
    item.verification = { anchors: v.results };
    notes.push(...v.notes);
  } else {
    item.verification = { anchors: [] };
  }
  if (item.code?.diff) {
    const { base, head } = item.code.diff;
    if (!item.repo) throw fail(400, 'code.diff needs the item to have a repo');
    item.code.diff = { base: await resolveSha(item.repo, base), head: await resolveSha(item.repo, head) };
  }
  return notes;
}

function validateQuotes(doc, quotes, where) {
  if (!Array.isArray(quotes) || !quotes.length || quotes.some((q) => !norm(q))) {
    throw fail(400, `${where}: source.quotes must be a non-empty array of fragments copied from design.md`);
  }
  const s = sourceState(doc, quotes);
  const missing = quotes.filter((_, i) => !s.found[i]);
  if (missing.length) {
    throw fail(
      400,
      `${where}: these fragments are not in design.md (copy them verbatim; whitespace is ignored): ${missing
        .map((q) => JSON.stringify(q.slice(0, 80)))
        .join(', ')}`
    );
  }
}

/**
 * Create items — from Derive or /verify-fact. Quotes are checked against the prose right now;
 * an item that cites words Ashish didn't write is refused, not stored.
 */
export async function createItems(key, incoming, { note } = {}) {
  const binding = requireBinding(key);
  if (!Array.isArray(incoming) || !incoming.length) throw fail(400, 'items must be a non-empty array');
  const doc = readDoc(key);
  const prepared = [];
  for (let i = 0; i < incoming.length; i++) {
    const it = incoming[i] || {};
    const where = `items[${i}]`;
    if (!KINDS.has(it.kind)) throw fail(400, `${where}: kind must be fact|flag|target`);
    if (!norm(it.claim)) throw fail(400, `${where}: claim is required`);
    validateQuotes(doc, it.source?.quotes, where);
    if (binding.request?.action === 'derive' && binding.request.scope) {
      const sc = norm(binding.request.scope);
      if (!it.source.quotes.some((q) => sc.includes(norm(q)))) {
        throw fail(
          400,
          `${where}: this derive is limited to the selected prose (binding.request.scope); quote at least one fragment from inside it`
        );
      }
    }
    const item = {
      n: 0,
      kind: it.kind,
      kindBy: it.kindBy === 'human' ? 'human' : 'agent',
      claim: String(it.claim).trim(),
      explanation: it.explanation ? String(it.explanation) : '',
      source: { quotes: it.source.quotes.map(String) },
      repo: it.repo ? realDir(it.repo) : binding.repo,
      branch: it.branch ? String(it.branch) : null,
      sha: it.sha ? String(it.sha) : null,
      anchors: normalizeAnchors(it.anchors, where) || [],
      code: it.code?.diff ? { diff: { ...it.code.diff } } : null,
      frozen: null,
      request: null,
      createdAt: new Date().toISOString(),
    };
    if (item.kind !== 'target' && item.anchors.length && !(item.sha || item.branch)) {
      throw fail(400, `${where}: a fact/flag with anchors needs branch or sha`);
    }
    prepared.push(item);
  }
  const created = [];
  const notes = [];
  for (const item of prepared) {
    notes.push(...(await settleCode(item)));
  }
  const b = getBinding(key);
  for (const item of prepared) {
    item.n = b.nextId++;
    saveItem(key, item);
    created.push(item);
  }
  saveBinding(key, b);
  journal(key, `created ${created.map(label).join(', ')}${note ? ` — ${note}` : ''}`);
  return { created: created.map((it) => ({ id: label(it), n: it.n, verification: it.verification })), notes };
}

const PATCHABLE = new Set(['claim', 'explanation', 'kind', 'kindBy', 'source', 'repo', 'branch', 'sha', 'anchors', 'code', 'request']);

/**
 * The agent's edit path for one item. Promotion target→fact is the guarded transition: it needs a
 * baseline run that FAILED and a normal run that PASSED, both with the script as it is now.
 */
export async function updateItem(key, n, patch = {}, { note, by = 'agent' } = {}) {
  requireBinding(key);
  const item = requireItem(key, n);
  const before = label(item);
  for (const k of Object.keys(patch)) {
    if (!PATCHABLE.has(k)) throw fail(400, `cannot patch '${k}' (allowed: ${[...PATCHABLE].join(', ')})`);
  }
  if (patch.kind !== undefined) {
    if (!KINDS.has(patch.kind)) throw fail(400, 'kind must be fact|flag|target');
    // A flag is Ashish's disagreement with the code. The agent may only turn it into something
    // else while he has asked for that item to be re-derived.
    if (by === 'agent' && item.kind === 'flag' && patch.kind !== 'flag' && item.request?.action !== 'rederive') {
      throw fail(409, `${before} is a flag: it can only be reclassified during a re-derive Ashish asked for`);
    }
    if (by === 'agent' && item.kind === 'target' && patch.kind !== 'target') {
      if (misreadTarget(key, item)) {
        // Derive read a claim about NOW as a wish. Nothing was prototyped, so this is a
        // reclassification, not a promotion: it becomes an unverified fact/flag.
      } else if (patch.kind === 'fact') {
        const g = promotionGuard(key, item);
        if (!g.ok) throw fail(409, `cannot promote ${before} to a fact: ${g.why}`);
        item.promotedFrom = 'target';
        item.promotedAt = new Date().toISOString();
      } else {
        throw fail(409, `${before} has prototype work; it can only become a fact, through prototype`);
      }
    }
    item.kind = patch.kind;
    item.kindBy = by === 'human' ? 'human' : patch.kindBy === 'human' ? 'human' : item.kindBy;
  }
  if (patch.claim !== undefined) item.claim = String(patch.claim).trim();
  if (patch.explanation !== undefined) item.explanation = String(patch.explanation || '');
  if (patch.source !== undefined) {
    validateQuotes(readDoc(key), patch.source?.quotes, before);
    item.source = { quotes: patch.source.quotes.map(String) };
  }
  if (patch.repo !== undefined) item.repo = patch.repo ? realDir(patch.repo) : null;
  if (patch.branch !== undefined) {
    item.branch = patch.branch ? String(patch.branch) : null;
    if (patch.sha === undefined) item.sha = null; // re-resolve from the new branch
  }
  if (patch.sha !== undefined) item.sha = patch.sha ? String(patch.sha) : null;
  if (patch.anchors !== undefined) item.anchors = normalizeAnchors(patch.anchors, before) || [];
  if (patch.code !== undefined) item.code = patch.code?.diff ? { diff: { ...patch.code.diff } } : null;
  if (patch.request !== undefined) item.request = patch.request || null;
  const notes = await settleCode(item);
  saveItem(key, item);
  const after = label(item);
  const changed = Object.keys(patch).filter((k) => k !== 'request').join(', ') || 'request';
  journal(key, `${by} updated ${before}${after !== before ? ` → ${after}` : ''} (${changed})${note ? ` — ${note}` : ''}`);
  return { id: after, n: item.n, verification: item.verification, notes };
}

/** Human removal (✕ in the sidebar). Flags can't be removed this way — deleting the prose does it. */
export function removeItem(key, n) {
  const item = requireItem(key, n);
  if (item.kind === 'flag') throw fail(409, 'a flag goes away only when you delete its lines from the prose');
  const p = P(key);
  fs.mkdirSync(p.removed, { recursive: true });
  fs.renameSync(p.item(n), path.join(p.removed, `${n}-${Date.now()}`));
  journal(key, `human removed ${label(item)}`);
}

/**
 * The agent's way to drop an item, and only during a re-derive Ashish asked for: his edits may
 * have withdrawn or clarified the claim. Kept under removed/ with the reason, never deleted.
 */
export function retireItem(key, n, reason) {
  const item = requireItem(key, n);
  if (item.request?.action !== 'rederive') {
    throw fail(409, `${label(item)} can only be retired during a re-derive Ashish asked for`);
  }
  if (!norm(reason)) throw fail(400, 'retire needs a reason (what in the prose changed)');
  item.request = null;
  item.retired = { reason: String(reason), at: new Date().toISOString() };
  saveItem(key, item);
  const p = P(key);
  fs.mkdirSync(p.removed, { recursive: true });
  fs.renameSync(p.item(n), path.join(p.removed, `${n}-${Date.now()}`));
  journal(key, `agent retired ${label(item)} on re-derive — ${reason}`);
}

/** The spinner: set by the UI when it sends a command, cleared by the agent (or by hand). */
export function setRequest(key, n, request, { scope } = {}) {
  const b = requireBinding(key);
  const r = request ? { action: String(request), at: new Date().toISOString() } : null;
  if (n === null || n === undefined) {
    // A derive limited to what the user selected: the selected prose travels with the request.
    if (r && typeof scope === 'string' && norm(scope)) r.scope = scope;
    b.request = r;
    saveBinding(key, b);
    return;
  }
  const item = requireItem(key, n);
  item.request = r;
  saveItem(key, item);
}

// --- runs --------------------------------------------------------------------------------------

/** Hash of everything that defines the experiment: the script and its inputs. */
function scriptHash(key, n) {
  const dir = P(key).item(n);
  const files = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e));
    } else files.push(rel);
  };
  walk('verify.sh');
  walk('inputs');
  walk('control');
  if (!files.includes('verify.sh')) return null;
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

const live = new Map(); // runDir -> { promise, child }

function listRuns(key, n) {
  const dir = path.join(P(key).item(n), 'runs');
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names
    .map((id) => {
      const r = readJson(path.join(dir, id, 'run.json'));
      if (!r) return null;
      if (r.state === 'running' && !live.has(path.join(dir, id))) {
        r.state = 'interrupted';
        r.result = 'cannot-run';
      }
      return { id, ...r };
    })
    .filter(Boolean);
}

const resultFor = (code) => (code === 0 ? 'pass' : code === 1 ? 'fail' : 'cannot-run');

/**
 * A target Derive got wrong: Ashish asked for a re-derive, and no prototype work exists yet (no
 * runs, no frozen script, no diff). Only then may it be reclassified without the promotion guard.
 */
function misreadTarget(key, item) {
  return (
    item.request?.action === 'rederive' && !item.frozen && !item.code?.diff && listRuns(key, item.n).length === 0
  );
}

function promotionGuard(key, item) {
  const hash = scriptHash(key, item.n);
  if (!hash) return { ok: false, why: 'there is no verify.sh' };
  const runs = listRuns(key, item.n).filter((r) => r.state === 'done' && r.scriptHash === hash);
  if (!runs.some((r) => r.mode === 'baseline' && r.result === 'fail')) {
    return { ok: false, why: 'no baseline run of the current script that FAILED on base' };
  }
  if (!runs.some((r) => r.mode === 'normal' && r.result === 'pass')) {
    return { ok: false, why: 'no normal run of the current script that PASSED' };
  }
  return { ok: true };
}

/**
 * Run an item's verify.sh. The server runs it and the exit code is the result — the agent can
 * write the script, but it cannot write the outcome.
 *
 * Modes: normal (`./verify.sh`), control (`./verify.sh --control`, must FAIL for a fact to go
 * green), baseline (`./verify.sh` against the base — a target's control; must FAIL before any
 * prototype code is written, and freezes the script when it does).
 */
export function startRun(key, n, { mode = 'normal', unfreeze = false, reason = '', label: runLabel = '' } = {}) {
  requireBinding(key);
  const item = requireItem(key, n);
  if (!RUN_MODES.has(mode)) throw fail(400, 'mode must be normal|control|baseline');
  const dir = P(key).item(n);
  const script = path.join(dir, 'verify.sh');
  if (!fs.existsSync(script)) throw fail(400, `${label(item)} has no verify.sh yet (expected at ${script})`);
  if ([...live.keys()].some((k) => k.startsWith(path.join(dir, 'runs') + path.sep))) {
    throw fail(409, `${label(item)} already has a run in progress`);
  }

  const hash = scriptHash(key, n);
  if (item.frozen && item.frozen.hash !== hash) {
    if (!unfreeze) {
      throw fail(
        409,
        `${label(item)}'s verify.sh/inputs are frozen (they failed on base at ${item.frozen.at}) and have changed since. ` +
          'Only Ashish can change a frozen experiment: re-run with {"unfreeze":true,"reason":"<what he said>"} if he asked for it.'
      );
    }
    if (!norm(reason)) throw fail(400, 'unfreeze needs a reason (what Ashish asked for)');
    journal(key, `UNFROZE ${label(item)} — ${reason}`);
    item.frozen = null;
    saveItem(key, item);
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`;
  const runDir = path.join(dir, 'runs', id);
  const outDir = path.join(runDir, 'sentinel');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    fs.chmodSync(script, 0o755);
  } catch {
    /* best effort */
  }
  const startedAt = new Date();
  const run = { mode, state: 'running', scriptHash: hash, label: runLabel || null, startedAt: startedAt.toISOString() };
  writeJson(path.join(runDir, 'run.json'), run);
  const log = fs.openSync(path.join(runDir, 'log.txt'), 'w');

  const args = mode === 'control' ? ['--control'] : [];
  const env = {
    ...process.env,
    OUT: outDir,
    DESIGN_ITEM: label(item),
    DESIGN_REPO: item.repo || '',
    DESIGN_SHA: item.sha || '',
    DESIGN_MODE: mode,
  };
  delete env.NODE_OPTIONS;
  const child = spawn('bash', [script, ...args], { cwd: dir, env, stdio: ['ignore', log, log], detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, RUN_TIMEOUT_MS);

  const promise = new Promise((resolve) => {
    const finish = (code, err) => {
      clearTimeout(timer);
      try {
        fs.closeSync(log);
      } catch {
        /* closed */
      }
      const text = readText(path.join(runDir, 'log.txt'));
      const grab = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() || null;
      const exit = typeof code === 'number' ? code : null;
      const done = {
        ...run,
        state: 'done',
        exit,
        result: timedOut || err ? 'cannot-run' : resultFor(exit),
        note: timedOut ? `timed out after ${RUN_TIMEOUT_MS / 1000}s` : err ? String(err.message || err) : null,
        sha: grab('VERIFY_SHA') || item.sha || null,
        env: grab('VERIFY_ENV'),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      };
      writeJson(path.join(runDir, 'run.json'), done);
      live.delete(runDir);

      // Freeze a target's experiment the moment it has failed on base.
      if (mode === 'baseline' && done.result === 'fail') {
        const cur = readItem(key, n);
        if (cur && cur.kind === 'target' && !cur.frozen) {
          cur.frozen = { hash, at: done.finishedAt };
          saveItem(key, cur);
          journal(key, `froze ${label(cur)}'s verify.sh + inputs (hash ${hash}) after it failed on base`);
        }
      }
      journal(key, `ran ${label(item)} ${mode}: ${done.result}${exit !== null ? ` (exit ${exit})` : ''}${done.note ? ` — ${done.note}` : ''}`);
      resolve({ id, ...done });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
  live.set(runDir, { promise, child });
  journal(key, `started ${label(item)} ${mode} run ${id}`);
  return { runId: id, mode };
}

export async function waitRun(key, n, runId, waitSec = 0) {
  const runDir = path.join(P(key).item(n), 'runs', String(runId));
  if (!fs.existsSync(runDir)) throw fail(404, `no run ${runId} for #${n}`);
  const l = live.get(runDir);
  if (l && waitSec > 0) {
    await Promise.race([l.promise, new Promise((r) => setTimeout(r, Math.min(waitSec, 540) * 1000))]);
  }
  const r = listRuns(key, n).find((x) => x.id === runId);
  return { ...r, logTail: readText(path.join(runDir, 'log.txt')).split('\n').slice(-40).join('\n') };
}

// --- status ------------------------------------------------------------------------------------

/**
 * The only visual states: intent (target), code (anchored, not run), verified (pass + a control
 * that failed), and the runtime failures. Runs only count while they ran the script as it is now —
 * edit verify.sh and the item drops back to orange until it is run again.
 */
function statusOf(key, item, runs) {
  if (runs.some((r) => r.state === 'running')) return 'running';
  const hash = scriptHash(key, item.n);
  const cur = runs.filter((r) => r.state !== 'running' && r.scriptHash === hash && hash);
  const last = (mode) => [...cur].reverse().find((r) => mode.includes(r.mode));
  if (item.kind === 'target') {
    const base = last(['baseline']);
    if (base?.result === 'pass') return 'already-holds';
    return 'intent';
  }
  const normal = last(['normal']);
  const control = last(['control', 'baseline']);
  if (normal) {
    if (normal.result === 'cannot-run') return 'cannot-run';
    if (normal.result === 'fail') return 'failed';
    if (control?.result === 'fail') return 'verified';
    if (control?.result === 'pass') return 'control-passed';
    return 'no-control';
  }
  const anchors = item.verification?.anchors || [];
  if (!anchors.length) return 'unanchored';
  return anchors.every((a) => a.ok) ? 'code' : 'broken-anchor';
}

function itemFiles(key, n) {
  const dir = P(key).item(n);
  const out = [];
  const walk = (rel, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (r === 'item.json' || r === 'runs') continue;
      if (e.isDirectory()) {
        if (depth < 4) walk(r, depth + 1);
      } else out.push(r);
    }
  };
  walk('', 0);
  return out;
}

function runFiles(key, n, runId) {
  const dir = path.join(P(key).item(n), 'runs', runId, 'sentinel');
  const out = [];
  const walk = (rel, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (depth < 4) walk(r, depth + 1);
      } else out.push(path.join('runs', runId, 'sentinel', r));
    }
  };
  walk('', 0);
  return out;
}

/** Everything the Design view needs in one poll. File reads only. */
export function designState(key) {
  const binding = getBinding(key);
  if (!binding) return null;
  const p = P(key);
  const doc = readDoc(key);
  let nums = [];
  try {
    nums = fs
      .readdirSync(p.items)
      .filter((x) => /^\d+$/.test(x))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    /* none */
  }
  const items = [];
  for (const n of nums) {
    const item = readItem(key, n);
    if (!item) continue;
    const runs = listRuns(key, n);
    const src = sourceState(doc, item.source?.quotes || []);
    items.push({
      ...item,
      id: label(item),
      dir: p.item(n),
      status: statusOf(key, item, runs),
      source: { ...item.source, state: src.state, found: src.found },
      resolved: item.kind === 'flag' && src.state === 'gone',
      scriptHash: scriptHash(key, n),
      files: itemFiles(key, n),
      runs: runs.slice(-12).map((r) => ({ ...r, files: r.state === 'done' ? runFiles(key, n, r.id) : [] })),
    });
  }
  return { binding, ref: keyRef(key), dir: p.root, doc, items, journal: readJournal(key).split('\n').slice(-60).join('\n') };
}

/** Read one file inside an item's folder (scripts, inputs, sentinels). Never escapes the folder. */
export function readItemFile(key, n, rel) {
  requireItem(key, n);
  const dir = P(key).item(n);
  const abs = path.resolve(dir, String(rel || ''));
  if (!abs.startsWith(dir + path.sep)) throw fail(400, 'path escapes the item folder');
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw fail(404, `${rel} not found`);
  }
  if (!st.isFile()) throw fail(400, `${rel} is not a file`);
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return { path: rel, size: st.size, truncated: st.size > MAX_FILE_BYTES, content: buf.toString('utf8') };
}

/** A prototyped fact's Code is the diff base..head. */
export async function itemDiff(key, n) {
  const item = requireItem(key, n);
  if (!item.code?.diff || !item.repo) throw fail(404, `${label(item)} has no prototype diff`);
  const { base, head } = item.code.diff;
  const stat = await git(item.repo, ['diff', '--stat', `${base}..${head}`]);
  let diff = await git(item.repo, ['diff', `${base}..${head}`]);
  const truncated = diff.length > MAX_FILE_BYTES;
  if (truncated) diff = diff.slice(0, MAX_FILE_BYTES);
  return { base, head, repo: item.repo, stat, diff, truncated };
}
