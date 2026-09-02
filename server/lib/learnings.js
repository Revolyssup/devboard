import fs from 'node:fs/promises';
import path from 'node:path';
import { config, EXCLUDED_BASENAMES } from '../config.js';
import { readWorkIndex, readPersonalIndex, removeIndexRow, parseSessionRefs } from './indexes.js';
import { parseFrontmatter, parseAgentSessions, extractTitle, deriveKeywords } from './markdown.js';
import { resolveSessions } from './sessions.js';

export const SCOPES = {
  work: { dir: () => config.workLearningsDir, label: 'Work' },
  personal: { dir: () => config.personalLearningsDir, label: 'Personal' },
};

export function scopeDir(scope) {
  const s = SCOPES[scope];
  if (!s) {
    const err = new Error(`unknown scope: ${scope}`);
    err.status = 400;
    throw err;
  }
  return s.dir();
}

/** Confine `filename` to `dir` — no traversal, no absolute paths, .md only. */
export function safeJoin(dir, filename) {
  if (typeof filename !== 'string' || !filename) {
    const err = new Error('filename required');
    err.status = 400;
    throw err;
  }
  const base = path.basename(filename);
  if (base !== filename || base.startsWith('.')) {
    const err = new Error('invalid filename');
    err.status = 400;
    throw err;
  }
  const full = path.resolve(dir, base);
  if (path.dirname(full) !== path.resolve(dir)) {
    const err = new Error('invalid filename');
    err.status = 400;
    throw err;
  }
  return full;
}

async function listMarkdownFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !EXCLUDED_BASENAMES.has(e.name))
    .map((e) => e.name);
}

function personalRowKey(date, topic) {
  return `${date || ''}::${topic || ''}`;
}

