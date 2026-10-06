import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileP = promisify(execFile);

/**
 * Code Ontology (codont) store + anchor verification.
 *
 * Contract: ~/.agents/specs/codont.md. The store is deliberately dumb files — the same
 * cache-of-belief posture as environments — and VERIFICATION is the interesting part:
 *
 *   Every node and edge carries a file:line anchor. On every save, each anchor is resolved at
 *   the tab's pinned ref (git show) or the working tree, and the result is attached to the
 *   ontology. Elements that fail render red/dashed in the UI — visible, never silently absent,
 *   never confidently wrong. Verify-before-draw.
 *
 * The WRITER is the session's main terminal agent, over HTTP. There used to be a headless
 * subagent whose only channel back was a fenced ```json codont-result``` block inside free-form
 * prose; anything that perturbed that fence (a stray backtick, a truncated reply, a preamble)
 * produced "unparseable output" and a silently unchanged diagram. A typed HTTP endpoint deletes
 * that failure class: the agent already knows the code it just read, and a 400 with a precise
 * message is something it can act on, unlike a regex that quietly missed.
 */

export const CODONT_ROOT =
  process.env.DEVBOARD_CODONT_ROOT || path.join(os.homedir(), '.agents', 'codont');
export const META_DIR = path.join(CODONT_ROOT, 'meta');

const sessionDir = (session) => path.join(CODONT_ROOT, session);
const tabDir = (session, tabId) => path.join(sessionDir(session), 'tabs', tabId);

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
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

// --- bindings ----------------------------------------------------------------------------------

export function listBindings() {
  let entries = [];
  try {
    entries = fs.readdirSync(CODONT_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'meta') continue;
    const b = readJson(path.join(CODONT_ROOT, e.name, 'binding.json'));
    if (b) out.push(b);
  }
  return out;
}

export function getBinding(session) {
  return readJson(path.join(sessionDir(session), 'binding.json'));
}

/**
 * Create the construct for a session. Refuses to run twice: /codont is a one-shot — re-running
 * would recreate the diagram and destroy the accumulated whiteboxing, which is the exact thing
 * the user said must not happen. Evolution goes through the Rough.
 */
export function createBinding({ session, instruction, cwd }) {
  if (getBinding(session)) {
    const err = new Error(
      'a code ontology already exists for this session — evolve it with POST /api/codont/update instead'
    );
    err.status = 409;
    throw err;
  }
  const realCwd = fs.realpathSync(path.resolve(cwd));
  const binding = { session, instruction, cwd: realCwd, createdAt: new Date().toISOString() };
  writeJson(path.join(sessionDir(session), 'binding.json'), binding);
  fs.writeFileSync(
    path.join(sessionDir(session), 'context.md'),
    `# Shared context\n\n(not yet written — the agent establishes this on its first update)\n\nInstruction: ${instruction}\n`
  );
  fs.writeFileSync(path.join(sessionDir(session), 'journal.md'), '');
  writeJson(path.join(sessionDir(session), 'tabs.json'), []);
  return binding;
}

// --- tabs --------------------------------------------------------------------------------------

export function listTabs(session) {
  return readJson(path.join(sessionDir(session), 'tabs.json'), []);
}

async function git(cwd, args) {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 8 << 20, timeout: 10_000 });
  return stdout;
}

/**
 * Create a version tab. `ref: null` is the working tree; anything else is resolved to a full sha
 * NOW, so the tab forever states exactly which commit it describes even as the branch moves.
 */
