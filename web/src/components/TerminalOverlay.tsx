import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTarget } from '../types';
import { api } from '../api';
import { toast } from './ui';

/** Seconds to wait after the chore file disappears before closing, so the tail is readable. */
const CLOSE_COUNTDOWN = 10;

type Status = 'connecting' | 'live' | 'exited' | 'error';

/**
 * A live agent session in a popup.
 *
 * Two deliberate departures from the other overlays in this app: clicking the backdrop does not
 * close, and Escape is not bound. Escape is an agent interrupt key and must reach the session, and
 * a stray backdrop click must never kill a running turn. Closing is the ✕ button only.
 */
export function TerminalOverlay({
  target,
  minimized,
  fullscreen,
  onMinimize,
  onToggleFullscreen,
  onClose,
  onChoreGone,
  onChoreChanged,
  onTargetUpdate,
}: {
  target: TerminalTarget;
  minimized: boolean;
  fullscreen: boolean;
  onMinimize: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  onChoreGone?: () => void;
  onChoreChanged?: () => void;
  onTargetUpdate?: (patch: Partial<TerminalTarget>) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const startedRef = useRef(false); // StrictMode double-invokes effects in dev

  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);
  const [endWarned, setEndWarned] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(
    target.kind === 'new' ? null : target.sessionId
  );
  const [learningFile, setLearningFile] = useState<string | null>(null);
  const [choreFile, setChoreFile] = useState<string | null>(null);

  const isChore = target.kind === 'chore' || target.newKind === 'chore';
  const isNew = target.kind === 'new';

  const close = useCallback(() => {
    try {
      wsRef.current?.send(JSON.stringify({ t: 'kill' }));
    } catch {
      /* already gone */
    }
    // Always close cleanly: an abandoned in-flight socket logs a console error, and the verify
    // suite asserts a zero-console-error budget.
    try {
      wsRef.current?.close(1000, 'closed by user');
    } catch {
      /* ignore */
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#0b0e13',
        foreground: '#dbe2ea',
        cursor: '#58a6ff',
        selectionBackground: '#1f6feb55',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    (async () => {
      // Mount and size before the preflight, so claude's very first paint is already the right
      // shape. Fitting a zero-size flex child yields a garbage grid, hence the rAF.
      if (!hostRef.current) return;
      term.open(hostRef.current);
      await new Promise((r) => requestAnimationFrame(r));
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }

      let ticket;
      try {
        ticket =
          target.kind === 'new'
            ? await api.openNewTerminal(target, term.cols, term.rows)
            : await api.openTerminal(target, term.cols, term.rows);
      } catch (e) {
        if (disposed) return;
        setStatus('error');
        setError((e as Error).message);
        return;
      }
      if (disposed) return;
      setWarnings(ticket.warnings || []);
      if (ticket.sessionId) {
        setSessionId(ticket.sessionId);
        onTargetUpdate?.({ sessionId: ticket.sessionId });
      }
      if (ticket.filename) {
        onTargetUpdate?.({ filename: ticket.filename });
      }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${proto}//${location.host}/api/terminal?ticket=${encodeURIComponent(ticket.ticket)}`
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => !disposed && setStatus('live');

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          // PTY output is binary on purpose: JSON-wrapping it would split multi-byte UTF-8
          // across chunk boundaries, and this TUI is wall-to-wall box drawing.
          term.write(new Uint8Array(ev.data));
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.t === 'error') {
          setStatus('error');
          setError(String(msg.message));
        } else if (msg.t === 'transcript-drift' || msg.t === 'warning') {
          const code = String(msg.code || (msg.t === 'transcript-drift' ? 'TRANSCRIPT_DRIFT' : 'WARNING'));
          const message = String(
            msg.message || (msg.t === 'transcript-drift' ? 'Session transcript changed outside this terminal.' : 'Warning')
          );
          setWarnings((prev) => (prev.some((w) => w.code === code) ? prev : [...prev, { code, message }]));
        } else if (msg.t === 'session-ready') {
          const id = String(msg.sessionId || '');
          setSessionId(id);
          onTargetUpdate?.({ sessionId: id });
        } else if (msg.t === 'learning-created') {
          setLearningFile(String(msg.filename || ''));
        } else if (msg.t === 'chore-created') {
          const filename = String(msg.filename || '');
          setChoreFile(filename);
          onTargetUpdate?.({ filename });
          onChoreChanged?.();
        } else if (msg.t === 'chore-bound') {
          onChoreChanged?.();
        } else if (msg.t === 'exit') {
          setStatus('exited');
          term.write('\r\n\x1b[2m— session ended —\x1b[0m\r\n');
        } else if (msg.t === 'chore-gone') {
          onChoreGone?.();
          setCountdown(CLOSE_COUNTDOWN);
        } else if (msg.t === 'chore-back') {
          setCountdown(null);
        }
      };

      ws.onclose = () => !disposed && setStatus((s) => (s === 'error' ? s : 'exited'));

      term.onData((d) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d }));
        // Advisory only — never swallow a keystroke. `/end-chore` is conversational (it asks
        // which chore, asks again if work is pending, offers /handoff first), so a hard gate
        // would assert things that often are not true. Fires on the substring, so it lands
        // while they are still typing rather than racing the Enter.
        if (isChore && /\/end(-personal)?-chore/.test(d)) setEndWarned(true);
      });

      const onResize = () => {
        try {
          fit.fit();
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {
          /* mid-teardown */
        }
      };
      const ro = new ResizeObserver(onResize);
      if (hostRef.current) ro.observe(hostRef.current);
      const ping = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      }, 20000);

      term.focus();
      (term as unknown as { __cleanup?: () => void }).__cleanup = () => {
        ro.disconnect();
        clearInterval(ping);
      };
    })();

    return () => {
      disposed = true;
      (termRef.current as unknown as { __cleanup?: () => void })?.__cleanup?.();
      try {
        wsRef.current?.close(1000, 'unmounted');
      } catch {
        /* ignore */
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount-once by design; `target` is fixed for the lifetime of the overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (minimized) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const ws = wsRef.current;
        const term = termRef.current;
        if (ws?.readyState === 1 && term) {
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
        }
        term?.focus();
      } catch {
        /* hidden or mid-teardown */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [minimized, fullscreen]);

  // Auto-close once the chore is actually gone — but on a countdown, because claude is usually
  // still printing its confirmation and the user may want to stay and run /handoff.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      toast(`Chore ended — ${target.filename} removed`, 'ok');
      close();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown, close, target.filename]);

  return (
    <div
      className={`overlay-backdrop term-backdrop ${minimized ? 'term-minimized' : ''} ${
        fullscreen ? 'term-fullscreen' : ''
      }`}
    >
      {/* no onClick: a stray backdrop click must not kill a live session */}
      <div className={`overlay wide term-overlay ${fullscreen ? 'fullscreen' : ''}`}>
        <header className="overlay-head">
          <div className="titles">
            <h2>
              <span className="term-glyph">❯</span> {target.title}
            </h2>
            <div className="path">
              {target.agent} · {sessionId || 'new session'} · {target.directory}
            </div>
          </div>
          <span className={`term-status ${status}`}>{status}</span>
          <button className="btn sm ghost" onClick={onToggleFullscreen}>
            {fullscreen ? 'Back' : 'Fullscreen'}
          </button>
          <button className="btn sm ghost" onClick={onMinimize}>
            Minimize
          </button>
          <button className="btn sm ghost" onClick={close}>
            Close ✕
          </button>
        </header>

        {isChore && (
          <div className="editing-banner term-banner">
            ⚠ {target.scope} chore · {target.filename} — running <code>/end-chore</code> here
            deletes this file and its index row.
          </div>
        )}

        {warnings.map((w) => (
          <div key={w.code} className="term-warning">
            {w.message}
          </div>
        ))}

        {isNew && learningFile && (
          <div className="term-learning">
            Standing handoff file: <code>{learningFile}</code>
          </div>
        )}

        {isNew && choreFile && (
          <div className="term-learning">
            Chore file: <code>{choreFile}</code>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        {countdown !== null && (
          <div className="term-countdown">
            Chore ended and removed — closing in {countdown}s.
            <button className="btn sm" onClick={() => setCountdown(null)}>
              Stay open
            </button>
          </div>
        )}

        <div className="term-host" ref={hostRef} />

        <footer className="overlay-foot term-foot">
          <span className="save-state">
            Escape and Ctrl-C go to the session. Minimize keeps it running; Close ✕ terminates it.
          </span>
        </footer>
      </div>

      {endWarned && (
        <div className="overlay-backdrop" style={{ alignItems: 'center' }}>
          <div className="overlay confirm">
            <h3>That command ends this chore</h3>
            <p>
              <code>/end-chore</code> deletes the chore file and its <code>index.txt</code> row.
              When it completes, this terminal closes on its own. It may first ask you to confirm,
              or offer to run <code>/handoff</code> — answer it in the terminal.
            </p>
            <div className="file">{target.filename}</div>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setEndWarned(false)} autoFocus>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
