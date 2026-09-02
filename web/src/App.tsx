import { useEffect, useState } from 'react';
import { api } from './api';
import { LearningsSection } from './components/LearningsSection';
import { StandaloneLearning } from './components/StandaloneLearning';
import { ToastStack } from './components/ui';
import type { Scope } from './types';

type Route =
  | { name: 'dashboard' }
  | { name: 'learning'; scope: Scope; filename: string };

function parseRoute(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'learning' && (parts[1] === 'work' || parts[1] === 'personal') && parts[2]) {
    return { name: 'learning', scope: parts[1], filename: decodeURIComponent(parts[2]) };
  }
  return { name: 'dashboard' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (route.name === 'learning') {
    return (
      <>
        <StandaloneLearning scope={route.scope} filename={route.filename} />
        <ToastStack />
      </>
    );
  }
  return <Dashboard />;
}

function Dashboard() {
  const [scope, setScope] = useState<Scope>(() => {
    const saved = window.localStorage.getItem('devboard.scope');
    return saved === 'personal' ? 'personal' : 'work';
  });
  const [counts, setCounts] = useState<Record<Scope, number | null>>({
    work: null,
    personal: null,
  });

  useEffect(() => {
    window.localStorage.setItem('devboard.scope', scope);
    document.title = `devboard · ${scope}`;
  }, [scope]);

  // Both sidebar counts on mount, so the inactive section isn't a blank placeholder.
  useEffect(() => {
    (['work', 'personal'] as Scope[]).forEach((s) => {
      api
        .listLearnings(s, 1, 1)
        .then((res) => setCounts((prev) => ({ ...prev, [s]: res.total })))
        .catch(() => undefined);
    });
  }, []);

  const setCount = (s: Scope) => (n: number) =>
    setCounts((prev) => (prev[s] === n ? prev : { ...prev, [s]: n }));

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          dev<span>board</span>
        </div>
        <div className="nav-label">Sections</div>
        {(['personal', 'work'] as Scope[]).map((s) => (
          <button
            key={s}
            className={`nav-item ${scope === s ? 'active' : ''}`}
            onClick={() => setScope(s)}
          >
            <span>{s === 'work' ? 'Work' : 'Personal'}</span>
            <span className="nav-count">{counts[s] ?? '·'}</span>
          </button>
        ))}
        <div className="sidebar-foot">
          {scope === 'work'
            ? '~/.agents/data/learnings/work'
            : '~/.agents/data/learnings/personal'}
          <br />
          {scope === 'work' ? '~/.agents/data/chores/work' : '~/.agents/data/chores/personal'}
        </div>
      </aside>

      <main className="main">
        <LearningsSection scope={scope} onCount={setCount(scope)} />
      </main>

      <ToastStack />
    </div>
  );
}
