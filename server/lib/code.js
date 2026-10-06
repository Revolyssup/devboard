import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileP = promisify(execFile);

/**
 * Code reference resolution and pinned peeks.
 *
 * Backs the terminal's file:line links. Two operations, deliberately separate:
 *
 *   resolve — cheap existence checks so the client can VERIFY BEFORE LINKIFYING. A citation that
 *             does not resolve simply never becomes a link, which makes the link itself a
 *             confidence signal about the agent's claim.
 *   peek    — file content at an EXPLICIT ref via `git show`, else the working tree, always
 *             labeled with which one it is. VS Code deep links can only show the working tree;
 *             this is the half it cannot do — checking a claim against the commit it was made at.
 *
 * Both are read-only, and both apply the same root containment as the terminal PTYs: this server
 * runs with the user's credentials, so these endpoints must not become a read-anything oracle for
 * whatever page can reach localhost.
 */

/**
 * Same containment rule as terminals.js applies to PTY cwds, applied to a file path — but on
 * REALPATHS, both sides. Two reasons, one of them a bug found by the test suite:
 *   - macOS /var and /tmp are symlinks into /private, while `git rev-parse --show-toplevel`
 *     returns the realpath; comparing unresolved paths made path.relative() produce garbage and
 *     every pinned peek 404.
 *   - a symlink inside a root pointing outside it must not widen what these endpoints can read.
 */
function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function withinRoots(realResolved) {
  return config.terminalRoots.some((root) => {
    const r = realOrNull(path.resolve(root));
    return r !== null && (realResolved === r || realResolved.startsWith(r + path.sep));
  });
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve one candidate reference against a base directory.
 *
 * Only two interpretations are tried: absolute (after ~ expansion) and relative to `cwd`. No
 * guessing across repo roots — a candidate that does not resolve is reported as such, and the
 * client shows plain text. False negatives cost a missing underline; false positives would
 * linkify a wrong claim, which is worse.
 */
export function resolveCandidate(cwd, candidate) {
  const raw = expandHome(String(candidate || ''));
  if (!raw) return { ok: false, error: 'empty path' };

  const joined = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(expandHome(String(cwd || '')), raw);

  // Realpath needs the file to exist, so existence is checked first. This means a MISSING path
  // outside the roots reports 'not found' rather than 'outside allowed roots' — acceptable, since
  // it reveals only that nothing is there.
  const abs = realOrNull(joined);
  if (abs === null) return { ok: false, error: 'not found' };
  if (!withinRoots(abs)) return { ok: false, error: 'outside allowed roots' };

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { ok: false, error: 'not found' };
  }
  if (!st.isFile()) return { ok: false, error: 'not a file' };
  return { ok: true, absPath: abs };
}

async function git(repoDir, args) {
  const { stdout } = await execFileP('git', ['-C', repoDir, ...args], {
    maxBuffer: 8 << 20,
    timeout: 10_000,
  });
  return stdout;
}

