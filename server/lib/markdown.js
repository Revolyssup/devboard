/** Lightweight front-matter + heading extraction. No deps: these files are ours. */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse a YAML-ish front-matter block (scalars and `[a, b]` inline lists only). */
export function parseFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { data: {}, body: content };

  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    // Strip a trailing ` # comment` — the personal-learning schema annotates fields inline
    // (`session_id: -   # transcript pruned`), and an unstripped comment would be read as
    // part of the value (a phantom session id, a mode of "n/a # ...").
    let value = kv[2].trim().replace(/\s+#.*$/, '');
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: content.slice(m[0].length) };
}

/**
 * Parse the small structured session block used during the agent-neutral migration:
 *
 * agent_sessions:
 *   - agent: claude
 *     id: <session-id>
 *     directory: <cwd>
 */
export function parseAgentSessions(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return [];

  const out = [];
  let inBlock = false;
  let current = null;
  const push = () => {
    if (current?.id) out.push({ agent: current.agent || 'claude', id: current.id, directory: current.directory || null });
  };

  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^agent_sessions:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(line) && !/^agent_sessions:/.test(line)) {
      push();
      break;
    }

    const item = line.match(/^\s*-\s+agent:\s*(\S+)\s*$/);
    if (item) {
      push();
      current = { agent: item[1].toLowerCase() };
      continue;
    }
    const kv = line.match(/^\s+(agent|id|directory):\s*(.*?)\s*$/);
    if (kv) {
      current = current || {};
      current[kv[1]] = kv[1] === 'agent' ? kv[2].toLowerCase() : kv[2].replace(/^["']|["']$/g, '');
    }
  }
  push();

  const seen = new Set();
  return out.filter((s) => {
    const key = `${s.agent}:${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractChoreAgent(content) {
  const m = content.match(/^\s*-\s+\*\*Agent:\*\*\s*([A-Za-z0-9_-]+)/m);
  return m ? m[1].toLowerCase() : null;
}

/** The learning name: first `# ` heading in the body, else the first non-empty line. */
export function extractTitle(content) {
  const { body } = parseFrontmatter(content);
  const lines = body.split('\n');
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) return h1[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.replace(/^#+\s*/, '').slice(0, 120);
  }
  return null;
}

const STOPWORDS = new Set(
  `the a an and or of to in on for with by from is are was were be been it its this that these those
   not no but as at into via when where which who what how why any all each per over under after
   before then than so if else only just also more most much many some such own same other
   one two three new old use used using can cannot does doesn't do don't you your we our they their`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Derive keyword chips from free text (the index `Learning` summary for work rows).
 * Keeps identifier-ish tokens (dots, slashes, hyphens, colons) intact — `tcc-1.28`,
 * `matchSubjectAltNames`, `:15443` are the useful search handles here.
 */
export function deriveKeywords(text, extra = []) {
  const out = new Map(); // lowercased -> original casing
  const push = (tok) => {
    const clean = tok.replace(/^[^\w:/.]+|[^\w:/.]+$/g, '');
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (lower.length < 3) return;
    if (STOPWORDS.has(lower)) return;
    if (/^\d+$/.test(lower)) return;
    if (!out.has(lower)) out.set(lower, clean);
  };

  for (const tok of String(text || '').split(/[\s,;()"'`—–…]+/)) push(tok);
  for (const e of extra) {
    if (Array.isArray(e)) e.forEach(push);
    else if (e) push(String(e));
  }
  return [...out.values()];
}

/** Split a chore file into its three tracked sections. */
export function extractChoreSections(content) {
  const sections = { done: [], happening: [], pending: [] };
  const alias = {
    'what is done': 'done',
    done: 'done',
    'what is happening': 'happening',
    happening: 'happening',
    'in progress': 'happening',
    'what is pending': 'pending',
    pending: 'pending',
  };

  let current = null;
  for (const line of content.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      const key = h[1].trim().toLowerCase().replace(/[^a-z ]/g, '').trim();
      current = alias[key] || null;
      continue;
    }
    if (!current) continue;
    const item = line.replace(/^\s*[-*]\s+/, '').trim();
    if (item) sections[current].push(item);
  }
  return sections;
}
