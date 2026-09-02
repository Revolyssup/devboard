import { useEffect, useState, type ReactNode } from 'react';

/* ---------- toasts ---------- */

export type Toast = { id: number; text: string; kind?: 'ok' | 'err' };

let toastId = 0;
const listeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

export function toast(text: string, kind?: 'ok' | 'err') {
  const t = { id: ++toastId, text, kind };
  toasts = [...toasts, t];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l(toasts));
  }, 3600);
}

export function ToastStack() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- copy ---------- */

export async function copyText(text: string, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}: ${text}`, 'ok');
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(`${label}: ${text}`, 'ok');
    } catch {
      toast('Copy failed — select the text manually', 'err');
    }
    document.body.removeChild(ta);
  }
}

/* ---------- escape-to-close ---------- */

export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
}

/* ---------- confirm dialog ---------- */

export function ConfirmDialog({
  title,
  message,
  file,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  file?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscape(onCancel);
  return (
    <div className="overlay-backdrop" style={{ alignItems: 'center' }} onClick={onCancel}>
      <div className="overlay confirm" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {file && <div className="file">{file}</div>}
        <div className="confirm-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- pagination ---------- */

export function Pager({
  page,
  pages,
  total,
  pageSize,
  onPage,
  unit = 'entries',
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
  unit?: string;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="pager">
      <span className="pager-info">
        {from}–{to} of {total} {unit}
      </span>
      <div className="pager-controls">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(1)}>
          ««
        </button>
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹ Prev
        </button>
        <span className="pager-info">
          {page} / {pages}
        </span>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next ›
        </button>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(pages)}>
          »»
        </button>
      </div>
    </div>
  );
}

/* ---------- misc ---------- */

export function Panel({
  title,
  chip,
  actions,
  children,
}: {
  title: ReactNode;
  chip?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-title">
          {title}
          {chip != null && <span className="chip">{chip}</span>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function formatTimestamp(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

export function relativeTime(iso: string | null) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
