import { useEffect, useRef, useState } from 'react';
import type { EnvBinding, EnvNode, EnvPlan, EnvResource, EnvRun, EnvTree } from '../types';

/**
 * The environment tree.
 *
 * Shows every layer, its live probe state, and the properties actually observed on the machine
 * (k8s version, image tags, cluster names). Clicking a node opens its detail panel; from there a
 * plan can be previewed and — only after an explicit confirmation for anything destructive — run.
 *
 * Everything here reflects a fresh probe, never a cached instance file. That is the invariant the
 * whole system rests on (~/.agents/specs/environments.md).
 */

const STATE_LABEL: Record<string, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  absent: 'absent',
  unknown: 'unknown',
  pending: 'probing…',
};

/** "3m ago" — the tree shows cached results, so when they were taken is part of the reading. */
function ago(iso: string | null) {
  if (!iso) return 'never probed';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function stateClass(state: string) {
  return `env-state ${state}`;
}

/** Build the display forest from parent pointers. Children are derived, never stored. */
function buildForest(nodes: EnvNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, EnvNode[]>();
  const roots: EnvNode[] = [];
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent)) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent)!.push(n);
    } else {
      roots.push(n);
    }
  }
  // Stable order: live things first, then alphabetical, so the interesting rows sit at the top.
  const rank = (n: EnvNode) => (n.state === 'healthy' ? 0 : n.state === 'degraded' ? 1 : 2);
  const sort = (list: EnvNode[]) => list.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  sort(roots);
  for (const list of children.values()) sort(list);
  return { roots, children };
}

function TreeRow({
  node,
  children,
  depth,
  selected,
  probing,
  onSelect,
  onRefresh,
}: {
  node: EnvNode;
  children: Map<string, EnvNode[]>;
  depth: number;
  selected: string | null;
  probing: Set<string>;
  onSelect: (id: string) => void;
  onRefresh: (id: string) => void;
}) {
  const kids = children.get(node.id) || [];
  const leases = node.instance?.leases?.filter((l) => l.live) || [];
  const busy = probing.has(node.id) || node.state === 'pending';
  return (
    <>
      <div
        className={`env-row${selected === node.id ? ' selected' : ''}`}
        style={{ paddingLeft: `${10 + depth * 18}px` }}
        onClick={() => onSelect(node.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(node.id)}
      >
        {busy ? <span className="env-spinner" /> : <span className={stateClass(node.state)} />}
        <span className="env-row-title">{node.title}</span>
        <span className="env-row-kind">{node.kind}</span>
        {leases.length > 0 && (
          <span className="env-row-lease" title={leases.map((l) => l.session).join('\n')}>
            {leases.length} session{leases.length > 1 ? 's' : ''}
          </span>
        )}
        <span className={`env-row-state${node.stale && !busy ? ' stale' : ''}`}
              title={busy ? 'probing now' : `last probed ${ago(node.probedAt)}`}>
          {busy ? 'probing…' : STATE_LABEL[node.state] || node.state}
        </span>
        {/* Per-layer re-probe: check one thing without paying for the whole tree. */}
        <button
          className="env-row-refresh"
          title={`Re-probe ${node.title} (last probed ${ago(node.probedAt)})`}
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); onRefresh(node.id); }}
        >
          ↻
        </button>
      </div>
      {kids.map((k) => (
        <TreeRow
          key={k.id}
          node={k}
          children={children}
          depth={depth + 1}
          selected={selected}
          probing={probing}
          onSelect={onSelect}
          onRefresh={onRefresh}
        />
      ))}
    </>
  );
}

/**
 * The configs a layer manages, with drift state, each expandable to YAML.
 *
 * Answers "what is this scenario actually made of?" — the question the tree could not answer when
 * a session asking about cross-cluster failover bottomed out at a workloads layer with nothing
 * below it. Driven entirely by the recipe's resources.sh, so any config-ish layer gets this.
 */
