import { useRef, useState } from 'react';
import type { SessionRef } from '../types';
import { copyText, relativeTime } from './ui';

/**
 * The Active column. One dot per session associated with the learning file:
 * green = a live agent session, grey = known but idle. Hovering shows the session id and
 * the directory, both copy-able (the tooltip stays open while the pointer is inside it).
 */
export function ActiveDots({ sessions }: { sessions: SessionRef[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const closeTimer = useRef<number | undefined>(undefined);

  const show = (e: React.MouseEvent) => {
    window.clearTimeout(closeTimer.current);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 6 });
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };
  const keep = () => window.clearTimeout(closeTimer.current);

  if (sessions.length === 0) {
    return (
      <span
        className="session-dots"
        onMouseEnter={show}
        onMouseLeave={hide}
        aria-label="no session recorded"
      >
        <span className="dot none" />
        {open && (
          <div
            className="tip"
            style={{ left: pos.x, top: pos.y }}
            onMouseEnter={keep}
            onMouseLeave={hide}
          >
            <div className="tip-row">
              <span className="tip-key">—</span>
              <span className="tip-val">
                No agent session recorded for this file — either it predates session tracking
                (transcripts are pruned after ~30 days) or the handoff never wrote one
              </span>
            </div>
          </div>
        )}
      </span>
    );
  }

  return (
    <span className="session-dots" onMouseEnter={show} onMouseLeave={hide}>
      {sessions.map((s) => (
        <span
          key={s.id}
          className={`dot ${s.active ? 'on' : 'off'}`}
          aria-label={`${s.active ? 'active' : 'inactive'} session ${s.id}`}
        />
      ))}
      {open && (
        <div
          className="tip"
          style={{ left: pos.x, top: pos.y }}
          onMouseEnter={keep}
          onMouseLeave={hide}
        >
          {sessions.map((s) => (
            <div key={s.id} style={{ marginBottom: 8 }}>
              <div className="tip-row">
                <span className={`dot ${s.active ? 'on' : 'off'}`} />
                <span className="tip-val" style={{ color: s.active ? '#3fb950' : '#8b96a5' }}>
                  {s.active ? 'ACTIVE' : 'inactive'} · last seen {relativeTime(s.lastSeen)}
                </span>
              </div>
              <div className="tip-row">
                <span className="tip-key">{s.agent}</span>
                <span className="tip-val">{s.id}</span>
                <button className="copy" onClick={() => copyText(s.id, 'Session ID')}>
                  copy
                </button>
              </div>
              {s.directory && (
                <div className="tip-row">
                  <span className="tip-key">dir</span>
                  <span className="tip-val">{s.directory}</span>
                  <button className="copy" onClick={() => copyText(s.directory!, 'Directory')}>
                    copy
                  </button>
                </div>
              )}
              {s.directory && (
                <div className="tip-row">
                  <span className="tip-key">resume</span>
                  <span className="tip-val">{`cd ${s.directory} && ${
                    s.agent === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`
                  }`}</span>
                  <button
                    className="copy"
                    onClick={() =>
                      copyText(
                        `cd ${s.directory} && ${
                          s.agent === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`
                        }`,
                        'Resume command'
                      )
                    }
                  >
                    copy
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
