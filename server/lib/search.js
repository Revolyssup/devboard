/**
 * Fuzzy ranking over filename / learning name / keywords (+ index summary).
 *
 * Semantics: every query term must hit at least one field (AND across terms, OR across
 * fields). Score = sum of the best weighted per-term field hit, with a small recency
 * tiebreaker so "same relevance" resolves to "edited more recently".
 *
 * Typo tolerance (subsequence matching) is deliberately restricted to *short* fields —
 * the title, the filename, and individual keyword chips. Long prose (the index summary,
 * the body) is substring-only: a subsequence of `tls` matches almost any paragraph, which
 * would make every row a hit.
 */

const FIELDS = [
  { name: 'title', weight: 3.0, fuzzy: true, kind: 'text' },
  { name: 'filename', weight: 2.2, fuzzy: true, kind: 'text' },
  { name: 'keywords', weight: 2.0, fuzzy: true, kind: 'tokens' },
  { name: 'summary', weight: 1.4, fuzzy: false, kind: 'text' },
  { name: 'body', weight: 0.7, fuzzy: false, kind: 'text' },
];

/** Longest-run subsequence match: returns 0..1, 0 when `q` is not a subsequence of `s`. */
function subsequenceScore(s, q) {
  let si = 0;
  let runs = 0;
  let firstIdx = -1;
  let lastIdx = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const found = s.indexOf(q[qi], si);
    if (found === -1) return 0;
    if (firstIdx === -1) firstIdx = found;
    if (found !== lastIdx + 1) runs++;
    lastIdx = found;
    si = found + 1;
  }
  const span = lastIdx - firstIdx + 1;
  const compactness = (1 / runs) * (q.length / span);
  // A typo'd prefix (`waypont` → `waypoint-teardown`) should beat characters scattered
  // through the middle of an unrelated token.
  return firstIdx === 0 ? Math.min(1, compactness * 1.6) : compactness;
}

/**
 * Score one term against one string. `fuzzy` enables a subsequence fallback, evaluated
 * per *word* rather than across the whole string — a typo should match a word in the
 * filename, not characters scattered across the entire filename.
 */
function scoreText(text, term, fuzzy) {
  if (!text) return 0;
  const s = text.toLowerCase();
  if (s === term) return 1.2;
  const idx = s.indexOf(term);
  if (idx === 0) return 1.0;
  if (idx > 0) return /[^a-z0-9]/.test(s[idx - 1]) ? 0.9 : 0.65;
  if (!fuzzy || term.length < 3) return 0;

  let best = 0;
  for (const word of s.split(/[^a-z0-9.:/]+/)) {
    if (word.length < term.length) continue;
    const sub = subsequenceScore(word, term);
    if (sub > best) best = sub;
  }
  return best > 0.35 ? 0.45 * best : 0;
}

function scoreField(field, value, term) {
  if (field.kind === 'tokens') {
    let best = 0;
    for (const token of value || []) {
      const s = scoreText(token, term, field.fuzzy);
      if (s > best) best = s;
    }
    return best;
  }
  return scoreText(value, term, field.fuzzy);
}

/**
 * @param {Array} records  records with {title, filename, keywords[], summary, mtimeMs}
 * @param {string} query
 * @param {{includeBody?: boolean}} opts
 * @returns {Array} matching records annotated with `_score` / `matchedFields`, best first
 */
export function search(records, query, opts = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const now = Date.now();
  const scored = [];

  for (const record of records) {
    const values = {
      title: record.title || '',
      filename: record.filename || '',
      keywords: record.keywords || [],
      summary: record.summary || '',
      body: opts.includeBody ? record.body || '' : '',
    };

    let total = 0;
    const matchedFields = new Set();
    let allTermsHit = true;

    for (const term of terms) {
      let best = 0;
      let bestField = null;
      for (const field of FIELDS) {
        const value = values[field.name];
        if (!value || (Array.isArray(value) && value.length === 0)) continue;
        const s = scoreField(field, value, term) * field.weight;
        if (s > best) {
          best = s;
          bestField = field.name;
        }
      }
      if (best === 0) {
        allTermsHit = false;
        break;
      }
      total += best;
      matchedFields.add(bestField);
    }
    if (!allTermsHit) continue;

    // Recency tiebreaker: up to +0.5 for something edited today, decaying over ~90 days.
    const ageDays = record.mtimeMs ? (now - record.mtimeMs) / 86400000 : 365;
    total += 0.5 * Math.exp(-ageDays / 90);

    scored.push({ ...record, _score: Number(total.toFixed(4)), matchedFields: [...matchedFields] });
  }

  scored.sort((a, b) => b._score - a._score || b.mtimeMs - a.mtimeMs);
  return scored;
}

/** Slice a list into a page envelope. */
export function paginate(items, page = 1, pageSize = 10) {
  const total = items.length;
  const size = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, pageSize: size, total, pages };
}
