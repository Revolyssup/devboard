#!/usr/bin/env node
/**
 * Tests for the code-link feature: the file:line matcher and the resolve/peek endpoints.
 *
 * Runs its own server against a throwaway root (DEVBOARD_TERMINAL_ROOTS) containing a small git
 * repo whose history is constructed here — one committed version of a file plus a diverged
 * working tree — so the ref-vs-working-tree semantics are provable, not assumed.
 *
 * The matcher test imports web/src/lib/codeRefs.ts DIRECTLY (Node type stripping), so the exact
 * code the browser ships is what gets tested — not a copy that can drift.
 *
 * Run: node scripts/verify-code.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCodeRefs, editorUrl } from '../web/src/lib/codeRefs.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.DEVBOARD_VERIFY_PORT || 5187);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) pass++;
  else failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
}

// ---------------------------------------------------------------- matcher
{
  const refs = (t) => parseCodeRefs(t);

  const one = refs('see server/lib/env/plan.js:123 for details');
  check('plain path:line parses', one.length === 1 && one[0].path === 'server/lib/env/plan.js' && one[0].line === 123,
    JSON.stringify(one));

  const full = refs('at plan.js:12:5@92ba3a76877c534d3e3b632d1e25cff60b987ac6 there');
  check('path:line:col@sha parses all parts',
    full.length === 1 && full[0].line === 12 && full[0].col === 5 &&
    full[0].sha === '92ba3a76877c534d3e3b632d1e25cff60b987ac6' && full[0].path === 'plan.js',
    JSON.stringify(full));

  check('short sha accepted', refs('a.go:9@abc1234 x')[0]?.sha === 'abc1234');
  check('~/ path parses', refs('~/dev/x/y.go:9')[0]?.path === '~/dev/x/y.go');
  check('absolute path parses', refs('/Users/x/a.ts:44')[0]?.path === '/Users/x/a.ts');
  check('Makefile:line parses (no extension)', refs('Makefile:3')[0]?.path === 'Makefile');
  check('Makefile.docker.mk-style parses', refs('tools/make/kube.mk:101')[0]?.path === 'tools/make/kube.mk');

  check('bare time is not a ref', refs('meeting at 12:30 today').length === 0);
  check('version:port is not a ref', refs('v1.2.3:4 and 1.14.13:80').length === 0);
  check('two refs in one line both found', refs('a/b.ts:1 and c/d.go:2').length === 2);

  // The index matters: xterm link ranges are built from it.
  const idx = refs('xx yy server/a.js:7');
  check('match index is exact', idx[0]?.index === 6, String(idx[0]?.index));

  check('editorUrl shape', editorUrl('/a/b.c', 10, 2) === 'vscode://file/a/b.c:10:2');
  check('editorUrl without col', editorUrl('/a/b.c', 10, null) === 'vscode://file/a/b.c:10');
}

// ---------------------------------------------------------------- fixture repo + server
// realpath immediately: macOS tmpdir is a symlink into /private, and the server (correctly)
// answers in realpaths — expectations must be stated in the same terms.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-verify-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });

const g = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
g('init', '-q');
g('config', 'user.email', 'verify@devboard');
g('config', 'user.name', 'verify');
fs.writeFileSync(path.join(repo, 'src', 'main.go'), 'package main // v1\nfunc main() {}\n');
g('add', '.');
g('commit', '-qm', 'v1');
const SHA1 = g('rev-parse', 'HEAD').trim();
// Diverge the working tree, and add a file that does NOT exist at SHA1.
fs.writeFileSync(path.join(repo, 'src', 'main.go'), 'package main // v2 WORKING TREE\nfunc main() {}\n');
fs.writeFileSync(path.join(repo, 'src', 'new.go'), 'package main // only in worktree\n');
// A file outside any repo, inside the root.
fs.writeFileSync(path.join(tmp, 'plain.txt'), 'no repo here\n');

// Stub editor: records its argv so /open can be verified without ever popping a real window.
const editorLog = path.join(tmp, 'editor-args');
const editorStub = path.join(tmp, 'code-stub.sh');
fs.writeFileSync(editorStub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${editorLog}"\n`);
fs.chmodSync(editorStub, 0o755);

const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DEVBOARD_TERMINAL_ROOTS: tmp,
    DEVBOARD_ENV_ROOT: path.join(tmp, 'env-state'),
    DEVBOARD_CODE_BIN: editorStub,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
if (!(await until(async () => (await fetch(`${BASE}/api/health`)).ok))) {
  console.error('server did not come up');
  process.exit(1);
}

const post = (p, body) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  // ---------------------------------------------------------------- resolve
  {
    const r = await (await post('/api/code/resolve', {
      cwd: repo,
      candidates: [
        { path: 'src/main.go' },                       // relative, exists
        { path: path.join(repo, 'src', 'main.go') },   // absolute, exists
        { path: 'src/nope.go' },                       // missing
        { path: '../../../../etc/passwd' },            // traversal out of the root
        { path: '/etc/passwd' },                       // absolute outside the root
        { path: 'src' },                               // directory, not a file
      ],
    })).json();
    const [rel, abs, miss, trav, out, dir] = r.results;
    check('relative path resolves', rel.ok && rel.absPath === path.join(repo, 'src', 'main.go'));
    check('absolute path resolves', abs.ok === true);
    check('missing file does not linkify', miss.ok === false && miss.error === 'not found');
    check('traversal is contained', trav.ok === false, JSON.stringify(trav));
    check('absolute outside roots is refused', out.ok === false && out.error === 'outside allowed roots');
    check('directories do not linkify', dir.ok === false);
  }
  {
    const r = await post('/api/code/resolve', { cwd: repo, candidates: new Array(65).fill({ path: 'x' }) });
    check('oversized batch is rejected', r.status === 400);
  }

  // ---------------------------------------------------------------- peek: working tree
  {
    const r = await (await fetch(`${BASE}/api/code/peek?cwd=${encodeURIComponent(repo)}&path=src/main.go`)).json();
    check('working-tree peek returns current content', r.content.includes('v2 WORKING TREE'));
    check('working-tree peek says so', r.source === 'working-tree' && r.ref === null, JSON.stringify({ source: r.source }));
    check('language inferred from extension', r.language === 'go');
    check('repo root detected', r.repoRoot === repo);
  }

  // ---------------------------------------------------------------- peek: pinned ref
  {
    const r = await (await fetch(
      `${BASE}/api/code/peek?cwd=${encodeURIComponent(repo)}&path=src/main.go&ref=${SHA1.slice(0, 8)}`
    )).json();
    check('pinned peek returns the content AT THE REF, not the working tree',
      r.content.includes('// v1') && !r.content.includes('WORKING TREE'), r.content.slice(0, 40));
    check('short ref resolves to the full sha', r.ref?.resolved === SHA1, JSON.stringify(r.ref));
    check('pinned peek says source=ref', r.source === 'ref');
  }
  {
    const r = await fetch(`${BASE}/api/code/peek?cwd=${encodeURIComponent(repo)}&path=src/new.go&ref=${SHA1}`);
    const b = await r.json();
    check('file absent at the ref is an explicit 404, never a silent working-tree fallback',
      r.status === 404 && /does not exist at/.test(b.error), JSON.stringify(b));
  }
  {
    const r = await fetch(`${BASE}/api/code/peek?cwd=${encodeURIComponent(repo)}&path=src/main.go&ref=deadbeef99`);
    check('unknown ref is a 404 with a clear message', r.status === 404, String(r.status));
  }
  {
    const r = await fetch(`${BASE}/api/code/peek?cwd=${encodeURIComponent(tmp)}&path=plain.txt&ref=${SHA1}`);
    check('ref requested outside any git repo is a 400', r.status === 400, String(r.status));
  }
  {
    const r = await fetch(`${BASE}/api/code/peek?cwd=${encodeURIComponent(tmp)}&path=plain.txt`);
    const b = await r.json();
    check('non-repo file peeks fine from the working tree', b.content === 'no repo here\n' && b.repoRoot === null);
  }
  {
    const r = await fetch(`${BASE}/api/code/peek?cwd=${encodeURIComponent(repo)}&path=/etc/passwd`);
    check('peek is contained to the roots too', r.status === 403, String(r.status));
  }

  // ---------------------------------------------------------------- open in editor
  const editorArgs = () => fs.readFileSync(editorLog, 'utf8').trim().split('\n');
  {
    const r = await post('/api/code/open', { cwd: repo, path: 'src/main.go', line: 2, col: 5 });
    const b = await r.json();
    check('open succeeds for a file under the cwd', r.ok, JSON.stringify(b));
    // The point of the feature: the SESSION CWD becomes the workspace argument, so VS Code opens
    // the whole directory with the file revealed — not a lone file.
    check('file under cwd → workspace is the cwd',
      b.workspace === repo &&
        JSON.stringify(editorArgs()) ===
          JSON.stringify([repo, '--goto', `${path.join(repo, 'src', 'main.go')}:2:5`]),
      JSON.stringify({ workspace: b.workspace, args: editorArgs() }));
  }
  {
    const r = await post('/api/code/open', { cwd: repo, path: path.join(tmp, 'plain.txt'), line: 1 });
    const b = await r.json();
    check('file outside the cwd opens bare — no guessed workspace',
      r.ok && b.workspace === null &&
        JSON.stringify(editorArgs()) === JSON.stringify(['--goto', `${path.join(tmp, 'plain.txt')}:1`]),
      JSON.stringify({ workspace: b.workspace, args: editorArgs() }));
  }
  {
    const r = await post('/api/code/open', { cwd: repo, path: '/etc/passwd', line: 1 });
    check('open is contained to the roots', r.status === 403, String(r.status));
  }
  {
    const r = await post('/api/code/open', { cwd: repo, path: 'src/nope.go', line: 1 });
    check('open of a missing file is a 404', r.status === 404, String(r.status));
  }
} finally {
  server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
