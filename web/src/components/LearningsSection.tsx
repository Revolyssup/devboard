import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { CodontBinding, EnvBinding, Learning, ProgressReport, Scope, TerminalTarget } from '../types';
import { ChoresPanel } from './ChoresPanel';
import { EditOverlay } from './EditOverlay';
import { EnvOverlay } from './EnvOverlay';
import { CodontOverlay } from './CodontOverlay';
import { LearningsTable } from './LearningsTable';
import { Markdown } from './Markdown';
import { NewSessionDialog } from './NewSessionDialog';
import { ReadOverlay } from './ReadOverlay';
import { SearchOverlay } from './SearchOverlay';
import { TerminalOverlay } from './TerminalOverlay';
import { ConfirmDialog, Pager, Panel, toast, useEscape } from './ui';

const PAGE_SIZE = 8;
type TerminalEntry = { uid: string; target: TerminalTarget; protectUnload: boolean };

const COPY: Record<Scope, { title: string; sub: string }> = {
  work: {
    title: 'Work',
    sub: '~/.claude/learnings — job learnings, newest edit first',
  },
  personal: {
    title: 'Personal',
    sub: '~/.claude/personal/learnings — deliberate practice from ~/dev/learning-shit',
  },
};

export function LearningsSection({
  scope,
  onCount,
}: {
  scope: Scope;
  onCount: (n: number) => void;
}) {
  const [items, setItems] = useState<Learning[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reading, setReading] = useState<Learning | null>(null);
  const [editing, setEditing] = useState<Learning | null>(null);
  const [deleting, setDeleting] = useState<Learning | null>(null);
  const [searching, setSearching] = useState(false);
  const [newSession, setNewSession] = useState<'learning' | 'chore' | null>(null);
  // The environment a row asked to open. Null means no environment view is up — there is no
  // global entry point, and nothing probes until one of these is set.
  const [envBinding, setEnvBinding] = useState<EnvBinding | null>(null);
  const [codontBinding, setCodontBinding] = useState<CodontBinding | null>(null);
  // Multiple sessions can run in parallel (backend caps it, see config.maxTerminals). At most one
  // is on screen at a time — `activeUid` — everything else in `terminals` sits minimized with its
  // PTY/websocket still alive underneath, exactly like the single-terminal case used to.
  //
  // Each entry gets a `uid` at open time that never changes, independent of `target` (which does
  // change — a new session gets its sessionId/filename patched in after the fact). React's `key`
  // is pinned to `uid` so that patch never remounts the TerminalOverlay and kills its websocket.
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [activeUid, setActiveUid] = useState<string | null>(null);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [report, setReport] = useState<ProgressReport | null>(null);
  const [choreRefresh, setChoreRefresh] = useState(0);
  // Persistent "a background session finished" banners — distinct from the auto-dismissing
  // toast stack. Only ever holds a `uid`; target/agent info and dismissal are resolved live at
  // render time (below) so a notice never shows stale data or outlives its terminal.
  const [notices, setNotices] = useState<{ id: string; uid: string }[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listLearnings(scope, page, PAGE_SIZE)
      .then((res) => {
        setItems(res.items);
        setPages(res.pages);
        setTotal(res.total);
        onCount(res.total);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [scope, page, onCount]);

  useEffect(load, [load]);

  // Keep the Active column honest — session liveness changes without any user action.
  useEffect(() => {
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => setPage(1), [scope]);

  // ⌘K / Ctrl-K opens search, matching the button in the header.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doDelete = async (l: Learning) => {
    try {
      const res = await api.deleteLearning(scope, l.filename);
      toast(
        `Deleted ${l.filename}${res.indexRowRemoved ? ' + its index.txt row' : ''}`,
        'ok'
      );
      setDeleting(null);
      load();
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'err');
    }
  };

  const openProgressReport = async () => {
    try {
      const r = await api.progressReport();
      if (r.kind === 'html' && r.url) {
        window.open(r.url, '_blank', 'noopener');
        toast(`Opened ${r.name}`, 'ok');
      } else {
        setReport(r);
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  // Content identity — two targets refer to the same live session iff this matches. Used only for
  // dedup/restore lookups, never as a React key (see the uid note above).
  const terminalKey = (t: TerminalTarget) =>
    t.kind === 'new'
      ? `${t.agent}:new:${t.newKind || 'learning'}:${t.filename || t.title}:${t.directory}`
      : `${t.agent}:${t.sessionId}`;

  const openTargets = terminals.map((o) => o.target);
  const terminalTabs = terminals.map(({ uid, target }) => ({ uid, target }));
  const hasUnloadProtectedTerminal = terminals.some((o) => o.protectUnload);
  // Drop notices whose terminal already closed, and ones for the terminal you're currently on —
  // by any means, not just this banner's own button (e.g. you switched to it via its row instead).
  const visibleNotices = notices
    .map((n) => ({ ...n, entry: terminals.find((o) => o.uid === n.uid) }))
    .filter((n): n is typeof n & { entry: TerminalEntry } => Boolean(n.entry) && n.uid !== activeUid);

  useEffect(() => {
    if (!hasUnloadProtectedTerminal) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnloadProtectedTerminal]);

  const openTerminal = (target: TerminalTarget) => {
    const key = terminalKey(target);
    const existing = terminals.find((o) => terminalKey(o.target) === key);
    if (existing) {
      // Already running — bring it to the front instead of blocking or opening a duplicate.
      setActiveUid(existing.uid);
      return;
    }
    const uid = crypto.randomUUID();
    setTerminals((prev) => [...prev, { uid, target, protectUnload: true }]);
    setActiveUid(uid);
    setTerminalFullscreen(false);
  };

  const restoreTerminal = (target: TerminalTarget) => {
    const key = terminalKey(target);
    const match = terminals.find((o) => terminalKey(o.target) === key);
    if (match) setActiveUid(match.uid);
  };

  const selectFullscreenTerminal = (uid: string) => {
    setActiveUid(uid);
    setTerminalFullscreen(true);
  };

  // A terminal you're already looking at doesn't need a banner telling you to go look at it.
  const handleAgentFinished = (uid: string) => {
    setNotices((prev) => (prev.some((n) => n.uid === uid) ? prev : [...prev, { id: crypto.randomUUID(), uid }]));
  };

  const dismissNotice = (id: string) => setNotices((prev) => prev.filter((n) => n.id !== id));

  const goToNoticeTerminal = (id: string, uid: string) => {
    // Switching activeUid is enough to minimize whatever was on screen — only one terminal is
    // ever non-minimized at a time (see `isActive` in the render below).
    setActiveUid(uid);
    setTerminalFullscreen(false);
    dismissNotice(id);
  };

  const refreshScope = () => {
    load();
    setChoreRefresh((n) => n + 1);
  };

  const closeTerminal = (uid: string) => {
    setTerminals((prev) => prev.filter((o) => o.uid !== uid));
    setActiveUid((current) => {
      if (current !== uid) return current;
      setTerminalFullscreen(false);
      return null;
    });
    refreshScope(); // the session may have rewritten a learning/chore while it was open
  };

  const updateTerminal = (uid: string, patch: Partial<TerminalTarget>) => {
    setTerminals((prev) =>
      prev.map((o) => (o.uid === uid ? { ...o, target: { ...o.target, ...patch } } : o))
    );
  };

  const setTerminalUnloadProtection = (uid: string, protectUnload: boolean) => {
    setTerminals((prev) => {
      const current = prev.find((o) => o.uid === uid);
      if (!current || current.protectUnload === protectUnload) return prev;
      return prev.map((o) => (o.uid === uid ? { ...o, protectUnload } : o));
    });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{COPY[scope].title}</h1>
          <p className="page-sub">{COPY[scope].sub}</p>
        </div>
        <div className="head-actions">
          {scope === 'personal' && (
            <button className="btn" onClick={() => void openProgressReport()}>
              Learning Progress Report ↗
            </button>
          )}
          <button className="btn" onClick={() => setNewSession('learning')}>
            New Learning Session
          </button>
          <button className="btn" onClick={() => setNewSession('chore')}>
            New Chore Session
          </button>
          {/* Rows with a filename show their own "Running" state via RunSessionButton; this dock
              only covers in-flight new sessions that aren't tied to a row yet. */}
          {terminals
            .filter((o) => o.uid !== activeUid && !o.target.filename)
            .map((o) => {
              const busy = o.target.agentState === 'busy';
              return (
                <button
                  key={o.uid}
                  className={`btn run-btn running ${busy ? 'busy' : 'idle'}`}
                  title="Restore session"
                  onClick={() => setActiveUid(o.uid)}
                >
                  <span className="run-label">❯ Running</span>
                  <span className="dock-session">
                    {o.target.agent}:{o.target.sessionId ? `${o.target.sessionId.slice(0, 8)}…` : 'new'}
                  </span>
                </button>
              );
            })}
          <button className="btn primary" onClick={() => setSearching(true)}>
            ⌕ Search
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <Panel
        title="Learnings"
        chip={`${total} files`}
        actions={
          <span className="pager-info">
            {loading ? 'refreshing…' : 'sorted by last edited'}
          </span>
        }
      >
        <LearningsTable
          items={items}
          onRead={setReading}
          onEdit={setEditing}
          onDelete={setDeleting}
          onRunSession={openTerminal}
          openTerminals={openTargets}
          onRestoreTerminal={restoreTerminal}
          onOpenEnv={setEnvBinding}
          onOpenCodont={setCodontBinding}
        />
        <Pager
          page={page}
          pages={pages}
          total={total}
          pageSize={PAGE_SIZE}
          onPage={setPage}
          unit="learnings"
        />
      </Panel>

      <ChoresPanel
        scope={scope}
        refreshSignal={choreRefresh}
        openTerminals={openTargets}
        onRunSession={openTerminal}
        onRestoreTerminal={restoreTerminal}
        onOpenEnv={setEnvBinding}
        onOpenCodont={setCodontBinding}
      />

      {terminals.map(({ uid, target }) => {
        const isActive = uid === activeUid;
        return (
          <TerminalOverlay
            key={uid}
            target={target}
            minimized={!isActive}
            fullscreen={isActive && terminalFullscreen}
            onMinimize={() => setActiveUid(null)}
            onToggleFullscreen={() => setTerminalFullscreen((v) => !v)}
            onClose={() => closeTerminal(uid)}
            onChoreGone={refreshScope}
            onChoreChanged={refreshScope}
            onTargetUpdate={(patch) => updateTerminal(uid, patch)}
            onProtectUnloadChange={(protect) => setTerminalUnloadProtection(uid, protect)}
            onAgentFinished={() => handleAgentFinished(uid)}
            onOpenEnv={setEnvBinding}
            terminalTabs={terminalTabs}
            activeTerminalUid={activeUid}
            onSelectTerminal={selectFullscreenTerminal}
          />
        );
      })}

      {visibleNotices.length > 0 && (
        <div className="session-notice-stack">
          {visibleNotices.map((n) => (
            <div className="session-notice" key={n.id}>
              <div className="session-notice-body">
                <span className="session-notice-glyph">●</span>
                <span className="session-notice-text">
                  <strong>{n.entry.target.title || n.entry.target.agent}</strong> is waiting for you
                </span>
              </div>
              <div className="session-notice-actions">
                <button className="btn sm" onClick={() => goToNoticeTerminal(n.id, n.uid)}>
                  Go to Terminal
                </button>
                <button className="btn sm ghost" onClick={() => dismissNotice(n.id)}>
                  Close
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {reading && (
        <ReadOverlay
          load={() => api.readLearning(scope, reading.filename)}
          onClose={() => setReading(null)}
          openInTabHref={`/learning/${scope}/${encodeURIComponent(reading.filename)}`}
          onEdit={() => {
            setEditing(reading);
            setReading(null);
          }}
          onDelete={() => {
            setDeleting(reading);
            setReading(null);
          }}
        />
      )}

      {editing && (
        <EditOverlay
          scope={scope}
          filename={editing.filename}
          onClose={() => setEditing(null)}
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
          file={deleting.filename}
          onConfirm={() => void doDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {searching && <SearchOverlay scope={scope} onClose={() => setSearching(false)} />}

      {envBinding && (
        <EnvOverlay binding={envBinding} onClose={() => setEnvBinding(null)} />
      )}

      {codontBinding && (
        <CodontOverlay binding={codontBinding} onClose={() => setCodontBinding(null)} />
      )}

      {newSession && (
        <NewSessionDialog
          scope={scope}
          mode={newSession}
          onClose={() => setNewSession(null)}
          onOpen={openTerminal}
        />
      )}

      {report && <ReportOverlay report={report} onClose={() => setReport(null)} />}
    </>
  );
}

function ReportOverlay({ report, onClose }: { report: ProgressReport; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay wide" onClick={(e) => e.stopPropagation()}>
        <header className="overlay-head">
          <div className="titles">
            <h2>Learning Progress Report</h2>
            <div className="path">{report.path}</div>
          </div>
          <button className="btn sm ghost" onClick={onClose}>
            Close ✕
          </button>
        </header>
        <div className="overlay-body">
          <Markdown>{report.content || ''}</Markdown>
        </div>
      </div>
    </div>
  );
}
