import { useEffect, useRef, useState } from 'react';
import type { AgentKind, Scope, SessionRef, TerminalTarget } from '../types';
import { relativeTime } from './ui';

/**
 * The "Run session" action, shared by the chores and learnings tables.
 *
 * The two carry sessions differently — chores have `sessionIds: string[]` plus one `directory`,
 * learnings have resolved `sessions: SessionRef[]` — so both normalise to a candidate list here.
 * The button is rendered disabled rather than hidden when a row has nothing to resume, and the
 * tooltip says *which* precondition is missing: "no session" and "no directory" are different
 * problems with different fixes.
 */
export function RunSessionButton({
  scope,
  kind,
  filename,
  title,
  directory,
  candidates,
  openTerminals,
  onOpen,
  onRestore,
}: {
  scope: Scope;
  kind: 'chore' | 'learning';
  filename: string;
  title: string;
  directory?: string | null;
  candidates: Pick<SessionRef, 'agent' | 'id' | 'active' | 'lastSeen' | 'directory'>[];
  openTerminals?: TerminalTarget[] | null;
  onOpen: (t: TerminalTarget) => void;
  onRestore?: (t: TerminalTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const usable = candidates.filter((c) => c.id && c.directory);
  const launchDir = directory || usable[0]?.directory || (scope === 'personal' ? '~/dev/learning-shit' : null);
  // Any currently open terminal (active or minimized, ours or someone else's parallel session)
  // tied to this row means the row is "Running" — either it targets this file directly, or it's
  // resuming a session id this row also lists as a candidate.
  const rowMatch = (t: TerminalTarget) =>
    (t.filename === filename &&
      (t.kind === kind || (t.kind === 'new' && t.newKind === kind))) ||
    usable.some((c) => c.agent === t.agent && c.id === t.sessionId);
  const matchedTarget = (openTerminals || []).find(rowMatch);
  const running = matchedTarget
    ? { agent: matchedTarget.agent, id: matchedTarget.sessionId || 'new', directory: matchedTarget.directory }
    : null;

  const why = launchDir
    ? 'Start a new agent session for this file'
    : 'No launch directory recorded for this file';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openTarget = (session: Pick<SessionRef, 'agent' | 'id' | 'directory'>) => {
    onOpen({
      scope,
      kind,
      agent: session.agent,
      filename,
      title,
      sessionId: session.id,
      directory: session.directory as string,
    });
    setOpen(false);
  };

  const newestFor = (agent: AgentKind) =>
    usable
      .filter((c) => c.agent === agent)
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime();
      })[0];

  const openAgent = (agent: AgentKind) => {
    const existing = newestFor(agent);
    if (existing) return openTarget(existing);
    if (!launchDir) return;
    onOpen({
      scope,
      kind: 'new',
      newKind: kind,
      agent,
      filename,
      title,
      sessionId: '',
      directory: launchDir,
      learningTitle: kind === 'learning' ? title : '',
      choreTitle: kind === 'chore' ? title : '',
      choreDescription: '',
    });
    setOpen(false);
  };

  const agentBadges = (agents: AgentKind[]) => (
    <span className="run-agent-icons">
      {agents.map((agent) => (
        <img
          key={agent}
          className={`agent-icon ${agent}`}
          src={agent === 'claude' ? '/agents/claude.svg' : '/agents/codex.webp'}
          alt=""
          title={agent}
          aria-hidden="true"
        />
      ))}
    </span>
  );

  if (running) {
    return (
      <button
        className="btn sm run-btn running"
        title={`Restore ${running.agent} ${running.id}`}
        onClick={() => matchedTarget && onRestore?.(matchedTarget)}
      >
        {agentBadges([running.agent])}
        <span className="run-label">❯ Running</span>
      </button>
    );
  }

  return (
    <span className="run-menu-wrap" ref={wrapRef}>
      <button
        className="btn sm run-btn"
        title="Choose Claude or Codex"
        onClick={() => setOpen((v) => !v)}
      >
        {agentBadges(['claude', 'codex'])}
        <span className="run-label">❯ Run</span>
      </button>
      {open && (
        <div className="run-menu">
          <div className="run-menu-title">Open with</div>
          {(['claude', 'codex'] as AgentKind[]).map((agent) => {
            const s = newestFor(agent);
            const disabled = !s && !launchDir;
            return (
            <button
              key={agent}
              className="run-menu-item"
              disabled={disabled}
              onClick={() => openAgent(agent)}
              title={s ? `${s.directory || ''}\n${s.id}` : why}
            >
              <img className={`agent-icon ${agent}`} src={agent === 'claude' ? '/agents/claude.svg' : '/agents/codex.webp'} alt="" />
              <span className="run-agent">{agent}</span>
              <span className="run-id">{s ? `${s.id.slice(0, 8)}...` : 'new session'}</span>
              <span className="run-seen">{s ? relativeTime(s.lastSeen) : 'read file'}</span>
            </button>
          )})}
        </div>
      )}
    </span>
  );
}
