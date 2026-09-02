import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { FileContent, Scope } from '../types';
import { EditOverlay } from './EditOverlay';
import { Markdown } from './Markdown';
import { ConfirmDialog, formatTimestamp, toast } from './ui';

/**
 * The `/learning/:scope/:filename` tab a search result opens into: read-only by default,
 * with Edit and Delete in the top-right corner.
 */
export function StandaloneLearning({ scope, filename }: { scope: Scope; filename: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [gone, setGone] = useState(false);

  const load = useCallback(() => {
    api
      .readLearning(scope, filename)
      .then((f) => {
        setFile(f);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [scope, filename]);

  useEffect(load, [load]);

  useEffect(() => {
    if (file?.title) document.title = `${file.title} · devboard`;
  }, [file?.title]);

  const doDelete = async () => {
    try {
      await api.deleteLearning(scope, filename);
      setDeleting(false);
      setGone(true);
      toast(`Deleted ${filename}`, 'ok');
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'err');
    }
  };

  if (gone) {
    return (
      <div className="standalone">
        <div className="empty">
          <p>
            <code>{filename}</code> was deleted.
          </p>
          <a className="btn" href="/">
            Back to dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="standalone">
      <header className="standalone-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-sub" style={{ marginBottom: 4 }}>
            <a href="/">devboard</a> / {scope} / {filename}
          </div>
          <h1 className="page-title">{file?.title || filename}</h1>
          {file && (
            <p className="page-sub">
              {file.path} · last edited {formatTimestamp(file.mtime)} · {file.size.toLocaleString()}{' '}
              bytes
            </p>
          )}
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => setEditing(true)} disabled={!file}>
            Edit
          </button>
          <button className="btn danger" onClick={() => setDeleting(true)} disabled={!file}>
            Delete
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {!file && !error && <div className="spinner">Loading…</div>}
      {file && <Markdown>{file.content}</Markdown>}

      {editing && (
        <EditOverlay
          scope={scope}
          filename={filename}
          onClose={() => setEditing(false)}
          onSaved={load}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this learning?"
          message={
            scope === 'work'
              ? 'Removes the file from disk and drops its row from index.txt. This cannot be undone.'
              : 'Removes the file from disk. This cannot be undone.'
          }
          file={filename}
          onConfirm={() => void doDelete()}
          onCancel={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
