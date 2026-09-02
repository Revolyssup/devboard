import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Learning, Scope } from '../types';
import { Pager, useEscape } from './ui';

const PAGE_SIZE = 8;

/**
 * Fuzzy search over filename / learning name / keywords. Results are ranked and paginated;
 * picking one opens that learning in a new tab (read-only, with edit + delete there).
 */
export function SearchOverlay({ scope, onClose }: { scope: Scope; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Learning[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEscape(onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      setTotal(0);
      setPages(1);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .searchLearnings(scope, q, page, PAGE_SIZE)
        .then((res) => {
          if (!alive) return;
          setResults(res.items);
          setTotal(res.total);
          setPages(res.pages);
          setSel(0);
        })
        .finally(() => alive && setLoading(false));
    }, 110);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, page, scope]);

  const openInNewTab = (l: Learning) => {
    window.open(`/learning/${l.scope}/${encodeURIComponent(l.filename)}`, '_blank', 'noopener');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && results[sel]) {
      e.preventDefault();
      openInNewTab(results[sel]);
    }
  };

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-box" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-wrap">
          <span style={{ color: 'var(--faint)' }}>⌕</span>
          <input
            ref={inputRef}
            className="search-input"
            placeholder={`Search ${scope} learnings — filename, name, keywords…`}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            onKeyDown={onKeyDown}
          />
          {loading && <span style={{ color: 'var(--faint)', fontSize: 11 }}>…</span>}
          <button className="btn sm ghost" onClick={onClose}>
            Esc
          </button>
        </div>

        <div className="search-results">
          {q.trim() && results.length === 0 && !loading && (
            <div className="empty">No learning matches “{q}”</div>
          )}
          {!q.trim() && (
            <div className="empty">
              Type to search the <strong>{scope}</strong> learnings.
              <br />
              Matches filename, learning name and keywords — typos tolerated.
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.filename}
              className={`result ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => openInNewTab(r)}
            >
              <div className="result-top">
                <span className="result-title">{r.title}</span>
                <span className="result-score">
                  {r.matchedFields?.join('+')} · {r._score}
                </span>
              </div>
              <div className="result-file">{r.filename}</div>
              <div className="result-chips">
                {r.keywords.slice(0, 7).map((k) => (
                  <span className="keyword-chip" key={k}>
                    {k}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>

        {total > PAGE_SIZE && (
          <Pager
            page={page}
            pages={pages}
            total={total}
            pageSize={PAGE_SIZE}
            onPage={setPage}
            unit="matches"
          />
        )}

        <div className="search-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open in new tab
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
