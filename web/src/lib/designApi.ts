import type { Scope } from '../types';

export type DesignKind = 'learning' | 'chore';
export interface DesignKey {
  scope: Scope;
  kind: DesignKind;
  filename: string;
}

export type ItemKind = 'fact' | 'flag' | 'target';
export type ItemStatus =
  | 'running'
  | 'intent'
  | 'already-holds'
  | 'unanchored'
  | 'code'
  | 'broken-anchor'
  | 'verified'
  | 'failed'
  | 'cannot-run'
  | 'control-passed'
  | 'no-control';

export interface DesignAnchor {
  path: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  repo?: string;
  note?: string;
}

export interface DesignRun {
  id: string;
  mode: 'normal' | 'control' | 'baseline';
  state: 'running' | 'done' | 'interrupted';
  result?: 'pass' | 'fail' | 'cannot-run';
  exit?: number | null;
  sha?: string | null;
  env?: string | null;
  note?: string | null;
  label?: string | null;
  scriptHash?: string | null;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  files: string[];
}

export interface DesignItem {
  n: number;
  id: string;
  kind: ItemKind;
  kindBy: 'agent' | 'human';
  claim: string;
  explanation: string;
  source: { quotes: string[]; state: 'ok' | 'changed' | 'gone'; found: boolean[] };
  repo: string | null;
  branch: string | null;
  sha: string | null;
  anchors: DesignAnchor[];
  verification?: { anchors: { ok: boolean; error?: string }[] };
  code: { diff: { base: string; head: string } } | null;
  frozen: { hash: string; at: string } | null;
  request: { action: string; at: string } | null;
  promotedFrom?: string;
  status: ItemStatus;
  resolved: boolean;
  scriptHash: string | null;
  files: string[];
  runs: DesignRun[];
  dir: string;
}

export interface DesignState {
  binding: DesignKey & { repo: string | null; request: { action: string; at: string; scope?: string } | null };
  ref: string;
  dir: string;
  doc: string;
  items: DesignItem[];
  journal: string;
}

export const designRef = (k: DesignKey) => `${k.scope}/${k.kind}/${k.filename}`;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body as T;
}

const q = (k: DesignKey, extra: Record<string, string> = {}) =>
  new URLSearchParams({ ref: designRef(k), ...extra }).toString();
const post = <T>(path: string, k: DesignKey, body: object = {}) =>
  req<T>(`/api/design/${path}`, { method: 'POST', body: JSON.stringify({ ref: designRef(k), ...body }) });

export const designApi = {
  list: () => req<(DesignKey & { ref: string })[]>('/api/design/list'),
  open: (k: DesignKey, repo: string) => post('open', k, { repo }),
  state: (k: DesignKey) => req<DesignState>(`/api/design/state?${q(k)}`),
  saveDoc: (k: DesignKey, content: string) =>
    req<{ ok: true }>('/api/design/doc', { method: 'PUT', body: JSON.stringify({ ref: designRef(k), content }) }),
  remove: (k: DesignKey, item: string) => post('item/remove', k, { item }),
  request: (k: DesignKey, item: string | null, action: string | null, scope?: string) =>
    post('request', k, item ? { item, action } : { action, scope }),
  run: (k: DesignKey, item: string, mode: 'normal' | 'control') => post<{ runId: string }>('run', k, { item, mode }),
  file: (k: DesignKey, item: string, path: string) =>
    req<{ path: string; content: string; truncated: boolean; size: number }>(`/api/design/file?${q(k, { item, path })}`),
  diff: (k: DesignKey, item: string) =>
    req<{ base: string; head: string; stat: string; diff: string; truncated: boolean }>(`/api/design/diff?${q(k, { item })}`),
};
