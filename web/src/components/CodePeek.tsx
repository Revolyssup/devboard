import { useEffect, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { editorUrl } from '../lib/codeRefs';
import { openInEditor } from '../lib/codeLinkProvider';

/**
 * Read-only code peek, honest about which version of the file it shows.
 *
 * With a pinned sha the content comes from `git show` — the file as it was at that commit, even
 * after the working tree moves on. Without one it shows the working tree and the header says
 * "working tree (unpinned)" rather than implying a pin that does not exist.
 *
 * Deliberately not an editor. Editing belongs in VS Code (the "Open in VS Code" button); this
 * view exists for the verification half VS Code cannot do — checking a claim against the commit
 * it was made at.
 */

interface PeekData {
  absPath: string;
  repoRoot: string | null;
  source: 'ref' | 'working-tree';
  ref: { requested: string; resolved: string } | null;
  language: string | null;
  totalLines: number;
  truncated: boolean;
  content: string;
}

export function CodePeek({
  cwd,
  path,
  line,
  sha,
  onClose,
}: {
  cwd: string;
  path: string;
  line: number;
  sha: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<PeekData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    const q = new URLSearchParams({ cwd, path });
    if (sha) q.set('ref', sha);
    fetch(`/api/code/peek?${q}`)
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [cwd, path, sha]);

  useEffect(() => {
    if (data) targetRef.current?.scrollIntoView({ block: 'center' });
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Highlight the whole file once; hljs emits the same hljs-* classes the markdown views already
  // style, so the peek inherits the existing theme with zero extra CSS work.
  const rows = (() => {
    if (!data) return [];
    let html: string[];
    try {
      const res = data.language
        ? hljs.highlight(data.content, { language: data.language })
        : hljs.highlightAuto(data.content);
      html = res.value.split('\n');
    } catch {
      html = data.content.split('\n').map((l) =>
        l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      );
    }
    return html;
  })();

  const refLabel = data
    ? data.source === 'ref'
      ? `@ ${data.ref!.resolved.slice(0, 12)}`
      : 'working tree (unpinned)'
    : '';

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay wide code-peek" onClick={(e) => e.stopPropagation()}>
        <header className="overlay-head">
          <div className="titles">
            <h2>
              {path}
              <span className="code-peek-line">:{line}</span>
            </h2>
            <div className="path">
              <span className={`code-peek-ref ${data?.source === 'ref' ? 'pinned' : 'unpinned'}`}>
                {refLabel}
              </span>
              {data?.truncated && <span className="code-peek-trunc"> · truncated at 2MB</span>}
            </div>
          </div>
          <div className="head-actions">
            {data && (
              <a
                className="btn sm"
                href={editorUrl(data.absPath, line, null)}
                onClick={(e) => {
                  // Server-side open lands in the session's workspace with the full tree; the
                  // href stays as the fallback (and for cmd-click/copy-link semantics).
                  e.preventDefault();
                  void openInEditor({ cwd, path, absPath: data.absPath, line, col: null });
                }}
              >
                Open in VS Code
              </a>
            )}
            <button className="btn sm" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {error && <div className="error-banner" style={{ margin: 14 }}>{error}</div>}
        {!data && !error && <div className="spinner">loading…</div>}

        {data && (
          <div className="code-peek-body">
            <table className="code-peek-table">
              <tbody>
                {rows.map((html, i) => (
                  <tr
                    key={i}
                    ref={i + 1 === line ? targetRef : undefined}
                    className={i + 1 === line ? 'code-peek-target' : undefined}
                  >
                    <td className="code-peek-num">{i + 1}</td>
                    {/* hljs output only; never raw file content as HTML without the escape
                        fallback above. */}
                    <td className="code-peek-src" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
