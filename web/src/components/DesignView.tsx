import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodePeek } from './CodePeek';
import { DesignEditor, type EditorMark } from './DesignEditor';
import { toast } from './ui';
import {
  designApi,
  designRef,
  type DesignAnchor,
  type DesignItem,
  type DesignKey,
  type DesignRun,
  type DesignState,
  type ItemStatus,
} from '../lib/designApi';

/**
 * Design: Ashish's prose on the left, what the session's agent derived from it on the right.
 * Contract: ~/.agents/specs/design-facts.md.
 *
 * Every agent action is a command typed into THIS session's terminal (it keeps running behind this window), so
 * there is one agent, he sees every request, and he can interrupt or argue with it right there.
 * The view itself only ever writes the prose and one human-only switch (remove).
 */

const POLL_MS = 2000;
const SAVE_DEBOUNCE_MS = 500;
const SIDE_W_KEY = 'devboard.design.sideWidth';

const STATUS_TEXT: Record<ItemStatus, string> = {
  running: 'running…',
  intent: 'intent',
  'already-holds': 'already holds on base',
  unanchored: 'no code yet',
  code: 'code-backed',
  'broken-anchor': 'code anchor broken',
  verified: 'verified',
  failed: 'runtime FAIL',
  'cannot-run': "couldn't run",
  'control-passed': 'control also passed',
  'no-control': 'passed, no control',
};

function toneOf(it: DesignItem): string {
  if (it.kind === 'target') return it.status === 'already-holds' ? 'warn' : 'target';
  if (it.kind === 'flag') return it.status === 'verified' ? 'flag-ok' : 'flag';
  if (it.status === 'verified') return 'fact-ok';
  if (it.status === 'code') return 'fact-code';
  if (['failed', 'control-passed', 'broken-anchor'].includes(it.status)) return 'bad';
  return 'muted';
}

const short = (sha?: string | null) => (sha ? sha.slice(0, 10) : '—');
const baseName = (p?: string | null) => (p ? p.split('/').filter(Boolean).pop() : '');

