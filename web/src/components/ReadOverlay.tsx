import { useEffect, useState } from 'react';
import type { FileContent } from '../types';
import { Markdown } from './Markdown';
import { useEscape } from './ui';

/** Read-only markdown view that hovers over the dashboard. */
export function ReadOverlay({
  load,
  onClose,
  onEdit,
  onDelete,
  openInTabHref,
}: {
  load: () => Promise<FileContent>;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  openInTabHref?: string;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  useEffect(() => {
    let alive = true;
    load()
      .then((f) => alive && setFile(f))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [load]);

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay wide" onClick={(e) => e.stopPropagation()}>
        <header className="overlay-head">
          <div className="titles">
            <h2>{file?.title || 'Loading…'}</h2>
            <div className="path">{file?.path || ''}</div>
          </div>
          {openInTabHref && (
            <a className="btn sm" href={openInTabHref} target="_blank" rel="noreferrer">
              Open in tab ↗
            </a>
          )}
          {onEdit && (
            <button className="btn sm" onClick={onEdit}>
              Edit
            </button>
          )}
          {onDelete && (
            <button className="btn sm danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button className="btn sm ghost" onClick={onClose}>
            Close ✕
          </button>
        </header>
        <div className="overlay-body">
          {error && <div className="error-banner">{error}</div>}
          {!file && !error && <div className="spinner">Loading…</div>}
          {file && <Markdown>{file.content}</Markdown>}
        </div>
      </div>
    </div>
  );
}
