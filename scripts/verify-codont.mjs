#!/usr/bin/env node
/**
 * Tests for the Code Ontology feature, driven end-to-end through the HTTP surface.
 *
 * There is no fake agent any more, and that absence is the point: the writer is the session's own
 * terminal agent calling POST /api/codont/update, so the test IS the agent. The previous harness
 * had to stub `claude -p` and fake a fenced ```json codont-result``` block, which is exactly the
 * fragile channel this change deleted.
 *
 * The fixture repo is built so the SAME emitted anchor is valid at the committed version and
 * invalid in the working tree — which is what proves verification runs per-tab, at each tab's own
 * ref, rather than once against whatever happens to be on disk.
 *
 * Run: node scripts/verify-codont.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.DEVBOARD_VERIFY_PORT || 5189);
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'codont-test-session-1';

let pass = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
};

// ---------------------------------------------------------------- fixture
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codont-verify-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q');
g('config', 'user.email', 'v@d');
g('config', 'user.name', 'v');

// v1: 10 lines — a line-8 anchor is valid here.
fs.writeFileSync(
  path.join(repo, 'pkg', 'a.go'),
  ['type thing struct{}', 'func FuncA() {', '\tFuncB()', '}', '', '', '', 'func (t thing) FuncB() {', '}', ''].join('\n')
);
g('add', '.');
g('commit', '-qm', 'v1');
const SHA1 = g('rev-parse', 'HEAD').trim();
g('branch', 'oldstuff', SHA1);

// v2 committed: 3 lines — line 8 is out of range here and in the (identical) working tree.
fs.writeFileSync(path.join(repo, 'pkg', 'a.go'), ['type thing struct{}', 'func FuncA() {}', ''].join('\n'));
g('add', '.');
g('commit', '-qm', 'v2');
const SHA2 = g('rev-parse', 'HEAD').trim();
g('tag', 'v2tag', SHA2);

// A second file that exists only in the working tree, for the symbol-resolution tests.
fs.writeFileSync(
  path.join(repo, 'pkg', 'b.go'),
  ['package pkg', '', 'type Runner interface{ Run() }', '', 'func helper() {', '\tprintln("x")', '}', ''].join('\n')
);

// Env linkage fixture: a provenance record pinning THIS repo to SHA1 (≠ HEAD).
const envRoot = path.join(tmp, 'env-state');
fs.mkdirSync(path.join(envRoot, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(envRoot, '.provenance', 'by-key'), { recursive: true });
fs.writeFileSync(
  path.join(envRoot, 'sessions', `${SID}.json`),
  JSON.stringify({ session: SID, target: 'xcp-stack', instructions: 'env for codont test', instances: [] })
);
fs.writeFileSync(
  path.join(envRoot, '.provenance', 'by-key', 'images-test.json'),
  JSON.stringify({ key: 'images-test', repo, sha: SHA1, version: '1.0' })
);

const codontRoot = path.join(tmp, 'codont-state');

const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DEVBOARD_TERMINAL_ROOTS: tmp,
    DEVBOARD_ENV_ROOT: envRoot,
    DEVBOARD_CODONT_ROOT: codontRoot,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
if (!(await until(async () => (await fetch(`${BASE}/api/health`)).ok))) {
  console.error('server did not come up');
  process.exit(1);
}

const post = (p, b) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const state = async () => (await fetch(`${BASE}/api/codont/state?session=${SID}`)).json();

const FUNC_A = {
  id: 'pkg..FuncA',
  label: 'FuncA',
  pkg: 'pkg',
  via: 'direct',
  recv: null,
  viaAnchor: null,
  anchor: { path: 'pkg/a.go', line: 2 },
};
const FUNC_B = {
  id: 'pkg.thing.FuncB',
  label: 'FuncB',
  pkg: 'pkg',
  via: 'struct',
  recv: 'thing',
  viaAnchor: { path: 'pkg/a.go', line: 1 },
  anchor: { path: 'pkg/a.go', line: 8 },
};
const A_CALLS_B = { from: 'pkg..FuncA', to: 'pkg.thing.FuncB', kind: 'calls', anchor: { path: 'pkg/a.go', line: 3 } };

let wtTab = null;
let envTab = null;

try {
  // ---------------------------------------------------------------- start
  {
    const r = await post('/api/codont/start', { session: SID, instruction: 'trace FuncA -> FuncB', cwd: repo });
    const b = await r.json();
    check('start creates the binding', r.ok && b.binding?.session === SID, JSON.stringify(b).slice(0, 120));
    // Env provenance pins this repo to SHA1 ≠ HEAD → the env tab is created automatically at start.
    check('env-pinned version gets its own tab automatically', b.envTabCreated === true && b.tabs.length === 2,
      JSON.stringify(b.tabs));
    check('start hands back the working tab id and the next step', Boolean(b.workingTabId) && /codont\/update/.test(b.next || ''),
      JSON.stringify(b.next));
    wtTab = b.workingTabId;
    envTab = b.envTabId;
  }
  {
    const s = await state();
    check('start does NOT build a diagram on its own — the agent does',
      s.tabs.every((t) => t.ontology.nodes.length === 0), JSON.stringify(s.tabs.map((t) => t.ontology.nodes.length)));
  }

  // ---------------------------------------------------------------- the agent writes (replace)
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      mode: 'replace',
      nodes: [FUNC_A, FUNC_B],
      edges: [A_CALLS_B],
      context: '# Shared context\n\nTracing FuncA -> FuncB in the fixture repo.\n',
      note: 'initial build',
    });
    const b = await r.json();
    check('update accepted synchronously', r.ok && b.ok === true, JSON.stringify(b).slice(0, 200));
    check('update reports what it added', b.added?.length === 2 && b.counts.nodes === 2 && b.counts.edges === 1,
      JSON.stringify({ added: b.added, counts: b.counts }));
    // The whole point of the response: the caller learns about bad anchors NOW, not from a red box later.
    check('update reports the failed anchor inline',
      b.failed?.some((f) => f.key === 'pkg.thing.FuncB' && /3 lines/.test(f.error)), JSON.stringify(b.failed));
    check('context written through the same call', b.context.includes('FuncA -> FuncB'), b.context?.slice(0, 80));
  }
  {
    const s = await state();
    const wt = s.tabs.find((t) => t.id === wtTab);
    check('context.md established', s.context.includes('FuncA -> FuncB'));
    check('journal records the update', s.journal.includes('initial build') && s.journal.includes('pkg..FuncA'),
      s.journal.slice(0, 200));
    check('journal flags the unverified element', s.journal.includes('pkg.thing.FuncB'), s.journal.slice(-200));

    const vWt = wt.ontology.verification;
    check('FuncA verifies in the working tree', vWt['pkg..FuncA']?.ok === true, JSON.stringify(vWt['pkg..FuncA']));
    check('FuncB (line 8) is BROKEN on the working-tree tab',
      vWt['pkg.thing.FuncB']?.ok === false && /3 lines/.test(vWt['pkg.thing.FuncB']?.error || ''),
      JSON.stringify(vWt['pkg.thing.FuncB']));
    check('edges get verified too', vWt['edge:0']?.ok === true, JSON.stringify(vWt['edge:0']));
  }

  // An edge anchor is verified on its own merits, not inherited from its endpoints.
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      edges: [{ ...A_CALLS_B, anchor: { path: 'pkg/a.go', line: 99 } }],
    });
    const b = await r.json();
    check('an out-of-range edge anchor is reported as failed',
      r.ok && b.failed.some((f) => f.key.startsWith('edge:') && /3 lines/.test(f.error)), JSON.stringify(b.failed));
    // ...then put the good anchor back, so the rest of the run starts from a clean slate.
    await post('/api/codont/update', { session: SID, tabId: wtTab, edges: [A_CALLS_B] });
  }

  // The SAME anchors, written to the env-pinned tab, verify — proof that verification is per-tab.
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: envTab,
      mode: 'replace',
      nodes: [FUNC_A, FUNC_B],
      edges: [A_CALLS_B],
    });
    const b = await r.json();
    check('the same anchors verify at the env-pinned SHA1 tab', r.ok && b.failed.length === 0, JSON.stringify(b.failed));
  }

  // ---------------------------------------------------------------- merge: the follow-up case
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      nodes: [
        {
          id: 'pkg..helper',
          label: 'helper',
          pkg: 'pkg',
          via: 'direct',
          recv: null,
          viaAnchor: null,
          // No line at all: the server finds it. This is the "add a few functions" ergonomics.
          anchor: { path: 'pkg/b.go', symbol: 'helper' },
        },
      ],
      edges: [{ from: 'pkg..FuncA', to: 'pkg..helper', kind: 'calls', anchor: { path: 'pkg/a.go', line: 2 } }],
      note: 'add helper',
    });
    const b = await r.json();
    check('merge keeps what was already there and adds the new node',
      r.ok && b.added.join() === 'pkg..helper' && b.counts.nodes === 3 && b.counts.edges === 2,
      JSON.stringify({ added: b.added, counts: b.counts }));
    check('a symbol-only anchor resolves and verifies',
      !b.failed.some((f) => f.key === 'pkg..helper'), JSON.stringify(b.failed));
    const s = await state();
    const helper = s.tabs.find((t) => t.id === wtTab).ontology.nodes.find((n) => n.id === 'pkg..helper');
    check('symbol resolved to the real func line', helper?.anchor.line === 5, JSON.stringify(helper?.anchor));
  }

  // A stale line number plus a symbol: the symbol wins and the server says it moved it.
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      nodes: [
        {
          id: 'pkg..helper',
          label: 'helper',
          pkg: 'pkg',
          via: 'direct',
          recv: null,
          viaAnchor: null,
          anchor: { path: 'pkg/b.go', line: 99, symbol: 'helper' },
        },
      ],
    });
    const b = await r.json();
    check('a stale line is self-healed by the symbol',
      b.updated.join() === 'pkg..helper' && b.resolved.some((x) => /is at 5, not 99/.test(x)),
      JSON.stringify({ updated: b.updated, resolved: b.resolved }));
    check('self-healed anchor verifies', !b.failed.some((f) => f.key === 'pkg..helper'), JSON.stringify(b.failed));
  }

  // ---------------------------------------------------------------- validation errors are legible
  {
    const r = await post('/api/codont/update', { session: SID, tabId: wtTab, nodes: [{ label: 'nope' }] });
    const b = await r.json();
    check('a node without an id is a 400 naming the field', r.status === 400 && /no id/.test(b.error), JSON.stringify(b));
  }
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      nodes: [{ id: 'pkg..x', pkg: 'pkg', via: 'struct', recv: 'thing', anchor: { path: 'pkg/a.go', line: 1 } }],
    });
    const b = await r.json();
    check('via=struct without a viaAnchor is a 400 explaining why',
      r.status === 400 && /viaAnchor/.test(b.error), JSON.stringify(b));
  }
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      nodes: [{ id: 'pkg..y', pkg: 'pkg', via: 'sideways', anchor: { path: 'pkg/a.go', line: 1 } }],
    });
    const b = await r.json();
    check('an unknown via is a 400 listing the legal values',
      r.status === 400 && /direct\|struct\|interface/.test(b.error), JSON.stringify(b));
  }
  {
    const r = await post('/api/codont/update', { session: SID, tabId: 'not-a-tab', nodes: [] });
    check('an unknown tabId is a 404 that lists the real ones', r.status === 404, String(r.status));
  }
  {
    const r = await post('/api/codont/update', { session: 'no-such-session', nodes: [] });
    const b = await r.json();
    check('updating a session with no ontology points at /codont', r.status === 404 && /\/codont/.test(b.error),
      JSON.stringify(b));
  }
  {
    // An edge to a node that was never added is dropped and REPORTED, never silently stored.
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      edges: [{ from: 'pkg..FuncA', to: 'pkg..ghost', kind: 'calls', anchor: { path: 'pkg/a.go', line: 3 } }],
    });
    const b = await r.json();
    check('an edge to an unknown node is dropped and reported',
      r.ok && b.dropped.some((d) => /ghost/.test(d)) && b.counts.edges === 2, JSON.stringify(b.dropped));
  }

  // ---------------------------------------------------------------- removal
  {
    const r = await post('/api/codont/update', { session: SID, tabId: wtTab, removeNodes: ['pkg..helper'] });
    const b = await r.json();
    check('removing a node takes its edges with it',
      r.ok && b.removed.join() === 'pkg..helper' && b.counts.nodes === 2 && b.counts.edges === 1,
      JSON.stringify({ removed: b.removed, counts: b.counts }));
  }

  // ---------------------------------------------------------------- one-shot rule
  {
    const r = await post('/api/codont/start', { session: SID, instruction: 'again', cwd: repo });
    const b = await r.json();
    check('re-running /codont is refused (409) and points at the update API',
      r.status === 409 && /update/.test(b.error), `${r.status} ${JSON.stringify(b)}`);
  }

  // ---------------------------------------------------------------- version tabs
  {
    const r = await post('/api/codont/tab', { session: SID, ref: 'v2tag' });
    const b = await r.json();
    check('tab by tag resolves to the full sha', r.ok && b.tab?.refResolved === SHA2, JSON.stringify(b));
    check('a new tab starts empty and says who fills it', /codont\/update/.test(b.next || ''), JSON.stringify(b.next));
    const s = await state();
    check('the new tab really is empty', s.tabs.find((t) => t.id === b.tab.id).ontology.nodes.length === 0);
  }
  {
    const r = await post('/api/codont/tab', { session: SID, ref: 'oldstuff' });
    check('duplicate version tab is refused (branch resolving to an existing tab sha)', r.status === 409, String(r.status));
  }
  {
    const r = await post('/api/codont/tab', { session: SID, ref: 'no-such-ref' });
    check('unknown ref is a 404', r.status === 404, String(r.status));
  }

  // ---------------------------------------------------------------- containment
  {
    const r = await post('/api/codont/update', {
      session: SID,
      tabId: wtTab,
      nodes: [
        { id: 'esc..X', label: 'X', pkg: 'esc', via: 'direct', recv: null, viaAnchor: null, anchor: { path: '../../etc/passwd', line: 1 } },
      ],
    });
    const b = await r.json();
    check('an anchor outside the session directory fails verification, it does not read the file',
      r.ok && b.failed.some((f) => f.key === 'esc..X' && /outside the session directory/.test(f.error)),
      JSON.stringify(b.failed));
  }

  // ---------------------------------------------------------------- branches + sessions
  {
    const b = await (await fetch(`${BASE}/api/codont/branches?session=${SID}&q=old`)).json();
    check('branch suggestions filter', b.branches.includes('oldstuff') && !b.branches.includes('v2tag'),
      JSON.stringify(b.branches));
    const all = await (await fetch(`${BASE}/api/codont/branches?session=${SID}`)).json();
    check('tags are suggested too', all.branches.includes('v2tag'), JSON.stringify(all.branches));
    const sessions = await (await fetch(`${BASE}/api/codont/sessions`)).json();
    check('sessions index lists the binding', sessions.some((x) => x.session === SID));
  }

  // ---------------------------------------------------------------- the subagent is gone
  {
    const r = await post('/api/codont/validate', { session: SID, tabId: wtTab, rough: 'anything' });
    check('the old /validate subagent endpoint no longer exists', r.status === 404, String(r.status));
    check('no subagent module remains', !fs.existsSync(path.join(ROOT, 'server', 'lib', 'codontAgent.js')));
    const s = await state();
    check('state exposes a journal, not a rough', typeof s.journal === 'string' && s.rough === undefined);
  }
} finally {
  server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