export function DesignView({
  dkey,
  repo,
  agent,
  agentLive,
  sendToAgent,
}: {
  dkey: DesignKey;
  repo: string;
  agent: 'claude' | 'codex';
  agentLive: boolean;
  sendToAgent: (text: string) => boolean;
}) {
  const [state, setState] = useState<DesignState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [docText, setDocText] = useState<string>('');
  const [showResolved, setShowResolved] = useState(false);
  const [peek, setPeek] = useState<{ cwd: string; path: string; line: number; sha: string | null } | null>(null);
  const [viewer, setViewer] = useState<{ title: string; load: () => Promise<string> } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  const ref = designRef(dkey);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [sideW, setSideW] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(SIDE_W_KEY)) || 440;
    } catch {
      return 440;
    }
  });

  /** Drag the divider: the sidebar takes whatever the prose column gives up. */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const right = root.getBoundingClientRect().right;
    const total = root.getBoundingClientRect().width;
    let last = sideW;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(Math.max(right - ev.clientX, 280), total - 320));
      setSideW(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('design-resizing');
      try {
        localStorage.setItem(SIDE_W_KEY, String(last));
      } catch {
        /* per-viewer convenience only */
      }
    };
    document.body.classList.add('design-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const load = useCallback(async () => {
    try {
      const s = await designApi.state(dkey);
      setState(s);
      setError(null);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  // Open (creates the construct on first use), then poll.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await designApi.open(dkey, repo);
      } catch (e) {
        if (alive) setError((e as Error).message);
        return;
      }
      const s = await load();
      if (alive && s) setDocText(s.doc);
    })();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  const flush = useCallback(async () => {
    const content = pending.current;
    if (content === null) return;
    pending.current = null;
    setSaveState('saving');
    try {
      await designApi.saveDoc(dkey, content);
      setSaveState(pending.current === null ? 'saved' : 'dirty');
    } catch {
      setSaveState('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  const onDocChange = (doc: string) => {
    setDocText(doc);
    pending.current = doc;
    setSaveState('dirty');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  };

  // Don't lose the last keystrokes when the view closes.
  useEffect(() => () => void flush(), [flush]);

  const items = useMemo(() => state?.items || [], [state]);
  const marks: EditorMark[] = useMemo(
    () => items.filter((i) => !i.resolved).map((i) => ({ id: i.id, tone: toneOf(i), quotes: i.source.quotes })),
    // docText: re-place dots as the prose moves under them
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, docText]
  );

  /** Every agent action goes through the terminal, as a visible command. */
  const command = async (text: string, mark: { item: string | null; action: string }) => {
    if (saveState !== 'saved') await flush(); // the agent must read what is on screen
    const prefix = agent === 'codex' ? 'run ' : '';
    if (!sendToAgent(`${prefix}${text}`)) {
      toast('The session terminal is not connected', 'err');
      return;
    }
    try {
      await designApi.request(dkey, mark.item, mark.action);
    } catch {
      /* spinner is cosmetic */
    }
    void load();
  };

  const [selection, setSelection] = useState<string | null>(null);
  const derive = async () => {
    if (!selection) return void command(`/design derive ${ref}`, { item: null, action: 'derive' });
    // Scoped derive: the selected prose is stored with the request (not typed into the terminal),
    // and the server refuses items that don't quote from it.
    if (saveState !== 'saved') await flush();
    try {
      await designApi.request(dkey, null, 'derive', selection);
    } catch (e) {
      toast((e as Error).message, 'err');
      return;
    }
    const prefix = agent === 'codex' ? 'run ' : '';
    if (!sendToAgent(`${prefix}/design derive ${ref} selection`)) {
      toast('The session terminal is not connected', 'err');
      void designApi.request(dkey, null, null);
    }
    void load();
  };

  /** Facts the code backs but nothing has run yet — the ones a bulk verify is for. */
  const toVerify = items.filter((i) => i.kind === 'fact' && i.status === 'code' && !i.request);
  const verifyAll = async () => {
    if (!toVerify.length) return;
    if (saveState !== 'saved') await flush();
    const ids = toVerify.map((i) => i.id);
    const prefix = agent === 'codex' ? 'run ' : '';
    if (!sendToAgent(`${prefix}/design verify-all ${ref} ${ids.join(' ')}`)) {
      toast('The session terminal is not connected', 'err');
      return;
    }
    await Promise.all(ids.map((id) => designApi.request(dkey, id, 'verify').catch(() => {})));
    void load();
  };

  const groups = {
    flags: items.filter((i) => i.kind === 'flag' && !i.resolved),
    targets: items.filter((i) => i.kind === 'target'),
    facts: items.filter((i) => i.kind === 'fact'),
    resolved: items.filter((i) => i.resolved),
  };

  if (error && !state) return <div className="design-root"><div className="error-banner">{error}</div></div>;
  if (!state) return <div className="design-root"><div className="spinner">Opening design…</div></div>;

  const deriving = Boolean(state.binding.request);

  return (
    <div className="design-root" ref={rootRef} style={{ gridTemplateColumns: `minmax(0, 1fr) 6px ${sideW}px` }}>
      <section className="design-left">
        <div className="design-left-head">
          <span className="design-path" title={state.dir}>
            {dkey.filename.replace(/\.md$/, '')} · design
          </span>
          <span className={`design-save ${saveState}`}>
            {saveState === 'saved' ? 'saved' : saveState === 'saving' ? 'saving…' : saveState === 'dirty' ? '…' : 'save failed'}
          </span>
        </div>
        <DesignEditor
          initial={state.doc}
          marks={marks}
          selected={selected}
          onChange={onDocChange}
          onPickMark={(id) => setSelected(id)}
          onSelection={setSelection}
        />
      </section>

      <div
        className="design-splitter"
        onPointerDown={startResize}
        onDoubleClick={() => setSideW(440)}
        title="Drag to resize · double-click to reset"
      />

      <aside className="design-side">
        <div className="design-side-head">
          <h3>Derived facts</h3>
          <button
            className="btn sm design-derive"
            onClick={() => void derive()}
            // mousedown would otherwise steal focus from the editor and clear the selection first
            onMouseDown={(e) => e.preventDefault()}
            disabled={!agentLive || deriving || !docText.trim()}
            title={
              !agentLive
                ? 'The session terminal is not live'
                : selection
                  ? 'Derive only from the selected lines (the agent still reads the whole document for context)'
                  : 'Ask the session agent to read the whole document and derive facts, flags and targets — select lines first to limit it'
            }
          >
            {deriving ? <span className="design-spin" /> : null}
            {deriving
              ? state.binding.request?.scope
                ? 'Deriving selection…'
                : 'Deriving…'
              : selection
                ? 'Derive from selection'
                : 'Derive facts'}
          </button>
          <button
            className="btn sm ghost"
            onClick={() => void verifyAll()}
            disabled={!agentLive || toVerify.length === 0}
            title={
              toVerify.length
                ? `Verify every code-backed fact at runtime, one after another: ${toVerify.map((i) => i.id).join(', ')}`
                : 'No code-backed facts waiting for a runtime check'
            }
          >
            Verify all{toVerify.length ? ` (${toVerify.length})` : ''}
          </button>
          {deriving && (
            <button className="btn sm ghost" title="Clear the spinner" onClick={() => void designApi.request(dkey, null, null).then(load)}>
              ✕
            </button>
          )}
        </div>
        <div className="design-side-hint">
          Missed something? In the terminal: <code>/verify-fact &lt;which part of the prose&gt;</code>
        </div>
        {error && <div className="error-banner">{error}</div>}

        <div className="design-items">
          {items.length === 0 && <div className="empty">Nothing derived yet.</div>}
          {(
            [
              ['Flags', groups.flags],
              ['Targets', groups.targets],
              ['Facts', groups.facts],
            ] as const
          ).map(([title, list]) =>
            list.length ? (
              <div key={title} className="design-group">
                <div className="design-group-title">
                  {title} <span>{list.length}</span>
                </div>
                {list.map((it) => (
                  <ItemCard
                    key={it.n}
                    it={it}
                    dkey={dkey}
                    open={selected === it.id}
                    agentLive={agentLive}
                    onToggle={() => setSelected((s) => (s === it.id ? null : it.id))}
                    onCommand={command}
                    onPeek={setPeek}
                    onView={setViewer}
                    reload={load}
                  />
                ))}
              </div>
            ) : null
          )}
          {groups.resolved.length > 0 && (
            <div className="design-group">
              <button className="design-group-title link" onClick={() => setShowResolved((v) => !v)}>
                {showResolved ? '▾' : '▸'} Resolved flags <span>{groups.resolved.length}</span>
              </button>
              {showResolved &&
                groups.resolved.map((it) => (
                  <div key={it.n} className="design-item resolved">
                    <div className="design-item-head">
                      <span className="design-id">{it.id}</span>
                      <span className="design-claim">{it.claim}</span>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </aside>

      {peek && <CodePeek cwd={peek.cwd} path={peek.path} line={peek.line} sha={peek.sha} onClose={() => setPeek(null)} />}
      {viewer && <FileViewer title={viewer.title} load={viewer.load} onClose={() => setViewer(null)} />}
    </div>
  );
}

function ItemCard({
  it,
  dkey,
  open,
  agentLive,
  onToggle,
  onCommand,
  onPeek,
  onView,
  reload,
}: {
  it: DesignItem;
  dkey: DesignKey;
  open: boolean;
  agentLive: boolean;
  onToggle: () => void;
  onCommand: (text: string, mark: { item: string | null; action: string }) => Promise<void>;
  onPeek: (p: { cwd: string; path: string; line: number; sha: string | null }) => void;
  onView: (v: { title: string; load: () => Promise<string> }) => void;
  reload: () => Promise<unknown>;
}) {
  const ref = designRef(dkey);
  const [branch, setBranch] = useState('');
  const [askBranch, setAskBranch] = useState(false);
  const busy = Boolean(it.request) || it.status === 'running';
  const tone = toneOf(it);

  const verify = () => void onCommand(`/design verify ${it.id} ${ref}`, { item: it.id, action: 'verify' });
  const rederive = () => void onCommand(`/design rederive ${it.id} ${ref}`, { item: it.id, action: 'rederive' });
  const prototype = () => {
    const b = branch.trim();
    if (!b) return;
    setAskBranch(false);
    void onCommand(`/design prototype ${it.id} branch=${b} ${ref}`, { item: it.id, action: `prototype ${b}` });
  };
  const rerun = async () => {
    try {
      await designApi.run(dkey, it.id, 'normal');
      // control right after, sequentially, so both read the same environment
      const wait = async () => {
        for (let i = 0; i < 600; i++) {
          const s = await designApi.state(dkey);
          const me = s.items.find((x) => x.n === it.n);
          if (!me || me.status !== 'running') return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      };
      await wait();
      if (it.kind !== 'target') await designApi.run(dkey, it.id, 'control');
      void reload();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const remove = async () => {
    try {
      await designApi.remove(dkey, it.id);
      void reload();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const repoLabel = baseName(it.repo);
  const hasScript = it.files.includes('verify.sh');

  return (
    <div className={`design-item ${open ? 'open' : ''}`}>
      <button className="design-item-head" onClick={onToggle}>
        {busy ? <span className="design-spin" /> : <span className={`design-dot tone-${tone}`} />}
        <span className="design-id">{it.id}</span>
        <span className="design-claim">{it.claim}</span>
      </button>
      <div className="design-badges">
        <span className={`design-status tone-${tone}`}>{busy && it.request ? it.request.action + '…' : STATUS_TEXT[it.status]}</span>
        {it.kindBy === 'agent' && <span className="design-badge" title="Kind chosen by the agent">auto</span>}
        {it.source.state !== 'ok' && (
          <span className="design-badge warn" title="Some quoted fragments are no longer in the prose">
            source changed
          </span>
        )}
        {it.frozen && <span className="design-badge" title={`Script frozen at ${it.frozen.at}`}>frozen</span>}
        {it.promotedFrom && <span className="design-badge">was target</span>}
      </div>

      {open && (
        <div className="design-item-body">
          {it.explanation && <p className="design-expl">{it.explanation}</p>}

          {it.kind !== 'target' || it.branch ? (
            <div className="design-meta">
              {repoLabel && <span>{repoLabel}</span>}
              <span>
                {it.branch || 'detached'} @ <code>{short(it.sha)}</code>
              </span>
            </div>
          ) : null}

          <Section title="Quoted from your prose">
            {it.source.quotes.map((q, i) => (
              <blockquote key={i} className={it.source.found[i] ? '' : 'gone'}>
                {q}
              </blockquote>
            ))}
          </Section>

          {(it.anchors.length > 0 || it.code?.diff) && (
            <Section title="Code">
              {it.code?.diff && (
                <button
                  className="design-file"
                  onClick={() =>
                    onView({
                      title: `${it.id} prototype diff ${short(it.code!.diff.base)}..${short(it.code!.diff.head)}`,
                      load: () => designApi.diff(dkey, it.id).then((d) => `${d.stat}\n${d.diff}${d.truncated ? '\n… (truncated)' : ''}`),
                    })
                  }
                >
                  prototype diff {short(it.code.diff.base)}..{short(it.code.diff.head)}
                </button>
              )}
              {it.anchors.map((a, i) => (
                <AnchorSnippet
                  key={i}
                  a={a}
                  sha={it.sha}
                  repo={a.repo || it.repo}
                  check={it.verification?.anchors?.[i]}
                  onPeek={onPeek}
                />
              ))}
            </Section>
          )}

          {it.files.length > 0 && (
            <Section title="Experiment">
              {it.files.map((f) => (
                <button
                  key={f}
                  className="design-file"
                  onClick={() => onView({ title: `${it.id} / ${f}`, load: () => designApi.file(dkey, it.id, f).then((r) => r.content) })}
                >
                  {f}
                </button>
              ))}
              <div className="design-dirline" title="Copy the folder anywhere and run ./verify.sh">
                {it.dir}
              </div>
            </Section>
          )}

          {it.runs.length > 0 && (
            <Section title="Runs">
              {[...it.runs].reverse().map((r) => (
                <RunRow key={r.id} r={r} current={r.scriptHash === it.scriptHash} dkey={dkey} item={it.id} onView={onView} />
              ))}
            </Section>
          )}

          <div className="design-actions">
            {it.kind === 'target' ? (
              askBranch ? (
                <span className="design-branch">
                  <input
                    autoFocus
                    placeholder="branch (existing or new)"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') prototype();
                      if (e.key === 'Escape') setAskBranch(false);
                    }}
                  />
                  <button className="btn sm" onClick={prototype} disabled={!branch.trim()}>
                    Go
                  </button>
                </span>
              ) : (
                <button className="btn sm" disabled={!agentLive || busy} onClick={() => setAskBranch(true)}>
                  Prototype
                </button>
              )
            ) : (
              <button className="btn sm" disabled={!agentLive || busy} onClick={verify}>
                Verify
              </button>
            )}
            <button
              className="btn sm ghost"
              disabled={!agentLive || busy}
              onClick={rederive}
              title="Re-read your current prose and the code for this item: update it, reclassify it (e.g. flag → fact), or retire it if the prose no longer says it"
            >
              Re-derive
            </button>
            {hasScript && it.kind !== 'target' && (
              <button className="btn sm ghost" disabled={busy} onClick={() => void rerun()} title="Run verify.sh and --control again, no agent involved">
                Re-run
              </button>
            )}
            {it.request && (
              <button className="btn sm ghost" onClick={() => void designApi.request(dkey, it.id, null).then(reload)} title="Clear the spinner">
                Clear
              </button>
            )}
            {it.kind !== 'flag' && (
              <button className="btn sm ghost danger" onClick={() => void remove()}>
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="design-section">
      <div className="design-section-title">{title}</div>
      {children}
    </div>
  );
}

function AnchorSnippet({
  a,
  sha,
  repo,
  check,
  onPeek,
}: {
  a: DesignAnchor;
  sha: string | null;
  repo: string | null;
  check?: { ok: boolean; error?: string };
  onPeek: (p: { cwd: string; path: string; line: number; sha: string | null }) => void;
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const start = a.line || 1;
  const end = Math.max(start, a.endLine || start + 6);
  useEffect(() => {
    if (!repo || !check?.ok) return;
    const q = new URLSearchParams({ cwd: repo, path: a.path });
    if (sha) q.set('ref', sha);
    let alive = true;
    fetch(`/api/code/peek?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.content) setLines(String(d.content).split('\n').slice(start - 1, end));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, sha, a.path, start, end, check?.ok]);

  return (
    <div className={`design-anchor ${check && !check.ok ? 'broken' : ''}`}>
      <button
        className="design-anchor-head"
        disabled={!repo}
        onClick={() => repo && onPeek({ cwd: repo, path: a.path, line: start, sha })}
        title={check?.error || 'Open at the pinned sha'}
      >
        {a.path}:{start}
        {a.endLine ? `-${a.endLine}` : ''} {a.symbol ? <em>{a.symbol}</em> : null}
      </button>
      {a.note && <div className="design-anchor-note">{a.note}</div>}
      {check && !check.ok && <div className="design-anchor-note bad">{check.error}</div>}
      {lines && (
        <pre className="design-snippet">
          {lines.map((l, i) => (
            <div key={i}>
              <span className="ln">{start + i}</span>
              {l || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function RunRow({
  r,
  current,
  dkey,
  item,
  onView,
}: {
  r: DesignRun;
  current: boolean;
  dkey: DesignKey;
  item: string;
  onView: (v: { title: string; load: () => Promise<string> }) => void;
}) {
  const [open, setOpen] = useState(false);
  const when = new Date(r.startedAt).toLocaleString();
  return (
    <div className={`design-run ${current ? '' : 'stale'}`}>
      <button className="design-run-head" onClick={() => setOpen((v) => !v)} title={current ? when : `${when} — ran an older version of the script`}>
        <span className={`design-result ${r.state === 'running' ? 'running' : r.result}`}>
          {r.state === 'running' ? 'running' : r.result}
        </span>
        <span className="design-run-mode">{r.mode}</span>
        <code>{short(r.sha)}</code>
        <span className="design-run-when">{r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : ''}</span>
      </button>
      {open && (
        <div className="design-run-body">
          {r.note && <div className="design-anchor-note">{r.note}</div>}
          {r.env && <div className="design-anchor-note">env: {r.env}</div>}
          <button
            className="design-file"
            onClick={() => onView({ title: `${item} ${r.mode} log`, load: () => designApi.file(dkey, item, `runs/${r.id}/log.txt`).then((x) => x.content) })}
          >
            log.txt
          </button>
          {r.files.map((f) => (
            <button
              key={f}
              className="design-file"
              onClick={() => onView({ title: `${item} / ${f}`, load: () => designApi.file(dkey, item, f).then((x) => x.content) })}
            >
              {f.split('/sentinel/')[1] || f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FileViewer({ title, load, onClose }: { title: string; load: () => Promise<string>; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    load().then(setText, (e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay-backdrop design-viewer-backdrop" onClick={onClose}>
      <div className="overlay wide" onClick={(e) => e.stopPropagation()}>
        <header className="overlay-head">
          <div className="titles">
            <h2>{title}</h2>
          </div>
          <button className="btn sm ghost" onClick={onClose}>
            Close ✕
          </button>
        </header>
        <div className="overlay-body">
          {err && <div className="error-banner">{err}</div>}
          {text === null && !err ? <div className="spinner">Loading…</div> : <pre className="design-viewer-pre">{text}</pre>}
        </div>
      </div>
    </div>
  );
}
