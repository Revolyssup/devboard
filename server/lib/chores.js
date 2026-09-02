import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { readChoreIndex, removeIndexRow } from './indexes.js';
import { resolveSessions } from './sessions.js';
import {
  extractTitle,
  deriveKeywords,
  extractChoreSections,
  extractChoreAgent,
  parseAgentSessions,
} from './markdown.js';
import { safeJoin } from './learnings.js';

/**
 * Chores are scoped the same way learnings are — `/start-chore` tracks work items in
 * ~/.claude/chores, `/start-personal-chore` tracks personal ones in ~/.claude/personal/chores.
 * Each section's panel reads only its own directory.
 */
export const CHORE_SCOPES = {
  work: () => config.workChoresDir,
  personal: () => config.personalChoresDir,
};

export function choreDir(scope) {
  const dir = CHORE_SCOPES[scope];
  if (!dir) {
    const err = new Error(`unknown chore scope: ${scope}`);
    err.status = 400;
    throw err;
  }
  return dir();
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localMinute(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${localDate(d)} ${hh}:${mm}`;
}

function slugify(s) {
  return (
    String(s || 'new-chore')
      .toLowerCase()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 7)
      .join('-') || 'new-chore'
  );
}

function pipeCell(s) {
  return String(s || '-').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
}

async function uniqueFilename(dir, base) {
  let filename = `${base}.md`;
  for (let i = 2; ; i++) {
    try {
      await fs.access(path.join(dir, filename));
      filename = `${base}-${i}.md`;
    } catch (err) {
      if (err.code === 'ENOENT') return filename;
      throw err;
    }
  }
}

async function appendLine(file, header, row) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const prefix = raw.trim() ? raw.trimEnd() : header;
  await fs.writeFile(file, `${prefix}\n${row}\n`, 'utf8');
}

async function recordSessionChore(row) {
  const file = path.join(config.agentDataRoot, 'sessions', 'index.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function mergeSessionRefs(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const ref of group || []) {
      if (!ref?.id) continue;
      const agent = String(ref.agent || 'claude').toLowerCase();
      const key = `${agent}:${String(ref.id).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ agent, id: ref.id, directory: ref.directory || null });
    }
  }
  return out;
}

function agentSectionName(agent) {
  return agent === 'codex' ? 'Codex Section' : 'Claude Section';
}

function ensureAgentSections(content, touchedAgent = null) {
  let out = content;
  const now = new Date().toISOString();
  for (const agent of ['claude', 'codex']) {
    const name = agentSectionName(agent);
    if (!new RegExp(`^## ${name}\\s*$`, 'm').test(out)) {
      out += `\n## ${name}\n\n- **Last updated:** ${agent === touchedAgent ? now : '-'}\n- Pending.\n`;
    } else if (agent === touchedAgent) {
      out = out.replace(
        new RegExp(`(^## ${name}\\s*\\n\\n- \\*\\*Last updated:\\*\\* )[^\\n]*`, 'm'),
        `$1${now}`
      );
    }
  }
  return out;
}

function addAgentSessionFrontmatter(content, agent, sessionId, directory) {
  const existing = parseAgentSessions(content);
  const hasSession = (a, id) =>
    existing.some((s) => s.agent === a && String(s.id).toLowerCase() === String(id).toLowerCase());
  const blocks = [];

  const legacyId = content.match(/^- \*\*Session:\*\*\s*(.+?)\s*$/m)?.[1];
  const legacyDirectory = content.match(/^- \*\*Directory:\*\*\s*(.+?)\s*$/m)?.[1] || directory;
  const legacyAgent = extractChoreAgent(content) || 'claude';
  if (legacyId && legacyId !== '-' && !hasSession(legacyAgent, legacyId)) {
    blocks.push(`  - agent: ${legacyAgent}
    id: ${legacyId}
    directory: ${legacyDirectory}`);
  }

  if (!hasSession(agent, sessionId)) {
    blocks.push(`  - agent: ${agent}
    id: ${sessionId}
    directory: ${directory}`);
  }
  let out = content.replace(/^devboard_pending_session:\s*true\s*$/m, '').replace(/\n{3,}/g, '\n\n');
  if (blocks.length === 0) return ensureAgentSections(out, agent);
  const block = blocks.join('\n');
  if (/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(out)) {
    if (/^agent_sessions:\s*$/m.test(out)) {
      return ensureAgentSections(out.replace(/^agent_sessions:\s*$/m, `agent_sessions:\n${block}`), agent);
    }
    return ensureAgentSections(out.replace(/^---\r?\n/, `---\nagent_sessions:\n${block}\n`), agent);
  }
  return ensureAgentSections(`---\nagent_sessions:\n${block}\n---\n\n${out}`, agent);
}