async function repoRootOf(dir) {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

// A peek is for reading around a line, not for shipping repos over HTTP.
const MAX_PEEK_BYTES = 2 * 1024 * 1024;

/**
 * File content for the peek overlay.
 *
 * With `ref`: content comes from `git show <ref>:<relpath>` — the file as it was at that commit,
 * regardless of what the working tree has become. Without: the working tree, and the result says
 * so (`source: 'working-tree'`) rather than letting the UI imply a pin that does not exist.
 */
export async function peekFile({ cwd, path: candidate, ref = null }) {
  const r = resolveCandidate(cwd, candidate);
  if (!r.ok) {
    const err = new Error(`${candidate}: ${r.error}`);
    err.status = r.error === 'outside allowed roots' ? 403 : 404;
    throw err;
  }
  const abs = r.absPath;
  const repoRoot = await repoRootOf(path.dirname(abs));

  let content;
  let resolvedRef = null;

  if (ref) {
    if (!repoRoot) {
      const err = new Error(`a ref was requested but ${abs} is not inside a git repository`);
      err.status = 400;
      throw err;
    }
    // Resolve to the full SHA first: it is what gets displayed, and a bad ref should fail here
    // with a clear message rather than inside `git show`'s less helpful one.
    try {
      resolvedRef = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    } catch {
      const err = new Error(`unknown ref '${ref}' in ${repoRoot}`);
      err.status = 404;
      throw err;
    }
    const rel = path.relative(repoRoot, abs);
    try {
      content = await git(repoRoot, ['show', `${resolvedRef}:${rel}`]);
    } catch {
      // The honest answer, not a fallback to the working tree: silently substituting current
      // content for pinned content is exactly the confusion the peek exists to remove.
      const err = new Error(`${rel} does not exist at ${resolvedRef.slice(0, 12)}`);
      err.status = 404;
      throw err;
    }
  } else {
    const st = fs.statSync(abs);
    if (st.size > MAX_PEEK_BYTES) {
      const err = new Error(`file is ${st.size} bytes; peek is capped at ${MAX_PEEK_BYTES}`);
      err.status = 413;
      throw err;
    }
    content = fs.readFileSync(abs, 'utf8');
  }

  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > MAX_PEEK_BYTES) {
    content = content.slice(0, MAX_PEEK_BYTES);
    truncated = true;
  }

  return {
    absPath: abs,
    repoRoot,
    source: ref ? 'ref' : 'working-tree',
    ref: ref ? { requested: ref, resolved: resolvedRef } : null,
    language: languageFor(abs),
    totalLines: content.split('\n').length,
    truncated,
    content,
  };
}

/** Extension → highlight.js language id, for the subset that actually appears in this work. */
function languageFor(p) {
  const ext = path.extname(p).toLowerCase();
  const base = path.basename(p);
  const map = {
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.jsx': 'javascript',
    '.go': 'go',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.hpp': 'cpp',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'xml',
    '.xml': 'xml',
    '.sql': 'sql',
    '.proto': 'protobuf',
    '.toml': 'ini',
    '.ini': 'ini',
  };
  if (map[ext]) return map[ext];
  if (base === 'Makefile' || base.startsWith('Makefile.')) return 'makefile';
  if (base === 'Dockerfile') return 'dockerfile';
  return null;
}

/**
 * Open the reference in the editor, server-side, via the `code` CLI.
 *
 * The vscode://file URL can only open a bare file. What Ashish actually wants when the file
 * belongs to the session he is debugging is the whole workspace around it — file tree, search,
 * git gutter — with the cursor on the cited line. `code <folder> --goto file:line:col` does
 * exactly that in one invocation, and reuses an existing window that already has the folder open.
 *
 * Rule: the session's cwd becomes the workspace ONLY when the file is inside it. A reference
 * pointing elsewhere (another repo, a ~/ path) opens as a bare file, same as before — silently
 * opening some other directory as a workspace would be a guess about intent.
 *
 * DEVBOARD_CODE_BIN overrides the binary — used by the test suites so verifying this never pops
 * real editor windows.
 */
function editorBin() {
  if (process.env.DEVBOARD_CODE_BIN) return process.env.DEVBOARD_CODE_BIN;
  for (const p of ['/opt/homebrew/bin/code', '/usr/local/bin/code']) {
    if (fs.existsSync(p)) return p;
  }
  return 'code';
}

export async function openInEditor({ cwd, path: candidate, line = 1, col = null }) {
  const r = resolveCandidate(cwd, candidate);
  if (!r.ok) {
    const err = new Error(`${candidate}: ${r.error}`);
    err.status = r.error === 'outside allowed roots' ? 403 : 404;
    throw err;
  }
  const abs = r.absPath;

  // The cwd itself must also be contained and real — it is about to be handed to an editor as a
  // workspace to open.
  const realCwd = realOrNull(path.resolve(expandHome(String(cwd || ''))));
  const cwdOk = realCwd !== null && withinRoots(realCwd) && fs.statSync(realCwd).isDirectory();
  const inCwd = cwdOk && (abs === realCwd || abs.startsWith(realCwd + path.sep));

  const goto = `${abs}:${Number(line) || 1}${col ? `:${Number(col)}` : ''}`;
  const args = inCwd ? [realCwd, '--goto', goto] : ['--goto', goto];

  await execFileP(editorBin(), args, { timeout: 15_000 });
  return { opened: goto, workspace: inCwd ? realCwd : null };
}
