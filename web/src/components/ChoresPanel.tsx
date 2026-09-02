import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Chore, Scope, TerminalTarget } from '../types';
import { EditOverlay } from './EditOverlay';
import { ReadOverlay } from './ReadOverlay';
import { RunSessionButton } from './RunSessionButton';
import { ConfirmDialog, copyText, formatTimestamp, Pager, Panel, toast } from './ui';

const PAGE_SIZE = 6;

/** Each section tracks its own chores, so the commands and paths differ per scope. */
const CHORE_COPY: Record<Scope, { start: string; end: string; dir: string }> = {
  work: {
    start: '/start-chore',
    end: '/end-chore',
    dir: '~/.claude/chores',
  },
  personal: {
    start: '/start-personal-chore',
    end: '/end-personal-chore',
    dir: '~/.claude/personal/chores',
  },
};

/**
 * Active chores — everything currently tracked by /start-chore (work) or
 * /start-personal-chore (personal). Chores are usually written by the agent, but the board also
 * supports explicit edits and deletion (same effect as the matching /end-* command: file + index
 * row).
 */
export function ChoresPanel({
  scope,
  refreshSignal,
  openTerminals,
  onRunSession,
  onRestoreTerminal,
}: {
  scope: Scope;
  refreshSignal?: number;
  openTerminals?: TerminalTarget[] | null;
  onRunSession: (t: TerminalTarget) => void;
  onRestoreTerminal: (t: TerminalTarget) => void;
}) {
  const [items, setItems] = useState<Chore[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState<Chore | null>(null);
  const [editing, setEditing] = useState<Chore | null>(null);
  const [deleting, setDeleting] = useState<Chore | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listChores(scope, page, PAGE_SIZE, q)
      .then((res) => {
        setItems(res.items);
        setPages(res.pages);
        setTotal(res.total);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [scope, page, q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 120 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Chore files change under us as the agent works; poll so the board stays live.
  useEffect(() => {
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(load, [load, refreshSignal]);

  const toggle = (f: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(f) ? next.delete(f) : next.add(f);
      return next;
    });

  const doDelete = async (c: Chore) => {
    try {
      await api.deleteChore(scope, c.filename);
      toast(`Ended chore ${c.filename}`, 'ok');
      setDeleting(null);
      load();
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'err');
    }
  };

  const copy = CHORE_COPY[scope];

  return (
    <>
      <Panel
        title="Active chores"
        chip={`${total} tracked`}
        actions={
          <input
            className="btn"
            style={{ minWidth: 260, background: 'var(--panel)' }}
            placeholder="Fuzzy search chores…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        }
      >
        {error && (
          <div className="error-banner" style={{ margin: 14 }}>
            {error}
          </div>
        )}

        {items.length === 0 ? (
          <div className="empty">
            {q ? (
              <>No chore matches “{q}”.</>
            ) : (
              <>
                No chores in flight. Start one with <code>{copy.start} &lt;item&gt;</code> in a
                agent session — tracked in <code>{copy.dir}</code>.
              </>
            )}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-ts">Timestamp</th>
                <th>Filename</th>
                <th>Chore</th>
                <th style={{ width: 196 }}>Progress</th>
                <th className="col-session">Session ID</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const open = expanded.has(c.filename);
                return (
                  <Fragment key={c.filename}>
                    <tr className="row clickable-row" onClick={() => setReading(c)}>
                      <td className="cell-ts">{formatTimestamp(c.mtime)}</td>
                      <td className="cell-file">{c.filename}</td>
                      <td className="cell-name">
                        <div className="name-line">
                          <button
                            className="expander"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(c.filename);
                            }}
                          >
                            {open ? '▾' : '▸'}
                          </button>
                          <span className="name-text">{c.title}</span>
                        </div>
                        {c.sections.happening[0] && (
                          <div className="chore-now">
                            <span className="arrow">▸ now</span>
                            <span>{c.sections.happening[0]}</span>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="chore-progress">
                          <span className="pill done">{c.progress.done} done</span>
                          <span className="pill happening">{c.progress.happening} now</span>
                          <span className="pill pending">{c.progress.pending} left</span>
                        </div>
                      </td>
                      <td>
                        <div className="cell-session">
                          {c.sessions.length === 0 ? (
                            <span style={{ color: 'var(--faint)' }}>—</span>
                          ) : (
                            c.sessions.map((s) => (
                              <Fragment key={`${s.agent}:${s.id}`}>
                                <span title={s.directory || c.directory || ''}>
                                  {s.agent}:{s.id.slice(0, 8)}…
                                </span>
                                <button
                                  className="copy"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyText(s.id, 'Session ID');
                                  }}
                                  title={s.id}
                                >
                                  copy
                                </button>
                              </Fragment>
                            ))
                          )}
                        </div>
                        {c.directory && (
                          <div className="cell-session" style={{ marginTop: 4 }}>
                            <span
                              style={{ color: 'var(--faint)', fontSize: 10 }}
                              title={c.directory}
                            >
                              {c.directory.replace(/^\/Users\/[^/]+/, '~')}
                            </span>
                            <button
                              className="copy"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyText(c.directory!, 'Directory');
                              }}
                            >
                              copy
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="btn sm" onClick={(e) => { e.stopPropagation(); setEditing(c); }}>
                            Edit
                          </button>
                          <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); setDeleting(c); }}>
                            Delete
                          </button>
                          <span onClick={(e) => e.stopPropagation()}>
                          <RunSessionButton
                            scope={scope}
                            kind="chore"
                            filename={c.filename}
                            title={c.title}
                            directory={c.directory}
                            candidates={c.sessions}
                            openTerminals={openTerminals}
                            onOpen={onRunSession}
                            onRestore={onRestoreTerminal}
                          />
                          </span>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="keywords-row">
                        <td colSpan={6}>
                          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
                            <ChoreSection label="What is done" items={c.sections.done} tone="done" />
                            <ChoreSection
                              label="What is happening"
                              items={c.sections.happening}
                              tone="happening"
                            />
                            <ChoreSection
                              label="What is pending"
                              items={c.sections.pending}
                              tone="pending"
                            />
                          </div>
                          {c.summary && (
                            <div className="keywords-summary" style={{ marginTop: 12 }}>
                              <span className="keywords-label">index</span> {c.summary}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        <Pager
          page={page}
          pages={pages}
          total={total}
          pageSize={PAGE_SIZE}
          onPage={setPage}
          unit="chores"
        />
      </Panel>

      {reading && (
        <ReadOverlay
          load={() => api.readChore(scope, reading.filename)}
          onClose={() => setReading(null)}
          onDelete={() => {
            setDeleting(reading);
            setReading(null);
          }}
          onEdit={() => {
            setEditing(reading);
            setReading(null);
          }}
        />
      )}

      {editing && (
        <EditOverlay
          scope={scope}
          kind="chore"
          filename={editing.filename}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="End this chore?"
          message={`Deletes the chore file and its index.txt row — the same thing ${copy.end} does. Chores are not meant to persist.`}
          file={deleting.filename}
          confirmLabel="Delete chore"
          onConfirm={() => void doDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

    </>
  );
}

function ChoreSection({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: 'done' | 'happening' | 'pending';
}) {
  return (
    <div style={{ minWidth: 240, flex: 1 }}>
      <div className="keywords-label">
        <span className={`pill ${tone}`}>{items.length}</span> {label}
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--faint)', fontSize: 12 }}>—</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--muted)' }}>
          {items.map((it, i) => (
            <li key={i} style={{ margin: '3px 0' }}>
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
