import { useEffect, useState } from 'react';
import type { EnvBinding, SessionRef } from '../types';

/**
 * Session→environment index.
 *
 * Deliberately a plain file read on the server (`GET /api/env/sessions`) — showing the button must
 * never cost a probe. Polled, because an environment gets bound by /start-env in a terminal and the
 * dashboard has no other way to learn about it: previously the button only appeared after a manual
 * page refresh, which also tore down the open session.
 */
let cache: { at: number; bindings: EnvBinding[] } | null = null;
const listeners = new Set<(b: EnvBinding[]) => void>();
const STALE_MS = 10_000;
const POLL_MS = 10_000;

async function loadBindings(force = false): Promise<EnvBinding[]> {
  if (!force && cache && Date.now() - cache.at < STALE_MS) return cache.bindings;
  try {
    const r = await fetch('/api/env/sessions');
    const bindings: EnvBinding[] = r.ok ? await r.json() : [];
    cache = { at: Date.now(), bindings };
    listeners.forEach((fn) => fn(bindings));
    return bindings;
  } catch {
    // An index that cannot be read is not worth surfacing on every row; buttons stay disabled.
    cache = { at: Date.now(), bindings: [] };
    return [];
  }
}

export function useEnvBindings() {
  const [bindings, setBindings] = useState<EnvBinding[]>(cache?.bindings || []);
  useEffect(() => {
    let alive = true;
    const fn = (b: EnvBinding[]) => alive && setBindings(b);
    listeners.add(fn);
    void loadBindings().then((b) => alive && setBindings(b));
    // One shared timer's worth of work regardless of how many rows mount: loadBindings dedupes on
    // STALE_MS and every listener gets the same result.
    const id = setInterval(() => void loadBindings(true), POLL_MS);
    return () => {
      alive = false;
      listeners.delete(fn);
      clearInterval(id);
    };
  }, []);
  return bindings;
}

export function refreshEnvBindings() {
  return loadBindings(true);
}

/** The binding for a row, if any of its sessions has an environment. 1:1 session↔environment. */
export function bindingForSessions(
  bindings: EnvBinding[],
  sessions: Pick<SessionRef, 'id'>[] | undefined
): EnvBinding | null {
  if (!sessions?.length) return null;
  const ids = new Set(sessions.map((s) => s.id).filter(Boolean));
  return bindings.find((b) => ids.has(b.session)) || null;
}

/**
 * Always rendered, on every row.
 *
 * With no environment it is a greyed-out placeholder rather than nothing at all: a row that COULD
 * have an environment and does not is information, and a button that appears out of nowhere shifts
 * the layout under the cursor. Once /start-env binds one, the same slot fills in with the icon of
 * the environment's root — the broadest thing it stands on, Docker Desktop here.
 */
export function EnvButton({
  binding,
  onOpen,
}: {
  binding: EnvBinding | null;
  onOpen: (b: EnvBinding) => void;
}) {
  if (!binding) {
    return (
      <span className="env-btn empty" title="No environment for this session — /start-env creates one">
        ▢
      </span>
    );
  }
  const icon = binding.root?.icon || '▣';
  const rootName = binding.root?.title || 'environment';
  return (
    <button
      className="env-btn"
      onClick={() => onOpen(binding)}
      title={`${rootName} → ${binding.target}${binding.instructions ? `\n${binding.instructions}` : ''}`}
    >
      <span className="env-btn-icon">{icon}</span>
    </button>
  );
}
