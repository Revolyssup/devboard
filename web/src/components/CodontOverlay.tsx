import { useCallback, useEffect, useState } from 'react';
import { CodontCanvas } from './CodontCanvas';
import { CodePeek } from './CodePeek';
import { Markdown } from './Markdown';
import { openInEditor } from '../lib/codeLinkProvider';
import type { CodontBinding, CodontState, CodontTab } from '../types';

/**
 * The Code Ontology view: the diagram, full width.
 *
 * It is a VIEW, not a second place to talk to an agent. Steering happens in the session's own
 * terminal — the agent that already read the code writes the diagram over the HTTP API, and this
 * surface polls the files. The pane that used to sit on the right hosted a separate subagent that
 * answered in prose and had to have its JSON scraped back out; the scrape failed often enough that
 * the usual outcome of asking for a change was no change at all. Removing the pane removes the
 * second agent, and with it the only lossy channel in the construct.
 *
 * What the diagram still owes the user is an audit trail, so the journal (what changed, which
 * anchors the server moved, what failed to verify) stays — as a panel you open, not a chat you
 * type into.
 */
export function CodontView({ binding }: { binding: CodontBinding }) {
  const session = binding.session;
  const [state, setState] = useState<CodontState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [panel, setPanel] = useState<'context' | 'journal' | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffRef, setDiffRef] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [peek, setPeek] = useState<{ path: string; line: number; sha: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/codont/state?session=${encodeURIComponent(session)}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      setState(b);
      setError(null);
      setActiveTab((cur) => (cur && b.tabs.some((t: CodontTab) => t.id === cur) ? cur : b.tabs[0]?.id ?? null));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // The agent writes whenever the conversation in the terminal calls for it, and there is no push
  // channel for "it just did" — so poll steadily rather than fast-vs-slow off a run flag.
  useEffect(() => {
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [load]);

  const tab = state?.tabs.find((t) => t.id === activeTab) || null;

  const createTab = async (ref: string) => {
    const r = await fetch('/api/codont/tab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, ref }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) setError(b.error || `tab failed (${r.status})`);
    else {
      setDiffOpen(false);
      setDiffRef('');
      setActiveTab(b.tab?.id ?? null);
    }
    void load();
  };

  const suggest = async (q: string) => {
    setDiffRef(q);
    const r = await fetch(`/api/codont/branches?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}`);
    if (r.ok) setBranches((await r.json()).branches || []);
  };

  const broken = tab
    ? Object.values(tab.ontology.verification || {}).filter((v) => v && v.ok === false).length
    : 0;

  return (
    <>
      {error && <div className="error-banner" style={{ margin: '0 14px' }}>{error}</div>}

      {state?.envMismatch && (
        <div className="env-warning" style={{ margin: '0 14px' }}>
          The connected environment runs <code>{state.envMismatch.sha.slice(0, 8)}</code> and no tab shows that
          version.{' '}
          <button className="btn sm" onClick={() => void createTab(state.envMismatch!.sha)}>
            Open tab at env version
          </button>
        </div>
      )}

      <div className="codont-body">
        <div className="codont-main">
          <div className="codont-tabs">
            {state?.tabs.map((t) => (
              <button
                key={t.id}
                className={`codont-tab${t.id === activeTab ? ' active' : ''}`}
                onClick={() => setActiveTab(t.id)}
                title={t.refResolved || 'working tree'}
              >
                {t.label}
              </button>
            ))}
            <button
              className="codont-tab add"
              title="Add a tab for another branch/sha/tag — then ask the agent to build it"
              onClick={() => setDiffOpen(true)}
            >
              ⎇ diff
            </button>

            <div className="codont-tabbar-right">
              {broken > 0 && (
                <span className="codont-broken-count" title="elements whose anchor failed verification at this tab's version">
                  ⚠️ {broken} unverified
                </span>
              )}
              <button className="codont-panel-btn" onClick={() => setPanel(panel === 'context' ? null : 'context')}>
                context
              </button>
              <button className="codont-panel-btn" onClick={() => setPanel(panel === 'journal' ? null : 'journal')}>
                journal
              </button>
            </div>
          </div>

          {tab && tab.ontology.nodes.length === 0 && (
            <div className="env-note codont-empty">
              <div>Nothing drawn on <strong>{tab.label}</strong> yet.</div>
              <div style={{ marginTop: 6 }}>
                Ask the agent in this session's terminal — “trace X into Y”, “add handleProbe” — and it writes the
                boxes here. An empty tab on a pinned version can also be the honest answer: the functionality may not
                exist at that ref.
              </div>
            </div>
          )}
          {tab && tab.ontology.nodes.length > 0 && (
            <CodontCanvas
              nodes={tab.ontology.nodes}
              edges={tab.ontology.edges}
              verification={tab.ontology.verification || {}}
              onAnchor={(a) => {
                if (a.alt) setPeek({ path: a.path, line: a.line, sha: tab.refResolved });
                else
                  void openInEditor({
                    cwd: binding.cwd,
                    path: a.path,
                    absPath: `${binding.cwd}/${a.path}`,
                    line: a.line,
                    col: null,
                  });
              }}
            />
          )}
        </div>
      </div>

      {panel && (
        <div className="overlay-backdrop" onClick={() => setPanel(null)}>
          <div className="overlay codont-context" onClick={(e) => e.stopPropagation()}>
            <header className="overlay-head">
              <div className="titles">
                <h2>{panel === 'context' ? 'Shared context' : 'Change journal'}</h2>
                <div className="path">
                  {panel === 'context'
                    ? 'what this diagram is mapping — written by the agent, read by every tab'
                    : 'what each update changed, and what failed to verify'}
                </div>
              </div>
              <div className="head-actions">
                <button className="btn sm" onClick={() => setPanel(null)}>Close</button>
              </div>
            </header>
            <div style={{ overflow: 'auto', padding: '0 18px 18px' }}>
              <Markdown>
                {(panel === 'context' ? state?.context : state?.journal) || '_(empty)_'}
              </Markdown>
            </div>
          </div>
        </div>
      )}

      {diffOpen && (
        <div className="overlay-backdrop" onClick={() => setDiffOpen(false)}>
          <div className="overlay confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Add a tab for another version</h3>
            <p className="env-note">
              Same shared context, different code version. The tab starts empty — ask the agent in the terminal to
              build it at that ref.
            </p>
            <input
              className="btn"
              style={{ width: '100%', background: 'var(--panel)' }}
              list="codont-branches"
              placeholder="branch / tag / commit sha"
              value={diffRef}
              onChange={(e) => void suggest(e.target.value)}
              autoFocus
            />
            <datalist id="codont-branches">
              {branches.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            <div className="confirm-actions">
              <button className="btn" disabled={!diffRef.trim()} onClick={() => void createTab(diffRef.trim())}>
                Add tab
              </button>
              <button className="btn" onClick={() => setDiffOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {peek && (
        <CodePeek cwd={binding.cwd} path={peek.path} line={peek.line} sha={peek.sha} onClose={() => setPeek(null)} />
      )}
    </>
  );
}

/** The dashboard-row entry point: same view, wrapped as a modal with its own header. */
export function CodontOverlay({ binding, onClose }: { binding: CodontBinding; onClose: () => void }) {
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay wide codont-overlay" onClick={(e) => e.stopPropagation()}>
        <header className="overlay-head">
          <div className="titles">
            <h2>Code Ontology</h2>
            <div className="path">{binding.instruction}</div>
          </div>
          <div className="head-actions">
            <button className="btn sm" onClick={onClose}>Close</button>
          </div>
        </header>
        <CodontView binding={binding} />
      </div>
    </div>
  );
}
