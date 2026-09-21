import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { bindingForSessions, useEnvBindings } from './EnvButton';
import { codontForSessions, useCodontBindings } from './CodontButton';
import { CodontView } from './CodontOverlay';
import { CodePeek } from './CodePeek';
import { createCodeLinkProvider, type PeekRequest } from '../lib/codeLinkProvider';
import type { EnvBinding, TerminalTarget } from '../types';
import { api } from '../api';
import { Markdown } from './Markdown';
import { toast } from './ui';

/** Seconds to wait after the chore file disappears before closing, so the tail is readable. */
const CLOSE_COUNTDOWN = 10;
const CLAUDE_ALT_SCREEN_RE = /\x1b\[\?(?:47|1047|1049)[hl]/g;

type Status = 'connecting' | 'live' | 'exited' | 'error';
type TerminalTab = { uid: string; target: TerminalTarget };

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
  onOpenEnv,
  onToggleFullscreen,
  onClose,
  onChoreGone,
  onChoreChanged,
  onTargetUpdate,
  onProtectUnloadChange,
  onAgentFinished,
  terminalTabs = [],
  activeTerminalUid,
  onSelectTerminal,
}: {
  target: TerminalTarget;
  minimized: boolean;
  fullscreen: boolean;
  onMinimize: () => void;
  onOpenEnv?: (b: EnvBinding) => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  onChoreGone?: () => void;
  onChoreChanged?: () => void;
  onTargetUpdate?: (patch: Partial<TerminalTarget>) => void;
  onProtectUnloadChange?: (protect: boolean) => void;
  /** Fired when the backend reports a genuine busy → idle transition (not the client-side
   * interrupt guess below) — the moment worth surfacing a "go look at this" notice for. */
  onAgentFinished?: () => void;
  terminalTabs?: TerminalTab[];
  activeTerminalUid?: string | null;
  onSelectTerminal?: (uid: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const claudeEscapeCarryRef = useRef('');
  const startedRef = useRef(false); // StrictMode double-invokes effects in dev
  // Read from the mount-once effect's onData handler below, so it always sees the latest value
  // instead of whatever `target.agentState` was at mount time.
  const agentStateRef = useRef(target.agentState);
  agentStateRef.current = target.agentState;

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
  // This terminal's own environment, if /start-env bound one to its session. Polled by
  // useEnvBindings, so it lights up without needing a page refresh — refreshing would tear the
  // terminal down, which is the whole reason the button lives here.
  const envBindings = useEnvBindings();
  const codontBindings = useCodontBindings();
  const codontBinding = codontForSessions(
    codontBindings,
    target.sessionId ? [{ id: target.sessionId }] : []
  );
  const envBinding = bindingForSessions(
    envBindings,
    target.sessionId ? [{ id: target.sessionId }] : []
  );

  // Alt-click on a file:line link in the terminal opens the pinned peek here.
  const [peek, setPeek] = useState<PeekRequest | null>(null);
  const [viewMode, setViewMode] = useState<'terminal' | 'file' | 'codont'>('terminal');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const isChore = target.kind === 'chore' || target.newKind === 'chore';
  const isNew = target.kind === 'new';
  const associatedFileKind = target.kind === 'new' ? target.newKind || 'learning' : target.kind;
  const associatedFilename =
    target.filename || (associatedFileKind === 'chore' ? choreFile : learningFile) || '';

  useEffect(() => {
    onProtectUnloadChange?.(status === 'connecting' || status === 'live');
  }, [onProtectUnloadChange, status]);

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

  const writePtyOutput = useCallback(
    (term: Terminal, data: ArrayBuffer) => {
      if (target.agent !== 'claude') {
        term.write(new Uint8Array(data));
        return;
      }
      // Claude's terminal UI enters the alternate screen. In a browser terminal that removes the
      // normal scrollback buffer, so the visible scrollbar has nothing meaningful to control.
      const combined = claudeEscapeCarryRef.current + decoderRef.current.decode(data, { stream: true });
      const partialEscape = combined.match(/\x1b(?:\[?|\[\??|\[\?[0-9;]*)$/)?.[0] || '';
      const writable = partialEscape ? combined.slice(0, -partialEscape.length) : combined;
      claudeEscapeCarryRef.current = partialEscape;
      if (writable) term.write(writable.replace(CLAUDE_ALT_SCREEN_RE, ''));
    },
    [target.agent]
  );

  const loadAssociatedFile = useCallback(async () => {
    if (!associatedFilename) return;
    setFileLoading(true);
    setFileError(null);
    try {
      const file =
        associatedFileKind === 'chore'
          ? await api.readChore(target.scope, associatedFilename)
          : await api.readLearning(target.scope, associatedFilename);
      setFileContent(file.content);
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setFileLoading(false);
    }
  }, [associatedFileKind, associatedFilename, target.scope]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      scrollback: 10000,
      scrollOnEraseInDisplay: true,
      smoothScrollDuration: 80,
      cursorBlink: true,
      convertEol: false,
      theme: {
        // Rosé Pine (base/text/foam/iris) — fixed at construction; xterm.js doesn't hot-swap on
        // the Work/Personal scope toggle, so this is deliberately not tied to the CSS variables.
        background: '#191724',
        foreground: '#e0def4',
        cursor: '#9ccfd8',
        selectionBackground: '#c4a7e755',
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
      // file:line references in agent output become links, verified server-side before any
      // underline is drawn. Click → VS Code at the line; Alt+click → pinned peek overlay.
      term.registerLinkProvider(
        createCodeLinkProvider(term, { cwd: target.directory, onPeek: setPeek })
      );
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
          writePtyOutput(term, ev.data);
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
        } else if (msg.t === 'agent-state') {
          const state = msg.state === 'busy' ? 'busy' : 'idle';
          if (state === 'idle' && agentStateRef.current === 'busy') onAgentFinished?.();
          onTargetUpdate?.({ agentState: state });
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
        // A bare Escape or Ctrl-C is the interrupt key (see the footer copy). Claude/Codex's
        // Stop hook — the thing that otherwise flips this back to "waiting for you" — only fires
        // on a turn finishing naturally, not on a manual interrupt, so the backend signal never
        // arrives here. Correct it client-side; a real "prompt"/"done" event still wins later.
        if ((d === '\x1b' || d === '\x03') && agentStateRef.current === 'busy') {
          onTargetUpdate?.({ agentState: 'idle' });
        }
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
  }, [writePtyOutput]);

  useEffect(() => {
    if (minimized || viewMode !== 'terminal') return;
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
  }, [minimized, fullscreen, viewMode]);

  useEffect(() => {
    if (viewMode === 'file') void loadAssociatedFile();
  }, [loadAssociatedFile, viewMode]);

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
        {fullscreen && terminalTabs.length > 1 && (
          <div className="term-tabs" role="tablist" aria-label="Running terminal sessions">
            {terminalTabs.map((tab) => {
              const tabTarget = tab.target;
              const tabSession = tabTarget.sessionId ? `${tabTarget.sessionId.slice(0, 8)}…` : 'new';
              const tabKind = tabTarget.kind === 'new' ? tabTarget.newKind || 'new' : tabTarget.kind;
              const active = tab.uid === activeTerminalUid;
              return (
                <button
                  key={tab.uid}
                  className={`term-tab ${active ? 'active' : ''}`}
                  role="tab"
                  aria-selected={active}
                  title={`${tabTarget.agent} · ${tabSession} · ${tabTarget.title}`}
                  onClick={() => onSelectTerminal?.(tab.uid)}
                >
                  <img
                    className={`agent-icon ${tabTarget.agent}`}
                    src={tabTarget.agent === 'claude' ? '/agents/claude.svg' : '/agents/codex.webp'}
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="term-tab-main">{tabTarget.title || tabKind}</span>
                  <span className="term-tab-meta">
                    {tabTarget.agent}:{tabSession}
                  </span>
                </button>
              );
            })}
          </div>
        )}
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
          {status === 'live' && (
            <span className={`agent-activity-dot ${target.agentState || 'idle'}`} />
          )}
          <button
            className="btn sm ghost"
            onClick={() => setViewMode((m) => (m === 'terminal' ? 'file' : 'terminal'))}
            disabled={viewMode === 'terminal' && !associatedFilename}
            title={
              associatedFilename
                ? viewMode === 'terminal'
                  ? `View ${associatedFileKind} file`
                  : 'Return to terminal'
                : 'No file is attached to this session yet'
            }
          >
            {viewMode === 'terminal' ? 'View file' : 'Terminal'}
          </button>
          {viewMode === 'file' && associatedFilename && (
            <button className="btn sm ghost" onClick={() => void loadAssociatedFile()} disabled={fileLoading}>
              Refresh
            </button>
          )}
          {/* Jump straight to this session's environment without leaving fullscreen. Always
              rendered, disabled when the session has none — a button that appears out of nowhere
              shifts the toolbar under the cursor. */}
          <button
            className="btn sm ghost"
            onClick={() => envBinding && onOpenEnv?.(envBinding)}
            disabled={!envBinding || !onOpenEnv}
            title={
              envBinding
                ? `Environment: ${envBinding.root?.title ?? 'environment'} → ${envBinding.target}${
                    envBinding.instructions ? `\n${envBinding.instructions}` : ''
                  }`
                : 'No environment for this session — /start-env creates one'
            }
          >
            {envBinding?.root?.icon ? `${envBinding.root.icon} ` : ''}Environment
          </button>
          <button
            className="btn sm ghost"
            onClick={() => codontBinding && setViewMode((m) => (m === 'codont' ? 'terminal' : 'codont'))}
            disabled={!codontBinding}
            title={codontBinding ? `Code ontology\n${codontBinding.instruction}` : 'No code ontology — /codont creates one'}
          >
            {viewMode === 'codont' ? 'Terminal' : '🕸️ Ontology'}
          </button>
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

        <div className={`term-host ${viewMode !== 'terminal' ? 'hidden' : ''}`} ref={hostRef} />

        {viewMode === 'codont' && codontBinding && (
          <div className="term-codont-view">
            <CodontView binding={codontBinding} />
          </div>
        )}

        {viewMode === 'file' && (
          <div className="term-file-view">
            {associatedFilename ? (
              <>
                <div className="term-file-head">
                  <span>{associatedFileKind === 'chore' ? 'Chore file' : 'Learning file'}</span>
                  <code>{associatedFilename}</code>
                </div>
                {fileLoading && <div className="spinner">Loading file...</div>}
                {fileError && <div className="error-banner">{fileError}</div>}
                {!fileLoading && !fileError && <Markdown>{fileContent || ''}</Markdown>}
              </>
            ) : (
              <div className="empty">No file is attached to this session yet.</div>
            )}
          </div>
        )}

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

      {peek && (
        <CodePeek
          cwd={target.directory}
          path={peek.path}
          line={peek.line}
          sha={peek.sha}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  );
}
