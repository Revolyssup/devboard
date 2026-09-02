import { Fragment, useState } from 'react';
import type { Learning, TerminalTarget } from '../types';
import { ActiveDots } from './ActiveDot';
import { RunSessionButton } from './RunSessionButton';
import { formatTimestamp } from './ui';

/**
 * The learnings table: Active | Timestamp | Filename | Learning name | actions,
 * with a hidden "Keywords" row per learning that expands from the ▸ toggle.
 */
export function LearningsTable({
  items,
  onRead,
  onEdit,
  onDelete,
  onRunSession,
  openTerminals,
  onRestoreTerminal,
}: {
  items: Learning[];
  onRead: (l: Learning) => void;
  onEdit: (l: Learning) => void;
  onDelete: (l: Learning) => void;
  onRunSession: (t: TerminalTarget) => void;
  openTerminals?: TerminalTarget[] | null;
  onRestoreTerminal?: (t: TerminalTarget) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (filename: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });

  if (items.length === 0) {
    return <div className="empty">No learning files here yet.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th className="col-active">Active</th>
          <th className="col-ts">Timestamp</th>
          <th>Filename</th>
          <th>Learning name</th>
          <th className="col-actions" />
        </tr>
      </thead>
      <tbody>
        {items.map((l) => {
          const open = expanded.has(l.filename);
          return (
            <Fragment key={l.filename}>
              <tr className="row clickable-row" onClick={() => onRead(l)}>
                <td>
                  <ActiveDots sessions={l.sessions} />
                </td>
                <td className="cell-ts">{formatTimestamp(l.mtime)}</td>
                <td className="cell-file">{l.filename}</td>
                <td className="cell-name">
                  <div className="name-line">
                    <button
                      className="expander"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(l.filename);
                      }}
                      aria-expanded={open}
                      aria-label={open ? 'Hide keywords' : 'Show keywords'}
                      title={open ? 'Hide keywords' : 'Show keywords'}
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <span className="name-text">{l.title}</span>
                  </div>
                  <div className="name-meta">
                    {l.meta?.track && <span className="tag">{l.meta.track}</span>}
                    {l.meta?.subtype && <span className="tag">{l.meta.subtype}</span>}
                    {l.meta?.outcome && (
                      <span className={`tag outcome-${l.meta.outcome}`}>{l.meta.outcome}</span>
                    )}
                    {l.meta?.confidence && (
                      <span className="tag">confidence {l.meta.confidence}</span>
                    )}
                    {!l.indexed && (
                      <span className="tag unindexed" title="No matching row in index.txt">
                        not in index
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" onClick={(e) => { e.stopPropagation(); onEdit(l); }}>
                      Edit
                    </button>
                    <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); onDelete(l); }}>
                      Delete
                    </button>
                    <span onClick={(e) => e.stopPropagation()}>
                    {/* Keep Run last so row action layout remains stable. */}
                    <RunSessionButton
                      scope={l.scope}
                      kind="learning"
                      filename={l.filename}
                      title={l.title}
                      directory={l.directory}
                      candidates={l.sessions}
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
                  <td colSpan={5}>
                    <div className="keywords-label">Keywords</div>
                    <div className="keyword-chips">
                      {l.keywords.length === 0 && (
                        <span style={{ color: 'var(--faint)', fontSize: 12 }}>
                          none — this file has no index row to derive keywords from
                        </span>
                      )}
                      {l.keywords.map((k) => (
                        <span className="keyword-chip" key={k}>
                          {k}
                        </span>
                      ))}
                    </div>
                    {l.summary && <div className="keywords-summary">{l.summary}</div>}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