function Resources({ layer, session }: { layer: string; session: string }) {
  const [state, setState] = useState<{ supported: boolean; resources: EnvResource[] } | null>(null);
  const [open, setOpen] = useState<Record<string, string | null>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setState(null);
    setOpen({});
    fetch(`/api/env/resources/${encodeURIComponent(layer)}?session=${encodeURIComponent(session)}`)
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then((d) => alive && setState(d))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [layer, session]);

  const toggle = async (id: string) => {
    if (open[id] !== undefined) {
      setOpen((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
      return;
    }
    setOpen((p) => ({ ...p, [id]: null })); // null = loading
    try {
      const r = await fetch(
        `/api/env/resources/${encodeURIComponent(layer)}/show?id=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}`
      );
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setOpen((p) => ({ ...p, [id]: b.yaml }));
    } catch (e) {
      setOpen((p) => ({ ...p, [id]: `# ${(e as Error).message}` }));
    }
  };

  if (err) return <div className="env-warning err">{err}</div>;
  if (!state) return <div className="env-note">loading configs…</div>;
  if (!state.supported || state.resources.length === 0) return null;

  return (
    <>
      <div className="env-detail-label">configs ({state.resources.length})</div>
      <div className="env-resources">
        {state.resources.map((r) => (
          <div key={r.id} className="env-resource">
            <button className="env-resource-head" onClick={() => void toggle(r.id)}>
              <span className={`env-res-state ${r.state}`} title={r.state} />
              <span className="env-res-kind">{r.kind}</span>
              <span className="env-res-name">{r.name}</span>
              <span className="env-res-ns">{r.namespace}</span>
              <span className="env-res-caret">{open[r.id] !== undefined ? '▾' : '▸'}</span>
            </button>
            {open[r.id] !== undefined && (
              <pre className="env-res-yaml">{open[r.id] ?? 'loading…'}</pre>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function NodeDetail({
  node,
  session,
  onPlan,
  onTeardown,
  onRefresh,
  busy,
}: {
  node: EnvNode;
  session: string;
  onPlan: (id: string) => void;
  onTeardown: (id: string) => void;
  onRefresh: (id: string) => void;
  busy: boolean;
}) {
  const props = Object.entries(node.properties || {});
  return (
    <div className="env-detail">
      <div className="env-detail-head">
        <span className={stateClass(node.state)} />
        <h3>{node.title}</h3>
        <span className="env-row-kind">{node.kind}</span>
        {/* Cached results are honest only if you can see how old they are. */}
        <span className="env-probed-at">{ago(node.probedAt)}</span>
      </div>

      {props.length > 0 && (
        <>
          <div className="env-detail-label">observed</div>
          <table className="env-props">
            <tbody>
              {props.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v === null ? <span className="env-null">null</span> : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {node.details.length > 0 && (
        <>
          <div className="env-detail-label">evidence</div>
          <ul className="env-list">
            {node.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </>
      )}

      {node.errors.length > 0 && (
        <>
          <div className="env-detail-label">problems</div>
          <ul className="env-list err">
            {node.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </>
      )}

      <Resources layer={node.id} session={session} />

      {node.claims?.exclusive?.length > 0 && (
        <>
          <div className="env-detail-label">claims exclusively</div>
          <ul className="env-list dim">
            {node.claims.exclusive.map((c, i) => (
              <li key={i}><code>{c}</code></li>
            ))}
          </ul>
        </>
      )}

      {node.instance && (
        <>
          <div className="env-detail-label">instance</div>
          <div className="env-inst">
            <div><code>{node.instance.id}</code></div>
            <div className="dim">created {new Date(node.instance.createdAt).toLocaleString()}</div>
            {node.instance.leases.map((l) => (
              <div key={l.session} className={l.live ? '' : 'dim'}>
                {l.live ? 'held by' : 'expired lease'} {l.agent} {l.session.slice(0, 8)}…
                {l.directory ? ` (${l.directory})` : ''}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="env-detail-actions">
        <button className="btn sm" disabled={busy} onClick={() => onRefresh(node.id)}>
          Re-probe
        </button>
        <button className="btn sm" disabled={busy} onClick={() => onPlan(node.id)}>
          Plan to reach this
        </button>
        {node.present && node.teardown === 'allowed' && (
          <button className="btn sm danger" disabled={busy} onClick={() => onTeardown(node.id)}>
            Tear down
          </button>
        )}
        {node.teardown === 'manual' && <span className="env-note">teardown is manual</span>}
        {node.teardown === 'never' && <span className="env-note">never torn down</span>}
      </div>
    </div>
  );
}

function PlanView({
  plan,
  onRun,
  onCancel,
  running,
}: {
  plan: EnvPlan;
  onRun: (confirm: boolean) => void;
  onCancel: () => void;
  running: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const su = plan.summary;
  const mins = Math.round((su.estimateSec || 0) / 60);

  return (
    <div className="env-plan">
      <div className="env-detail-label">
        {plan.teardown ? 'teardown plan' : 'plan'} · {plan.target}
      </div>
      <div className="env-plan-steps">
        {plan.steps.map((s, i) => (
          <div key={`${s.layer}-${i}`} className={`env-plan-step ${s.action.toLowerCase()}`}>
            <span className="env-action">{s.action}</span>
            <span className="env-plan-layer">{s.layer}</span>
            <span className="env-plan-reason">{s.reason}</span>
          </div>
        ))}
      </div>

      {plan.warnings?.map((w, i) => (
        <div key={i} className="env-warning">{w}</div>
      ))}

      <div className="env-plan-summary">
        {su.reuse} reuse · {su.create} create · {su.rebuild} rebuild · {su.teardown} teardown
        {su.manual ? ` · ${su.manual} manual` : ''}
        {' — '}
        {su.estimateIsLowerBound ? 'at least ' : ''}
        {mins}m
      </div>

      {!plan.executable && (
        <div className="env-warning err">
          Not executable: a probe could not determine state. Nothing is planned on a guess.
        </div>
      )}

      {plan.requiresConfirmation && plan.executable && (
        <label className="env-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I understand {su.destructive} step{su.destructive > 1 ? 's' : ''} will destroy live infrastructure
        </label>
      )}

      <div className="env-detail-actions">
        <button
          className={`btn sm${plan.requiresConfirmation ? ' danger' : ' primary'}`}
          disabled={running || !plan.executable || (plan.requiresConfirmation && !confirmed)}
          onClick={() => onRun(confirmed)}
        >
          {running ? 'Running…' : plan.teardown ? 'Run teardown' : 'Run plan'}
        </button>
        <button className="btn sm" onClick={onCancel} disabled={running}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RunView({ run, log, onAbort }: { run: EnvRun; log: string; onAbort: () => void }) {
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // Follow the tail while a run is live; a finished run stays where the user left it.
    if (run.status === 'running' && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, run.status]);

  return (
    <div className="env-run">
      <div className="env-detail-label">
        run · {run.target} · <span className={`env-run-status ${run.status}`}>{run.status}</span>
      </div>
      <div className="env-plan-steps">
        {run.steps.map((s, i) => (
          <div key={`${s.layer}-${i}`} className={`env-plan-step ${s.status}`}>
            <span className="env-action">{s.action}</span>
            <span className="env-plan-layer">{s.layer}</span>
            <span className="env-plan-reason">
              {s.status}
              {s.error ? ` — ${s.error}` : ''}
            </span>
          </div>
        ))}
      </div>
      <pre className="env-log" ref={logRef}>{log}</pre>
      {run.status === 'running' && (
        <div className="env-detail-actions">
          <button className="btn sm danger" onClick={onAbort}>Abort</button>
        </div>
      )}
    </div>
  );
}

export function EnvOverlay({ binding, onClose }: { binding: EnvBinding; onClose: () => void }) {
  const session = binding.session;
  const [tree, setTree] = useState<EnvTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<EnvPlan | null>(null);
  const [run, setRun] = useState<EnvRun | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [planningFor, setPlanningFor] = useState<string | null>(null);
  const [probing, setProbing] = useState<Set<string>>(new Set());

  const mark = (id: string, on: boolean) =>
    setProbing((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Re-probe one layer and splice the result into the tree. */
  const probeLayer = async (id: string) => {
    mark(id, true);
    try {
      const r = await fetch(`/api/env/probe/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      const node = await r.json();
      setTree((prev) =>
        prev ? { ...prev, nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...node } : n)) } : prev
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      mark(id, false);
    }
  };

  /**
   * Load the tree from cache — instant, no shelling out — then probe anything pending or stale in
   * parallel, each row updating as its own result lands. A slow layer spins on its own line instead
   * of holding a 12-second wall in front of a view the user just wanted to glance at.
   */
  const loadTree = async (opts: { refreshAll?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    try {
      if (opts.refreshAll) {
        await fetch('/api/env/tree/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session }),
        });
      }
      const r = await fetch(`/api/env/tree?session=${encodeURIComponent(session)}`);
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      const t: EnvTree = await r.json();
      setTree(t);
      setLoading(false);

      // Fire-and-forget, in parallel. Never awaited as a group: one slow probe must not delay the
      // others' rows from updating.
      for (const n of t.nodes) {
        if (n.state === 'pending' || n.stale) void probeLayer(n.id);
      }
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTree();
  }, []);

  // Follow a live run over the read-only log socket.
  useEffect(() => {
    if (!run?.id || run.status !== 'running') return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/env/stream?run=${encodeURIComponent(run.id)}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'snapshot') {
        setRun(msg.run);
        setLog(msg.log || '');
      } else if (msg.t === 'log') {
        setLog((prev) => prev + msg.chunk);
      } else if (msg.t === 'step' || msg.t === 'done') {
        // Re-read the authoritative run record rather than patching state from the event.
        fetch(`/api/env/runs/${run.id}`)
          .then((r) => r.json())
          .then(setRun)
          .catch(() => {});
        if (msg.t === 'done') loadTree();
      }
    };
    return () => ws.close();
  }, [run?.id, run?.status]);

  const doPlan = async (target: string, teardown = false) => {
    setBusy(true);
    setPlanningFor(target);
    setError(null);
    setRun(null);
    setLog('');
    try {
      const url = teardown ? '/api/env/teardown/plan' : '/api/env/plan';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Plan with the params this environment was BOUND with, not recipe defaults. Planning
        // `kind-clusters` with clusters=2 when the env was built for 4 reports a rebuild that is
        // not real.
        body: JSON.stringify({ target, params: tree?.params || {}, via: tree?.via || null }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setPlan({ ...body, teardown });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPlanningFor(null);
    }
  };

  const doRun = async (confirmed: boolean) => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const url = plan.teardown ? '/api/env/teardown' : '/api/env/run';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: plan.target,
          params: tree?.params || {},
          via: tree?.via || null,
          confirmDestructive: confirmed,
          session,
          // Building one layer of this environment must not retarget the session's binding to it.
          // Only a run of the bound target itself re-binds.
          rebind: plan.target === tree?.target,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setPlan(null);
      setLog('');
      const runRec = await fetch(`/api/env/runs/${body.runId}`).then((x) => x.json());
      setRun(runRec);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (run?.id) await fetch(`/api/env/runs/${run.id}/abort`, { method: 'POST' });
  };

  const forest = tree ? buildForest(tree.nodes) : null;
  const selectedNode = tree?.nodes.find((n) => n.id === selected) || null;

  return (
    // Same backdrop/panel structure as the other overlays — without the backdrop the panel
    // renders in document flow and ends up below the fold.
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="overlay wide env-overlay"
        role="dialog"
        aria-label="Environment"
        onClick={(e) => e.stopPropagation()}
      >
      <header className="overlay-head">
        <div className="titles">
          <h2>Environment · {binding.target}</h2>
          <div className="path">
            {binding.instructions
              ? binding.instructions
              : `session ${session.slice(0, 8)}\u2026 · probed live, never cached`}
          </div>
        </div>
        <div className="head-actions">
          <button
            className="btn sm"
            onClick={() => void loadTree({ refreshAll: true })}
            disabled={loading || probing.size > 0}
            title="Discard cached results and re-probe every layer in this environment"
          >
            {probing.size > 0 ? `Probing ${probing.size}…` : 'Refresh all'}
          </button>
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
      </header>

      {error && <div className="env-warning err">{error}</div>}

      <div className="env-body">
        <div className="env-tree">
          {loading && !tree && <div className="env-note">probing every layer…</div>}
          {forest?.roots.map((n) => (
            <TreeRow
              key={n.id}
              node={n}
              children={forest.children}
              depth={0}
              selected={selected}
              probing={probing}
              onRefresh={(id) => void probeLayer(id)}
              onSelect={(id) => {
                setSelected(id);
                setPlan(null);
              }}
            />
          ))}
          {tree && (
            <div className="env-note env-generated">
              probed {new Date(tree.generatedAt).toLocaleTimeString()}
            </div>
          )}
        </div>

        <div className="env-side">
          {planningFor ? (
            <div className="env-working">
              <span className="env-spinner" />
              <div>
                <div className="env-working-title">Planning {planningFor}…</div>
                <div className="env-note">
                  Re-probing every recipe. Plans never read the display cache — the plan has to be
                  built on what is true right now, not what the tree last saw.
                </div>
              </div>
            </div>
          ) : run ? (
            <RunView run={run} log={log} onAbort={abort} />
          ) : plan ? (
            <PlanView plan={plan} onRun={doRun} onCancel={() => setPlan(null)} running={busy} />
          ) : selectedNode ? (
            <NodeDetail
              node={selectedNode}
              session={session}
              busy={busy || probing.has(selectedNode.id)}
              onRefresh={(id) => void probeLayer(id)}
              onPlan={(id) => doPlan(id, false)}
              onTeardown={(id) => doPlan(id, true)}
            />
          ) : (
            <div className="env-note">select a layer to see what is actually running</div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