function mergeSessionRefs(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const ref of group || []) {
      if (!ref?.id) continue;
      const agent = (ref.agent || 'claude').toLowerCase();
      const key = `${agent}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ agent, id: ref.id, directory: ref.directory || null });
    }
  }
  return out;
}

/** Build the full learning record list for a scope (unsorted). */
export async function listLearnings(scope) {
  const dir = scopeDir(scope);
  const files = await listMarkdownFiles(dir);

  const [workIndex, personalRows] = await Promise.all([
    scope === 'work' ? readWorkIndex() : Promise.resolve(new Map()),
    scope === 'personal' ? readPersonalIndex() : Promise.resolve([]),
  ]);

  const personalByKey = new Map();
  const personalByTopic = new Map();
  for (const row of personalRows) {
    personalByKey.set(personalRowKey(row.date, row.topic), row);
    if (row.topic) personalByTopic.set(row.topic, row);
  }

  const records = await Promise.all(
    files.map(async (filename) => {
      const full = path.join(dir, filename);
      const [stat, content] = await Promise.all([
        fs.stat(full),
        fs.readFile(full, 'utf8').catch(() => ''),
      ]);
      const { data: meta } = parseFrontmatter(content);
      const title = extractTitle(content) || filename.replace(/\.md$/, '');

      let summary = '';
      let keywords = [];
      let sessionRefs = [];
      let directory = null;
      let indexDate = null;
      let indexed = false;
      let extraMeta = {};

      if (scope === 'work') {
        const row = workIndex.get(filename);
        if (row) {
          indexed = true;
          summary = row.summary;
          sessionRefs = (row.sessionRefs || []).map((s) => ({ ...s, directory: row.directory }));
          directory = row.directory;
          indexDate = row.lastUpdated;
        }
        sessionRefs = mergeSessionRefs(sessionRefs, parseAgentSessions(content));
        keywords = deriveKeywords(summary || title);
      } else {
        const row =
          personalByKey.get(personalRowKey(meta.date, meta.topic)) ||
          (meta.topic ? personalByTopic.get(meta.topic) : null);
        if (row) {
          indexed = true;
          indexDate = row.date;
          extraMeta = {
            track: row.track,
            subtype: row.subtype,
            topic: row.topic,
            outcome: row.outcome,
            confidence: row.confidence,
            mode: row.mode,
            hintsUsed: row.hintsUsed,
          };
        } else {
          extraMeta = {
            track: meta.track || null,
            subtype: meta.subtype || null,
            topic: meta.topic || null,
            outcome: meta.outcome || null,
            confidence: meta.confidence || null,
            mode: meta.mode || null,
            hintsUsed: meta.hints_used || null,
          };
          indexDate = meta.date || null;
        }
        summary = [extraMeta.track, extraMeta.subtype, extraMeta.topic, extraMeta.outcome]
          .filter(Boolean)
          .join(' · ');
        keywords = deriveKeywords(summary, [
          meta.struggled_with,
          meta.comfortable_with,
          extraMeta.track,
          extraMeta.subtype,
          extraMeta.topic,
        ]);
        // Session provenance for personal learnings lives in the file's frontmatter, not in
        // index.txt (that index is the analytics table and has no filename column to key on).
        // `-` means "no recoverable session" — e.g. a transcript pruned by the ~30d retention.
        const sid = meta.session_id || meta.session || null;
        const legacySessions =
          sid && sid !== '-'
            ? parseSessionRefs(String(sid)).map((s) => ({
                ...s,
                directory: meta.directory && meta.directory !== '-' ? meta.directory : null,
              }))
            : [];
        if (sid && sid !== '-') {
          sessionRefs = legacySessions;
        }
        directory = meta.directory && meta.directory !== '-' ? meta.directory : null;
        sessionRefs = mergeSessionRefs(sessionRefs, parseAgentSessions(content));
      }

      return {
        scope,
        filename,
        title,
        summary,
        keywords,
        indexed,
        indexDate,
        directory,
        sessionRefs,
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        meta: extraMeta,
      };
    })
  );

  // Resolve every referenced session in one batch.
  const allRefs = records.flatMap((r) => r.sessionRefs);
  const resolved = await resolveSessions(allRefs);
  const byKey = new Map(resolved.map((s) => [`${s.agent}:${s.id}`, s]));

  for (const r of records) {
    r.sessions = r.sessionRefs.map((ref) => ({
      ...(byKey.get(`${ref.agent}:${ref.id}`) || {
        agent: ref.agent,
        id: ref.id,
        active: false,
        lastSeen: null,
      }),
      directory: ref.directory || r.directory,
    }));
    r.active = r.sessions.some((s) => s.active);
    delete r.sessionRefs;
  }
  return records;
}

export async function readLearning(scope, filename) {
  const dir = scopeDir(scope);
  const full = safeJoin(dir, filename);
  const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
  return {
    scope,
    filename,
    path: full,
    title: extractTitle(content) || filename,
    content,
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  };
}

export async function writeLearning(scope, filename, content) {
  const dir = scopeDir(scope);
  const full = safeJoin(dir, filename);
  await fs.access(full); // only edit files that already exist
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

/** Delete the file and drop its index row (work index only — personal index has no filename). */
export async function deleteLearning(scope, filename) {
  const dir = scopeDir(scope);
  const full = safeJoin(dir, filename);
  await fs.unlink(full);
  let indexRowRemoved = false;
  if (scope === 'work') {
    indexRowRemoved = await removeIndexRow(path.join(dir, 'index.txt'), filename);
  }
  return { scope, filename, deleted: true, indexRowRemoved };
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function slugify(s) {
  return String(s || 'new-session')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'new-session';
}

function firstLine(s, max = 96) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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

const PROMPT_START = '<!-- devboard-initial-prompt:start -->';
const PROMPT_END = '<!-- devboard-initial-prompt:end -->';

function promptBlock(initialPrompt) {
  const body = initialPrompt?.trim()
    ? `> ${initialPrompt.trim().replace(/\n/g, '\n> ')}`
    : '- Not provided yet.';
  return `${PROMPT_START}\n${body}\n${PROMPT_END}`;
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

async function recordSessionDraft(row) {
  const file = path.join(config.agentDataRoot, 'sessions', 'index.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

export async function createDraftLearning({
  scope,
  agent,
  sessionId,
  directory,
  title,
  initialPrompt = '',
}) {
  if (!['work', 'personal'].includes(scope)) {
    const err = new Error(`unknown scope: ${scope}`);
    err.status = 400;
    throw err;
  }
  const dir = scopeDir(scope);
  await fs.mkdir(dir, { recursive: true });

  const date = localDate();
  const cleanTitle =
    firstLine(title, 120) ||
    firstLine(initialPrompt, 80) ||
    (scope === 'personal' ? 'New personal learning session' : 'New work session');
  const topic = slugify(cleanTitle);
  const filename = await uniqueFilename(dir, `${date}-devboard-${topic}`);
  const relFile = path.join(dir, filename);
  const sessionCell = `${agent}:${sessionId}`;
  const now = new Date().toISOString();

  const sharedHeader = `agent_sessions:
  - agent: ${agent}
    id: ${sessionId}
    directory: ${directory}`;
  const personalHeader =
    scope === 'personal'
      ? `date: ${date}
session_id: ${sessionCell}
directory: ${directory}
mode: learning
track: devboard
subtype: new-session
topic: ${topic}
outcome: draft
confidence: n/a
hints_used: 0
${sharedHeader}`
      : sharedHeader;

  const content = `---
${personalHeader}
---

# ${cleanTitle}

## Status
- Draft standing handoff file created by devboard for a new ${agent} session.
- Update this file during handoff instead of creating a duplicate learning for this session.

## Session
- Agent: ${agent}
- Session: ${sessionId}
- Directory: ${directory}
- Created: ${now}

## Initial prompt
${promptBlock(initialPrompt)}

## Handoff
- Pending.

## Claude Section

- **Last updated:** ${agent === 'claude' ? now : '-'}
- Pending.

## Codex Section

- **Last updated:** ${agent === 'codex' ? now : '-'}
- Pending.
`;

  await fs.writeFile(relFile, content, { encoding: 'utf8', flag: 'wx' });

  if (scope === 'work') {
    await appendLine(
      path.join(dir, 'index.txt'),
      'Learning | Filename | Session ID(s) | Directory | Last Updated',
      `${pipeCell(cleanTitle)} | ${filename} | ${sessionCell} | ${pipeCell(directory)} | ${date}`
    );
  } else {
    await appendLine(
      path.join(dir, 'index.txt'),
      'date | track | subtype | topic | outcome | confidence | mode | hints_used',
      `${date} | devboard | new-session | ${topic} | draft | n/a | learning | 0`
    );
  }

  await recordSessionDraft({
    created_at: now,
    updated_at: now,
    source: 'devboard-new-session',
    agent,
    id: sessionId,
    directory,
    scope,
    learning_file: relFile,
    title: cleanTitle,
    initial_prompt: initialPrompt || null,
  });

  return { scope, filename, path: relFile, title: cleanTitle };
}

export async function fillDraftInitialPrompt(scope, filename, initialPrompt) {
  if (!initialPrompt?.trim()) return false;
  const dir = scopeDir(scope);
  const full = safeJoin(dir, filename);
  let raw;
  try {
    raw = await fs.readFile(full, 'utf8');
  } catch {
    return false;
  }
  const marker = `${PROMPT_START}\n- Not provided yet.\n${PROMPT_END}`;
  if (!raw.includes(marker)) return false;
  const next = raw.replace(marker, () => promptBlock(initialPrompt));
  await fs.writeFile(full, next, 'utf8');
  return true;
}

function addAgentSessionFrontmatter(content, agent, sessionId, directory) {
  const block = `  - agent: ${agent}
    id: ${sessionId}
    directory: ${directory}`;
  if (content.includes(`id: ${sessionId}`)) return ensureAgentSections(content, agent);
  if (/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(content)) {
    if (/^agent_sessions:\s*$/m.test(content)) {
      return ensureAgentSections(
        content.replace(/^agent_sessions:\s*$/m, `agent_sessions:\n${block}`),
        agent
      );
    }
    return ensureAgentSections(content.replace(/^---\r?\n/, `---\nagent_sessions:\n${block}\n`), agent);
  }
  return ensureAgentSections(`---\nagent_sessions:\n${block}\n---\n\n${content}`, agent);
}

async function appendWorkLearningSession(filename, agent, sessionId, directory) {
  const indexPath = path.join(config.workLearningsDir, 'index.txt');
  let raw;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const date = localDate();
  const lines = raw.split('\n');
  let changed = false;
  const next = lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5 || cells[1] !== filename) return line;
    const sessionCell = `${agent}:${sessionId}`;
    const sessions = cells[2] && cells[2] !== '-' ? cells[2].split(',').map((s) => s.trim()) : [];
    if (!sessions.includes(sessionCell)) sessions.push(sessionCell);
    changed = true;
    return `${cells[0]} | ${cells[1]} | ${sessions.join(', ')} | ${pipeCell(directory)} | ${date}`;
  });
  if (changed) await fs.writeFile(indexPath, next.join('\n'), 'utf8');
  return changed;
}

export async function bindLearningSession({ scope, filename, agent, sessionId, directory }) {
  const dir = scopeDir(scope);
  const full = safeJoin(dir, filename);
  const raw = await fs.readFile(full, 'utf8');
  await fs.writeFile(full, addAgentSessionFrontmatter(raw, agent, sessionId, directory), 'utf8');
  if (scope === 'work') await appendWorkLearningSession(filename, agent, sessionId, directory);
  await recordSessionDraft({
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: 'devboard-existing-learning-session',
    agent,
    id: sessionId,
    directory,
    scope,
    learning_file: full,
    title: extractTitle(raw) || filename,
  });
  return { scope, filename, path: full, title: extractTitle(raw) || filename };
}
