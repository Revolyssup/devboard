/**
 * Detection of file:line references in free text (terminal output, primarily).
 *
 * Grammar: `path:line[:col][@sha]` — the `@sha` suffix is the emit-side convention for pinning a
 * reference to a commit, so a citation like `plan.js:123@92ba3a7` routes the peek to that exact
 * ref instead of the working tree.
 *
 * The matcher is deliberately permissive about *paths* and strict about *shape*:
 *   - the final segment must have a letter-bearing extension (or be a well-known extensionless
 *     name like Makefile), which is what keeps `12:30`, `v1.2.3:4` and IPv4:port out
 *   - anything that matches is still only a CANDIDATE — the server verifies existence before the
 *     client draws a link, so a false positive here costs one cheap request, not a wrong link
 *
 * Kept free of non-erasable TS syntax on purpose: scripts/verify-code.mjs imports this exact file
 * under Node's type stripping, so the tests exercise the same code the browser ships.
 */

export interface CodeRef {
  /** The full matched text, exactly as it appears in the line. */
  text: string;
  /** 0-based character offset of the match within the line. */
  index: number;
  path: string;
  line: number;
  col: number | null;
  sha: string | null;
}

// Segment charset excludes `@` (reserved for the sha suffix) and `:` (the line separator).
const SEG = '[A-Za-z0-9_.+-]+';
const LAST = `(?:[A-Za-z0-9_+-]+\\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}|Makefile(?:\\.${SEG})?|Dockerfile|Justfile|Rakefile|BUILD)`;

const REF_RE = new RegExp(
  // optional leading ~/, ./, ../, or /
  `(?:~/|\\.{1,2}/|/)?` +
    // any number of directory segments
    `(?:${SEG}/)*` +
    // final segment with a real extension (or known extensionless name)
    `${LAST}` +
    // :line, optional :col, optional @sha
    `:(\\d{1,6})(?::(\\d{1,4}))?(?:@([0-9a-f]{7,40}))?`,
  'g'
);

export function parseCodeRefs(text: string): CodeRef[] {
  const out: CodeRef[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    const full = m[0];
    const line = Number(m[1]);
    const col = m[2] ? Number(m[2]) : null;
    const sha = m[3] || null;
    // Reconstruct the path: everything before the first `:<line>` suffix we captured.
    const suffixLen =
      1 + m[1].length + (m[2] ? 1 + m[2].length : 0) + (sha ? 1 + sha.length : 0);
    const p = full.slice(0, full.length - suffixLen);
    if (line < 1) continue;
    out.push({ text: full, index: m.index, path: p, line, col, sha });
  }
  return out;
}

/** Deep link into the editor at an exact position. VS Code wants vscode://file/ABS:line:col. */
export function editorUrl(absPath: string, line: number, col: number | null): string {
  return `vscode://file${absPath}:${line}${col ? `:${col}` : ''}`;
}
