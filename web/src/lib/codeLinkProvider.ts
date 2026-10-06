import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { parseCodeRefs, editorUrl, type CodeRef } from './codeRefs';

/**
 * xterm link provider for file:line references in agent output.
 *
 * VERIFY BEFORE LINKIFY: a candidate only becomes a link after /api/code/resolve confirms the
 * file exists under the session's cwd (within the server's allowed roots). The underline is
 * therefore itself a signal — a cited path that stays plain text is a citation that did not
 * check out.
 *
 * Interaction: click opens the editor at the exact line (vscode:// deep link); Alt+click opens
 * the in-devboard peek — pinned to the ref when the reference carries `@sha`, else the working
 * tree, labeled either way.
 */

export interface PeekRequest {
  path: string;      // as written in the terminal; the peek endpoint re-resolves it
  absPath: string;
  line: number;
  sha: string | null;
}

interface ResolveOutcome {
  ok: boolean;
  absPath?: string;
}

/**
 * Open a reference in VS Code, preferring the server-side `code` CLI: when the file sits inside
 * the session's cwd, that opens THE WHOLE DIRECTORY as the workspace (file tree, search, git
 * state) with the cursor on the cited line — the vscode:// URL scheme cannot express that. The
 * URL is kept as the fallback for when the CLI is unavailable.
 */
export async function openInEditor(req: {
  cwd: string;
  path: string;
  absPath: string;
  line: number;
  col: number | null;
}): Promise<void> {
  try {
    const r = await fetch('/api/code/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: req.cwd, path: req.path, line: req.line, col: req.col }),
    });
    if (r.ok) return;
  } catch {
    /* fall through to the URL scheme */
  }
  const a = document.createElement('a');
  a.href = editorUrl(req.absPath, req.line, req.col);
  a.click();
}

export function createCodeLinkProvider(
  term: Terminal,
  opts: { cwd: string; onPeek: (req: PeekRequest) => void }
): ILinkProvider {
  // provideLinks fires on every row hover, and agent output repeats the same paths constantly —
  // cache by candidate path. Entries are promises so concurrent hovers over the same path share
  // one request instead of racing.
  const cache = new Map<string, Promise<ResolveOutcome>>();

  const resolveAll = (refs: CodeRef[]): Promise<ResolveOutcome[]> => {
    const misses = refs.filter((r) => !cache.has(r.path));
    if (misses.length > 0) {
      const batch = fetch('/api/code/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: opts.cwd, candidates: misses.map((r) => ({ path: r.path })) }),
      })
        .then((res) => (res.ok ? res.json() : { results: [] }))
        .catch(() => ({ results: [] as ResolveOutcome[] }));
      misses.forEach((r, i) => {
        cache.set(
          r.path,
          batch.then((b: { results: ResolveOutcome[] }) => b.results[i] ?? { ok: false })
        );
      });
    }
    return Promise.all(refs.map((r) => cache.get(r.path)!));
  };


  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      // NOTE: translateToString on one buffer row — a reference split across a wrapped line is
      // not detected. Known v1 limitation; wide terminals make it rare in practice.
      const row = term.buffer.active.getLine(y - 1);
      const text = row?.translateToString(true) ?? '';
      const refs = parseCodeRefs(text);
      if (refs.length === 0) return callback(undefined);

      resolveAll(refs).then((outcomes) => {
        const links: ILink[] = [];
        refs.forEach((ref, i) => {
          const out = outcomes[i];
          if (!out?.ok || !out.absPath) return;
          const absPath = out.absPath;
          links.push({
            // xterm ranges are 1-based and end-inclusive.
            range: {
              start: { x: ref.index + 1, y },
              end: { x: ref.index + ref.text.length, y },
            },
            text: ref.text,
            decorations: { underline: true, pointerCursor: true },
            activate(event: MouseEvent) {
              if (event.altKey) {
                opts.onPeek({ path: ref.path, absPath, line: ref.line, sha: ref.sha });
              } else {
                void openInEditor({ cwd: opts.cwd, path: ref.path, absPath, line: ref.line, col: ref.col });
              }
            },
          });
        });
        callback(links.length ? links : undefined);
      });
    },
  };
}
