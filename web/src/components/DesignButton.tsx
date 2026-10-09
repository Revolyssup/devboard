import { useEffect, useState } from 'react';
import type { Scope, SessionRef, TerminalTarget } from '../types';
import { designApi } from '../lib/designApi';

/**
 * Row entry point to a file's Design. The design lives in the session's terminal overlay (the
 * agent that derives and verifies is that session), so the button opens — or brings forward — the
 * row's session and flips it to the design view.
 *
 * Lit when a design already exists; dim but still clickable otherwise, because opening it is how
 * one gets created.
 */
let cache: { at: number; refs: Set<string> } | null = null;
const listeners = new Set<(r: Set<string>) => void>();
const POLL_MS = 10_000;

async function loadDesigns(force = false) {
  if (!force && cache && Date.now() - cache.at < POLL_MS) return cache.refs;
  try {
    const list = await designApi.list();
    cache = { at: Date.now(), refs: new Set(list.map((d) => d.ref)) };
  } catch {
    cache = { at: Date.now(), refs: new Set() };
  }
  listeners.forEach((fn) => fn(cache!.refs));
  return cache.refs;
}

function useDesignRefs() {
  const [refs, setRefs] = useState<Set<string>>(cache?.refs || new Set());
  useEffect(() => {
    let alive = true;
    const fn = (r: Set<string>) => alive && setRefs(r);
    listeners.add(fn);
    void loadDesigns().then(fn);
    const id = setInterval(() => void loadDesigns(true), POLL_MS);
    return () => {
      alive = false;
      listeners.delete(fn);
      clearInterval(id);
    };
  }, []);
  return refs;
}

function lastAgent(): 'claude' | 'codex' {
  try {
    return localStorage.getItem('devboard.lastAgent') === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}

export function DesignButton({
  scope,
  kind,
  filename,
  title,
  directory,
  candidates,
  openTerminals,
  onOpenDesign,
}: {
  scope: Scope;
  kind: 'chore' | 'learning';
  filename: string;
  title: string;
  directory?: string | null;
  candidates: Pick<SessionRef, 'agent' | 'id' | 'active' | 'lastSeen' | 'directory'>[];
  openTerminals?: TerminalTarget[] | null;
  onOpenDesign: (t: TerminalTarget) => void;
}) {
  const refs = useDesignRefs();
  const exists = refs.has(`${scope}/${kind}/${filename}`);
  const usable = candidates.filter((c) => c.id && c.directory);
  const running = (openTerminals || []).find(
    (t) =>
      (t.filename === filename && (t.kind === kind || (t.kind === 'new' && t.newKind === kind))) ||
      usable.some((c) => c.agent === t.agent && c.id === t.sessionId)
  );
  // Whichever agent the row is actually being worked with: the open terminal if there is one,
  // else the most recently active session of ANY agent (Claude or Codex).
  const newest = [...usable]
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime();
    })[0];
  const launchDir = directory || usable[0]?.directory || null;

  const open = () => {
    const designNonce = Date.now();
    if (running) return onOpenDesign({ ...running, designNonce });
    if (newest) {
      return onOpenDesign({
        scope,
        kind,
        agent: newest.agent,
        filename,
        title,
        sessionId: newest.id,
        directory: newest.directory as string,
        designNonce,
      });
    }
    if (!launchDir) return;
    // No session on this row yet: start one with the agent last used in devboard.
    onOpenDesign({
      scope,
      kind: 'new',
      newKind: kind,
      agent: lastAgent(),
      filename,
      title,
      sessionId: '',
      directory: launchDir,
      learningTitle: kind === 'learning' ? title : '',
      choreTitle: kind === 'chore' ? title : '',
      choreDescription: '',
      designNonce,
    });
  };

  const disabled = !running && !newest && !launchDir;
  return (
    <button
      className={`env-btn design-btn ${exists ? '' : 'empty'}`}
      onClick={open}
      disabled={disabled}
      title={
        disabled
          ? 'No session or directory to open a design in'
          : exists
            ? 'Design: your prose and the facts derived from it'
            : 'Start a design for this file'
      }
    >
      <span className="env-btn-icon">✎</span>
    </button>
  );
}