export async function createTab(session, { ref = null, label = null }) {
  const binding = getBinding(session);
  if (!binding) {
    const err = new Error('no code ontology for this session');
    err.status = 404;
    throw err;
  }
  let refResolved = null;
  if (ref) {
    try {
      refResolved = (await git(binding.cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    } catch {
      const err = new Error(`unknown ref '${ref}' in ${binding.cwd}`);
      err.status = 404;
      throw err;
    }
  }
  const tabs = listTabs(session);
  const dup = tabs.find((t) => (t.refResolved || null) === refResolved);
  if (dup) {
    const err = new Error(`a tab for this version already exists (${dup.label})`);
    err.status = 409;
    throw err;
  }
  const tab = {
    id: crypto.randomBytes(4).toString('hex'),
    ref,
    refResolved,
    label: label || (ref ? `${ref} @ ${refResolved.slice(0, 8)}` : 'working tree'),
    createdAt: new Date().toISOString(),
  };
  tabs.push(tab);
  writeJson(path.join(sessionDir(session), 'tabs.json'), tabs);
  writeJson(path.join(tabDir(session, tab.id), 'ontology.json'), {
    schema: 1,
    nodes: [],
    edges: [],
    verification: {},
  });
  writeJson(path.join(tabDir(session, tab.id), 'status.json'), { state: 'idle' });
  return tab;
}

export function readOntology(session, tabId) {
  return readJson(path.join(tabDir(session, tabId), 'ontology.json'), { schema: 1, nodes: [], edges: [], verification: {} });
}

export function readStatus(session, tabId) {
  return readJson(path.join(tabDir(session, tabId), 'status.json'), { state: 'idle' });
}

export function writeStatus(session, tabId, status) {
  writeJson(path.join(tabDir(session, tabId), 'status.json'), status);
}

// --- anchor verification -----------------------------------------------------------------------

function withinCwd(binding, rel) {
  const abs = path.resolve(binding.cwd, rel);
  return abs === binding.cwd || abs.startsWith(binding.cwd + path.sep) ? abs : null;
}

/**
 * File contents per (ref, path), fetched once per pass. Content is read the same way the agent
 * was told to read it — `git show` for pinned tabs, the disk for the working tree — so
 * verification judges the claim against the version the tab claims to describe.
 *
 * Full text rather than a line count because anchors may be expressed as a SYMBOL, which has to
 * be located in the file (see resolveAnchors).
 */
async function contentLoader(binding, refResolved) {
  const cache = new Map();
  return async (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let result;
    const abs = withinCwd(binding, rel);
    if (!abs) {
      result = { err: 'outside the session directory' };
    } else if (refResolved) {
      try {
        const out = await git(binding.cwd, ['show', `${refResolved}:${rel}`]);
        result = { text: out, lines: out.split('\n').length };
      } catch {
        result = { err: `does not exist at ${refResolved.slice(0, 8)}` };
      }
    } else {
      try {
        const text = fs.readFileSync(abs, 'utf8');
        result = { text, lines: text.split('\n').length };
      } catch {
        result = { err: 'not found in the working tree' };
      }
    }
    cache.set(rel, result);
    return result;
  };
}

/**
 * Where a declaration of `symbol` lives in `text`, 1-indexed, or 0.
 *
 * Deliberately Go-shaped and deliberately dumb: `func Name(`, `func (r T) Name(`, `type Name `.
 * It exists so the agent can say "the func is called handleProbe" instead of counting lines —
 * off-by-a-few line numbers were the single largest source of red/dashed elements, and an
 * anchor the server located itself cannot drift.
 */
function findSymbolLine(text, symbol) {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^\\s*func\\s+(\\([^)]*\\)\\s*)?${esc}\\s*(\\[|\\()`),
    new RegExp(`^\\s*type\\s+${esc}\\b`),
    new RegExp(`^\\s*(var|const)\\s+${esc}\\b`),
  ];
  const lines = text.split('\n');
  for (const re of patterns) {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  }
  return 0;
}

/**
 * Turn a loose anchor into a concrete {path, line}.
 *
 * `{path, symbol}` → the server finds the line. `{path, line, symbol}` → the symbol wins when it
 * resolves elsewhere, which self-heals the common case of an agent quoting a line number from a
 * slightly stale read. Returns what it did so the caller can report it back.
 */
async function resolveAnchor(load, anchor) {
  if (!anchor || !anchor.path) return { anchor: null, note: null };
  const out = { path: anchor.path, line: Number(anchor.line) || 0 };
  if (anchor.symbol) out.symbol = anchor.symbol;
  if (!anchor.symbol) return { anchor: out, note: null };

  const r = await load(anchor.path);
  if (r.err) return { anchor: out, note: null };
  const found = findSymbolLine(r.text, anchor.symbol);
  if (!found) {
    return { anchor: out, note: `${anchor.path}: symbol '${anchor.symbol}' not found; kept line ${out.line}` };
  }
  const note = out.line && out.line !== found ? `${anchor.path}: '${anchor.symbol}' is at ${found}, not ${out.line}` : null;
  out.line = found;
  return { anchor: out, note };
}

async function verifyAnchor(load, anchor) {
  if (!anchor || !anchor.path || !Number.isFinite(Number(anchor.line))) {
    return { ok: false, error: 'missing anchor' };
  }
  const r = await load(anchor.path);
  if (r.err) return { ok: false, error: `${anchor.path}: ${r.err}` };
  if (anchor.line < 1 || anchor.line > r.lines) {
    return { ok: false, error: `${anchor.path} has ${r.lines} lines; anchor says ${anchor.line}` };
  }
  return { ok: true };
}

/**
 * Save an ontology with verification attached. Elements are NEVER dropped for failing — the
 * failure is the information.
 */
export async function saveOntology(session, tabId, ontology) {
  const { binding, tab } = requireTab(session, tabId);
  const load = await contentLoader(binding, tab.refResolved);

  const verification = {};
  for (const n of ontology.nodes || []) {
    verification[n.id] = await verifyAnchor(load, n.anchor);
    if (n.via && n.via !== 'direct') {
      const v = await verifyAnchor(load, n.viaAnchor);
      if (!v.ok) {
        verification[n.id] = {
          ok: false,
          error: verification[n.id].ok ? `via: ${v.error}` : `${verification[n.id].error}; via: ${v.error}`,
        };
      }
    }
  }
  for (let i = 0; i < (ontology.edges || []).length; i++) {
    verification[`edge:${i}`] = await verifyAnchor(load, ontology.edges[i].anchor);
  }

  const out = { schema: 1, nodes: ontology.nodes || [], edges: ontology.edges || [], verification };
  writeJson(path.join(tabDir(session, tabId), 'ontology.json'), out);
  return out;
}

function requireTab(session, tabId) {
  const binding = getBinding(session);
  const tab = listTabs(session).find((t) => t.id === tabId);
  if (!binding || !tab) {
    const err = new Error('unknown session or tab');
    err.status = 404;
    throw err;
  }
  return { binding, tab };
}

// --- the write path: applying a delta ------------------------------------------------------------

const VIA = new Set(['direct', 'struct', 'interface']);
const KINDS = new Set(['calls', 'then', 'concurrent']);
const edgeKey = (e) => `${e.from} ${e.to} ${e.kind}`;

const bad = (msg) => {
  const err = new Error(msg);
  err.status = 400;
  throw err;
};

/**
 * Normalise and validate one incoming node. Rejecting loudly here is the point: the agent asked
 * for a change, and a 400 naming the field it got wrong is something it can fix on the next call.
 * Silently storing a malformed node would surface much later as an unexplained missing box.
 */
function normalizeNode(n, i) {
  if (!n || typeof n !== 'object') bad(`nodes[${i}] is not an object`);
  const id = String(n.id || '').trim();
  if (!id) bad(`nodes[${i}] has no id`);
  const via = n.via || 'direct';
  if (!VIA.has(via)) bad(`nodes[${i}] (${id}): via must be one of direct|struct|interface, got '${via}'`);
  if (!n.anchor?.path) bad(`nodes[${i}] (${id}): anchor.path is required`);
  if (!n.anchor.line && !n.anchor.symbol) bad(`nodes[${i}] (${id}): anchor needs a line or a symbol`);
  if (via !== 'direct' && !n.viaAnchor?.path) {
    bad(`nodes[${i}] (${id}): via='${via}' requires viaAnchor.path (where the ${via} type is declared)`);
  }
  return {
    id,
    label: String(n.label || id.split('.').pop() || id),
    pkg: String(n.pkg || ''),
    via,
    recv: n.recv ?? null,
    viaAnchor: via === 'direct' ? null : { ...n.viaAnchor },
    anchor: { ...n.anchor },
    ...(n.note ? { note: String(n.note) } : {}),
  };
}

function normalizeEdge(e, i) {
  if (!e || typeof e !== 'object') bad(`edges[${i}] is not an object`);
  const from = String(e.from || '').trim();
  const to = String(e.to || '').trim();
  if (!from || !to) bad(`edges[${i}] needs both from and to`);
  const kind = e.kind || 'calls';
  if (!KINDS.has(kind)) bad(`edges[${i}] (${from}->${to}): kind must be one of calls|then|concurrent, got '${kind}'`);
  if (e.anchor && !e.anchor.path) bad(`edges[${i}] (${from}->${to}): anchor.path is required when an anchor is given`);
  return { from, to, kind, anchor: e.anchor ? { ...e.anchor } : null };
}

/**
 * Apply a delta to a tab's ontology and save it verified.
 *
 * Merge (the default) is what makes "add these two functions" a small call: nodes upsert by id,
 * edges upsert by (from,to,kind), everything else is left alone. Replace exists for the initial
 * build and for deliberate rewrites. Either way the response carries the verification result, so
 * the caller learns about a bad anchor immediately instead of the user noticing a red box later.
 */
export async function applyDelta(session, tabId, delta) {
  const { binding, tab } = requireTab(session, tabId);
  const mode = delta.mode === 'replace' ? 'replace' : 'merge';

  const incomingNodes = (delta.nodes || []).map(normalizeNode);
  const incomingEdges = (delta.edges || []).map(normalizeEdge);

  // Resolve symbol-anchors before anything else — later steps compare concrete lines.
  const load = await contentLoader(binding, tab.refResolved);
  const resolutions = [];
  for (const n of incomingNodes) {
    const a = await resolveAnchor(load, n.anchor);
    n.anchor = a.anchor;
    if (a.note) resolutions.push(a.note);
    if (n.viaAnchor) {
      const v = await resolveAnchor(load, n.viaAnchor);
      n.viaAnchor = v.anchor;
      if (v.note) resolutions.push(v.note);
    }
  }
  for (const e of incomingEdges) {
    if (!e.anchor) continue;
    const a = await resolveAnchor(load, e.anchor);
    e.anchor = a.anchor;
    if (a.note) resolutions.push(a.note);
  }

  const current = mode === 'replace' ? { nodes: [], edges: [] } : readOntology(session, tabId);

  const nodes = [...current.nodes];
  const added = [];
  const updated = [];
  for (const n of incomingNodes) {
    const at = nodes.findIndex((x) => x.id === n.id);
    if (at === -1) {
      nodes.push(n);
      added.push(n.id);
    } else {
      nodes[at] = n;
      updated.push(n.id);
    }
  }

  const edges = [...current.edges];
  for (const e of incomingEdges) {
    const at = edges.findIndex((x) => edgeKey(x) === edgeKey(e));
    if (at === -1) edges.push(e);
    else edges[at] = e;
  }

  const removeNodes = new Set((delta.removeNodes || []).map(String));
  const removed = nodes.filter((n) => removeNodes.has(n.id)).map((n) => n.id);
  let keptNodes = nodes.filter((n) => !removeNodes.has(n.id));

  const removeEdgeKeys = new Set(
    (delta.removeEdges || []).map((e) => edgeKey({ from: e.from, to: e.to, kind: e.kind || 'calls' }))
  );
  // Removing a node removes the edges that touched it — an edge to a box that is gone is not a
  // claim about the code, it is a dangling reference.
  let keptEdges = edges.filter(
    (e) => !removeEdgeKeys.has(edgeKey(e)) && !removeNodes.has(e.from) && !removeNodes.has(e.to)
  );

  // Edges pointing at nodes that were never added are the agent's most common slip. Drop them and
  // SAY SO, rather than storing an edge that can never render.
  const ids = new Set(keptNodes.map((n) => n.id));
  const dangling = keptEdges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  keptEdges = keptEdges.filter((e) => ids.has(e.from) && ids.has(e.to));

  const saved = await saveOntology(session, tabId, { nodes: keptNodes, edges: keptEdges });

  const failed = Object.entries(saved.verification)
    .filter(([, v]) => v && v.ok === false)
    .map(([key, v]) => ({ key, error: v.error }));

  return {
    tab: { id: tab.id, label: tab.label, ref: tab.ref, refResolved: tab.refResolved },
    mode,
    added,
    updated,
    removed,
    counts: { nodes: saved.nodes.length, edges: saved.edges.length },
    resolved: resolutions,
    dropped: dangling.map((e) => `${e.from} -${e.kind}-> ${e.to}: unknown node id`),
    failed,
  };
}

// --- journal + context ---------------------------------------------------------------------------

export function readContext(session) {
  return readText(path.join(sessionDir(session), 'context.md'));
}

export function writeContext(session, md) {
  fs.writeFileSync(path.join(sessionDir(session), 'context.md'), md);
}

export function readJournal(session) {
  return readText(path.join(sessionDir(session), 'journal.md'));
}

/**
 * Append what an update actually did. The old Rough pane was a conversation with a second agent;
 * the conversation now happens in the terminal, so what the diagram still owes the user is the
 * audit trail — which boxes appeared, which anchors the server moved, what failed to verify.
 */
export function appendJournal(session, entry) {
  const stamp = new Date().toISOString();
  const lines = [`\n---\n**${stamp}** · ${entry.tabLabel}`, ''];
  if (entry.note) lines.push(entry.note.trim(), '');
  const bullet = [];
  if (entry.added?.length) bullet.push(`added: ${entry.added.join(', ')}`);
  if (entry.updated?.length) bullet.push(`updated: ${entry.updated.join(', ')}`);
  if (entry.removed?.length) bullet.push(`removed: ${entry.removed.join(', ')}`);
  bullet.push(`now ${entry.counts.nodes} node(s), ${entry.counts.edges} edge(s)`);
  for (const b of bullet) lines.push(`- ${b}`);
  for (const r of entry.resolved || []) lines.push(`- anchor resolved — ${r}`);
  for (const d of entry.dropped || []) lines.push(`- dropped — ${d}`);
  for (const f of entry.failed || []) lines.push(`- ⚠️ ${f.key}: ${f.error}`);
  fs.appendFileSync(path.join(sessionDir(session), 'journal.md'), `${lines.join('\n')}\n`);
}

// --- environment linkage -----------------------------------------------------------------------

/**
 * What the session's environment pins the traced repo to, if anything.
 *
 * Sources are binding + provenance FILES (a cache of belief, per the env spec) — good enough for
 * context and for suggesting a version tab; never treated as probe truth.
 */
export async function envInfoFor(session, envDeps) {
  const binding = envDeps.sessionBinding(session);
  if (!binding) return null;

  const provDir = path.join(envDeps.envRoot, '.provenance', 'by-key');
  const provenance = [];
  try {
    for (const f of fs.readdirSync(provDir)) {
      const p = readJson(path.join(provDir, f));
      if (p?.repo && p?.sha) provenance.push({ key: p.key, repo: p.repo, sha: p.sha, version: p.version || null });
    }
  } catch {
    /* no provenance yet */
  }
  return { target: binding.target, instructions: binding.instructions || null, provenance };
}

/** The env-pinned sha for the codont's repo, when provenance covers it. */
export async function envShaForCwd(cwd, envInfo) {
  if (!envInfo) return null;
  let repoRoot;
  try {
    repoRoot = fs.realpathSync((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
  for (const p of envInfo.provenance) {
    try {
      if (fs.realpathSync(p.repo) === repoRoot) return p.sha;
    } catch {
      /* provenance repo gone */
    }
  }
  return null;
}

export async function headSha(cwd) {
  try {
    return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

export async function branchSuggestions(cwd, q = '') {
  try {
    const out = await git(cwd, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/tags',
    ]);
    const all = out.split('\n').filter(Boolean);
    const ql = q.toLowerCase();
    return all.filter((b) => !ql || b.toLowerCase().includes(ql)).slice(0, 20);
  } catch {
    return [];
  }
}