async function appendChoreIndexSession(dir, filename, title, agent, sessionId, directory) {
  const file = path.join(dir, 'index.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const header = 'Chore | Filename | Session ID | Directory | Started';
  const lines = raw.trim() ? raw.trimEnd().split('\n') : [header];
  const sessionCell = `${agent}:${sessionId}`;
  const idx = lines.findIndex((line) => line.split('|').map((c) => c.trim())[1] === filename);
  const date = localDate();
  if (idx >= 0) {
    const cells = lines[idx].split('|').map((c) => c.trim());
    const sessions = cells[2] && cells[2] !== '-' ? cells[2].split(',').map((s) => s.trim()) : [];
    if (!sessions.includes(sessionCell)) sessions.push(sessionCell);
    lines[idx] = `${cells[0] || pipeCell(title)} | ${filename} | ${sessions.join(', ')} | ${pipeCell(directory || cells[3])} | ${cells[4] || date}`;
  } else {
    lines.push(`${pipeCell(title)} | ${filename} | ${sessionCell} | ${pipeCell(directory)} | ${date}`);
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

export async function listChores(scope) {
  const dir = choreDir(scope);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return []; // directory not created until the first chore
    throw err;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.txt')
    .map((e) => e.name);

  const index = await readChoreIndex(dir);

  const records = await Promise.all(
    files.map(async (filename) => {
      const full = path.join(dir, filename);
      const [stat, content] = await Promise.all([
        fs.stat(full),
        fs.readFile(full, 'utf8').catch(() => ''),
      ]);
      const row = index.get(filename);
      const fileAgent = extractChoreAgent(content);
      const indexSessionRefs = (row?.sessionRefs || []).map((s) => ({
        agent: s.explicitAgent ? s.agent : fileAgent || s.agent || 'claude',
        id: s.id,
        directory: row?.directory || null,
      }));
      const sessionRefs = mergeSessionRefs(parseAgentSessions(content), indexSessionRefs);
      const sections = extractChoreSections(content);
      const summary = row?.summary || '';
      return {
        scope,
        filename,
        title: extractTitle(content) || filename.replace(/\.md$/, ''),
        summary,
        keywords: deriveKeywords(summary || filename),
        indexed: Boolean(row),
        sessionIds: row?.sessionIds || [],
        sessions: sessionRefs,
        directory: row?.directory || null,
        indexDate: row?.lastUpdated || null,
        sections,
        progress: {
          done: sections.done.length,
          happening: sections.happening.length,
          pending: sections.pending.length,
        },
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    })
  );

  const resolved = await resolveSessions(records.flatMap((r) => r.sessions));
  const byKey = new Map(resolved.map((s) => [`${s.agent}:${s.id}`, s]));
  for (const r of records) {
    r.sessions = r.sessions.map((s) => ({
      ...(byKey.get(`${s.agent}:${s.id}`) || {
        agent: s.agent,
        id: s.id,
        active: false,
        lastSeen: null,
      }),
      directory: s.directory || r.directory,
    }));
  }
  return records;
}

export async function readChore(scope, filename) {
  const full = safeJoin(choreDir(scope), filename);
  const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
  return {
    scope,
    filename,
    path: full,
    title: extractTitle(content) || filename,
    content,
    sections: extractChoreSections(content),
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  };
}

export async function writeChore(scope, filename, content) {
  const full = safeJoin(choreDir(scope), filename);
  await fs.access(full);
  await fs.writeFile(full, content, 'utf8');
  const stat = await fs.stat(full);
  return {
    scope,
    filename,
    title: extractTitle(content) || filename,
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  };
}

/** Chores are ephemeral: deleting one removes the file and its index row (same as /end-chore). */
export async function deleteChore(scope, filename) {
  const dir = choreDir(scope);
  const full = safeJoin(dir, filename);
  await fs.unlink(full);
  const indexRowRemoved = await removeIndexRow(path.join(dir, 'index.txt'), filename);
  return { scope, filename, deleted: true, indexRowRemoved };
}

export async function createDraftChore({
  scope,
  agent,
  sessionId,
  directory,
  title,
  description,
}) {
  const cleanTitle = pipeCell(title);
  const ask = String(description || '').trim();
  if (!cleanTitle || cleanTitle === '-') {
    const err = new Error('chore title required');
    err.status = 400;
    throw err;
  }
  if (!ask) {
    const err = new Error('chore description required');
    err.status = 400;
    throw err;
  }

  const dir = choreDir(scope);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date();
  const date = localDate(now);
  const filename = await uniqueFilename(dir, `${date}-devboard-${slugify(cleanTitle)}`);
  const full = path.join(dir, filename);
  const sessionCell = `${agent}:${sessionId}`;
  const content = `---
agent_sessions:
  - agent: ${agent}
    id: ${sessionId}
    directory: ${directory}
---

# ${cleanTitle}

- **Started:** ${localMinute(now)}
- **Agent:** ${agent}
- **Session:** ${sessionId}
- **Directory:** ${directory}
- **Ask:** ${ask.replace(/\n/g, ' ')}

## What is done

- <nothing yet>

## What is happening

- Starting the chore session.

## What is pending

- ${ask.replace(/\n/g, '\n- ')}

## Claude Section

- **Last updated:** ${agent === 'claude' ? new Date().toISOString() : '-'}
- Pending.

## Codex Section

- **Last updated:** ${agent === 'codex' ? new Date().toISOString() : '-'}
- Pending.
`;

  await fs.writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
  await appendLine(
    path.join(dir, 'index.txt'),
    'Chore | Filename | Session ID | Directory | Started',
    `${cleanTitle} | ${filename} | ${sessionCell} | ${pipeCell(directory)} | ${date}`
  );

  await recordSessionChore({
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    source: 'devboard-new-chore-session',
    agent,
    id: sessionId,
    directory,
    scope,
    chore_file: full,
    title: cleanTitle,
    description: ask,
  });

  return { scope, filename, path: full, title: cleanTitle };
}

export async function createPendingChore({
  scope,
  agent,
  directory,
  title,
  description,
}) {
  const cleanTitle = pipeCell(title);
  const ask = String(description || '').trim();
  if (!cleanTitle || cleanTitle === '-') {
    const err = new Error('chore title required');
    err.status = 400;
    throw err;
  }
  if (!ask) {
    const err = new Error('chore description required');
    err.status = 400;
    throw err;
  }

  const dir = choreDir(scope);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date();
  const date = localDate(now);
  const filename = await uniqueFilename(dir, `${date}-devboard-${slugify(cleanTitle)}`);
  const full = path.join(dir, filename);
  const flatAsk = ask.replace(/\n/g, ' ');
  const content = `---
devboard_pending_session: true
---

# ${cleanTitle}

- **Started:** ${localMinute(now)}
- **Agent:** ${agent}
- **Session:** -
- **Directory:** ${directory}
- **Ask:** ${flatAsk}

## What is done

- <nothing yet>

## What is happening

- Starting the chore session.

## What is pending

- ${ask.replace(/\n/g, '\n- ')}

## Claude Section

- **Last updated:** -
- Pending.

## Codex Section

- **Last updated:** -
- Pending.
`;

  await fs.writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
  await appendLine(
    path.join(dir, 'index.txt'),
    'Chore | Filename | Session ID | Directory | Started',
    `${cleanTitle} | ${filename} | - | ${pipeCell(directory)} | ${date}`
  );

  return { scope, filename, path: full, title: cleanTitle, description: ask };
}

export async function bindChoreSession({
  scope,
  filename,
  agent,
  sessionId,
  directory,
  title,
  description,
}) {
  const dir = choreDir(scope);
  const full = safeJoin(dir, filename);
  let raw = await fs.readFile(full, 'utf8');
  const wasPending = /devboard_pending_session:\s*true/.test(raw);
  raw = addAgentSessionFrontmatter(raw, agent, sessionId, directory);
  if (wasPending || /^- \*\*Session:\*\*\s*-\s*$/m.test(raw)) {
    raw = raw
      .replace(/^- \*\*Agent:\*\* .+$/m, `- **Agent:** ${agent}`)
      .replace(/^- \*\*Session:\*\* .+$/m, `- **Session:** ${sessionId}`)
      .replace(/^- \*\*Directory:\*\* .+$/m, `- **Directory:** ${directory}`);
  }
  await fs.writeFile(full, raw, 'utf8');

  const cleanTitle = pipeCell(title || extractTitle(raw) || filename.replace(/\.md$/, ''));
  await appendChoreIndexSession(dir, filename, cleanTitle, agent, sessionId, directory);
  await recordSessionChore({
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: wasPending ? 'devboard-new-chore-session' : 'devboard-existing-chore-session',
    agent,
    id: sessionId,
    directory,
    scope,
    chore_file: full,
    title: cleanTitle,
    description: description || null,
  });
  return { scope, filename, path: full, title: cleanTitle };
}
