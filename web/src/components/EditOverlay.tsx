import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Scope } from '../types';
import { Markdown } from './Markdown';
import { toast, useEscape } from './ui';

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Editor for a learning file. The banner across the top always names the file being
 * edited, so it is never ambiguous which file the keystrokes are landing in.
 * Saving writes straight back to the file on disk (⌘S / Ctrl-S, or the Save button).
 */
export function EditOverlay({
  scope,
  filename,
  kind = 'learning',
  onClose,
  onSaved,
}: {
  scope: Scope;
  filename: string;
  kind?: 'learning' | 'chore';
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [state, setState] = useState<SaveState>('clean');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const dirty = content !== original;

  useEffect(() => {
    let alive = true;
    const read = kind === 'chore' ? api.readChore(scope, filename) : api.readLearning(scope, filename);
    read
      .then((f) => {
        if (!alive) return;
        setContent(f.content);
        setOriginal(f.content);
        setPath(f.path);
        setTitle(f.title);
        setTimeout(() => taRef.current?.focus(), 30);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [scope, filename, kind]);

  const save = useCallback(async () => {
    if (!dirty) return;
    setState('saving');
    try {
      const res =
        kind === 'chore'
          ? await api.saveChore(scope, filename, content)
          : await api.saveLearning(scope, filename, content);
      setOriginal(content);
      setTitle(res.title);
      setState('saved');
      toast(`Saved ${filename}`, 'ok');
      onSaved?.();
      setTimeout(() => setState((s) => (s === 'saved' ? 'clean' : s)), 2000);
    } catch (e) {
      setState('error');
      setError((e as Error).message);
      toast(`Save failed: ${(e as Error).message}`, 'err');
    }
  }, [content, dirty, filename, kind, onSaved, scope]);

  const tryClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [dirty, onClose]);

  useEscape(tryClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const stateLabel =
    state === 'saving'
      ? 'saving…'
      : state === 'error'
        ? 'save failed'
        : dirty
          ? 'unsaved changes'
          : state === 'saved'
            ? 'saved ✓'
            : 'no changes';

  return (
    <div className="overlay-backdrop" onClick={tryClose}>
      <div className="overlay wide" onClick={(e) => e.stopPropagation()}>
        <div className="editing-banner">
          <span>✎ EDITING</span>
          <strong>{filename}</strong>
          <span style={{ color: 'var(--faint)' }}>{path}</span>
        </div>
        <header className="overlay-head">
          <div className="titles">
            <h2>{title}</h2>
            <div className="path">
              {scope} {kind} · edits are written straight to this file on disk
            </div>
          </div>
          <button className="btn sm" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Edit source' : 'Preview'}
          </button>
          <button className="btn sm ghost" onClick={tryClose}>
            Close ✕
          </button>
        </header>

        {error && (
          <div className="error-banner" style={{ margin: '12px 16px 0' }}>
            {error}
          </div>
        )}

        {preview ? (
          <div className="overlay-body">
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="editor"
            value={content}
            spellCheck={false}
            onChange={(e) => {
              setContent(e.target.value);
              setState('dirty');
            }}
          />
        )}

        <footer className="overlay-foot">
          <button className="btn primary" onClick={() => void save()} disabled={!dirty || state === 'saving'}>
            Save
          </button>
          <button
            className="btn"
            onClick={() => {
              setContent(original);
              setState('clean');
            }}
            disabled={!dirty}
          >
            Revert
          </button>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)' }}>
            ⌘S to save · Esc to close
          </span>
          <span
            className={`save-state ${state === 'error' ? 'error' : dirty ? 'dirty' : state === 'saved' ? 'saved' : ''}`}
          >
            {stateLabel}
          </span>
        </footer>
      </div>
    </div>
  );
}
