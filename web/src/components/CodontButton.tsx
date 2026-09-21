import { useEffect, useState } from 'react';
import type { CodontBinding, SessionRef } from '../types';

/**
 * Session→ontology index, same shape and posture as EnvButton: a plain file-read endpoint,
 * polled, shared module-level cache across all rows — deciding whether a row shows the button
 * must never cost anything, and it must light up without a page refresh when /codont runs in a
 * terminal (a refresh would kill that terminal).
 */
let cache: { at: number; bindings: CodontBinding[] } | null = null;
const listeners = new Set<(b: CodontBinding[]) => void>();
const POLL_MS = 10_000;

async function loadBindings(force = false): Promise<CodontBinding[]> {
  if (!force && cache && Date.now() - cache.at < POLL_MS) return cache.bindings;
  try {
    const r = await fetch('/api/codont/sessions');
    const bindings: CodontBinding[] = r.ok ? await r.json() : [];
    cache = { at: Date.now(), bindings };
    listeners.forEach((fn) => fn(bindings));
    return bindings;
  } catch {
    cache = { at: Date.now(), bindings: [] };
    return [];
  }
}

export function useCodontBindings() {
  const [bindings, setBindings] = useState<CodontBinding[]>(cache?.bindings || []);
  useEffect(() => {
    let alive = true;
    const fn = (b: CodontBinding[]) => alive && setBindings(b);
    listeners.add(fn);
    void loadBindings().then((b) => alive && setBindings(b));
    const id = setInterval(() => void loadBindings(true), POLL_MS);
    return () => {
      alive = false;
      listeners.delete(fn);
      clearInterval(id);
    };
  }, []);
  return bindings;
}

export function codontForSessions(
  bindings: CodontBinding[],
  sessions: Pick<SessionRef, 'id'>[] | undefined
): CodontBinding | null {
  if (!sessions?.length) return null;
  const ids = new Set(sessions.map((s) => s.id).filter(Boolean));
  return bindings.find((b) => ids.has(b.session)) || null;
}

/** Always rendered next to the env button; greyed until /codont creates a binding. */
export function CodontButton({
  binding,
  onOpen,
}: {
  binding: CodontBinding | null;
  onOpen: (b: CodontBinding) => void;
}) {
  if (!binding) {
    return (
      <span className="env-btn empty" title="No code ontology for this session — /codont creates one">
        ◇
      </span>
    );
  }
  return (
    <button
      className="env-btn"
      onClick={() => onOpen(binding)}
      title={`Code ontology\n${binding.instruction}`}
    >
      <span className="env-btn-icon">🕸️</span>
    </button>
  );
}
