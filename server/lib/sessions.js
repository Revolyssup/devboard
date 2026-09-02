import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const exec = promisify(execFile);

export function slugForDirectory(dir) {
  if (!dir) return null;
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

const agentKey = (agent, id) =>
  `${String(agent || 'claude').toLowerCase()}:${String(id).toLowerCase()}`;

function normalizeRef(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return { agent: 'claude', id: ref };
  if (!ref.id) return null;
  return {
    agent: String(ref.agent || 'claude').toLowerCase(),
    id: String(ref.id),
    directory: ref.directory || null,
  };
}

const ownedPids = new Set();

export function markOwnedPid(pid) {
  ownedPids.add(String(pid));
  invalidateSessionCache();
}
export function unmarkOwnedPid(pid) {
  ownedPids.delete(String(pid));
  invalidateSessionCache();
}

async function liveAgentProcesses() {
  let stdout;
  try {
    ({ stdout } = await exec('ps', ['-axo', 'pid=,args=']));
  } catch {
    return { procs: [], resumeByKey: new Map() };
  }

  const candidates = [];
  const resumeByKey = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, args] = m;
    if (ownedPids.has(pid)) continue;

    const bin = args.split(/\s+/)[0];
    const isClaude = /(^|\/)claude$/.test(bin);
    const isCodex = /(^|\/)codex$/.test(bin);
    if (!isClaude && !isCodex) continue;
    if (isClaude && (args.includes('--chrome-native-host') || args.includes('mcp serve'))) continue;

    const agent = isClaude ? 'claude' : 'codex';
    const resume = isClaude
      ? args.match(/--resume[= ]([0-9a-fA-F-]{36})/)
      : args.match(/\bresume\s+([0-9a-fA-F-]{36})/);
    if (resume) resumeByKey.set(agentKey(agent, resume[1]), pid);
    candidates.push({ pid, agent });
  }
  if (candidates.length === 0) return { procs: [], resumeByKey };

  let lsofOut = '';
  try {
    const res = await exec('lsof', [
      '-a',
      '-d',
      'cwd',
      '-p',
      candidates.map((p) => p.pid).join(','),
      '-Fpn',
    ]);
    lsofOut = res.stdout;
  } catch (err) {
    lsofOut = err.stdout || '';
  }

  const agentByPid = new Map(candidates.map((p) => [p.pid, p.agent]));
  const procs = [];
  let currentPid = null;
  for (const line of lsofOut.split('\n')) {
    if (line.startsWith('p')) currentPid = line.slice(1);
    else if (line.startsWith('n') && currentPid) {
      procs.push({ pid: currentPid, agent: agentByPid.get(currentPid), cwd: line.slice(1) });
      currentPid = null;
    }
  }
  return { procs, resumeByKey };
}

async function scanClaudeTranscripts() {
  const map = new Map();
  let slugs;
  try {
    slugs = await fs.readdir(config.claudeProjectsDir, { withFileTypes: true });
  } catch {
    return map;
  }

  await Promise.all(
    slugs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const dir = path.join(config.claudeProjectsDir, d.name);
        let files;
        try {
          files = await fs.readdir(dir);
        } catch {
          return;
        }
        await Promise.all(
          files
            .filter((f) => f.endsWith('.jsonl'))
            .map(async (f) => {
              const id = f.slice(0, -'.jsonl'.length);
              const full = path.join(dir, f);
              try {
                const st = await fs.stat(full);
                const key = agentKey('claude', id);
                const prev = map.get(key);
                if (!prev || st.mtimeMs > prev.mtimeMs) {
                  map.set(key, {
                    agent: 'claude',
                    id,
                    slug: d.name,
                    transcript: full,
                    mtimeMs: st.mtimeMs,
                  });
                }
              } catch {
                /* raced with a delete */
              }
            })
        );
      })
  );
  return map;
}

async function walkJsonl(root) {
  const files = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await visit(full);
        else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
      })
    );
  }
  await visit(root);
  return files;
}

async function readStart(file) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function scanCodexTranscripts() {
  const map = new Map();
  const files = await walkJsonl(config.codexSessionsDir);
  await Promise.all(
    files.map(async (full) => {
      try {
        const [st, start] = await Promise.all([fs.stat(full), readStart(full)]);
        const id = start.match(/"type":"session_meta","payload":\{"id":"([^"]+)"/)?.[1];
        if (!id) return;
        const cwd = start.match(/"cwd":"([^"]+)"/)?.[1]?.replace(/\\\//g, '/');
        const key = agentKey('codex', id);
        const prev = map.get(key);
        if (!prev || st.mtimeMs > prev.mtimeMs) {
          map.set(key, {
            agent: 'codex',
            id,
            slug: cwd ? slugForDirectory(cwd) : null,
            cwd: cwd || null,
            transcript: full,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {
        /* skip unreadable or racing files */
      }
    })
  );

  try {
    const raw = await fs.readFile(config.codexSessionIndex, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!row.id) continue;
      const key = agentKey('codex', row.id);
      if (!map.has(key)) {
        map.set(key, {
          agent: 'codex',
          id: row.id,
          slug: null,
          cwd: null,
          transcript: null,
          mtimeMs: row.updated_at ? new Date(row.updated_at).getTime() : 0,
        });
      }
    }
  } catch {
    /* optional index */
  }
  return map;
}

async function scanTranscripts() {
  const [claude, codex] = await Promise.all([scanClaudeTranscripts(), scanCodexTranscripts()]);
  return new Map([...claude, ...codex]);
}

let cache = {
  at: 0,
  activeKeys: new Set(),
  transcripts: new Map(),
  liveSlugsByAgent: new Map(),
  resumeByKey: new Map(),
};

export function invalidateSessionCache() {
  cache.at = 0;
}

async function refresh() {
  const now = Date.now();
  if (now - cache.at < config.sessionScanTtlMs) return cache;

  const [{ procs, resumeByKey }, transcripts] = await Promise.all([
    liveAgentProcesses(),
    scanTranscripts(),
  ]);
  const liveSlugsByAgent = new Map();
  for (const p of procs) {
    if (!p.agent || !p.cwd) continue;
    const set = liveSlugsByAgent.get(p.agent) || new Set();
    set.add(slugForDirectory(p.cwd));
    liveSlugsByAgent.set(p.agent, set);
  }

  const activeKeys = new Set();
  for (const [key, info] of transcripts) {
    const fresh = now - info.mtimeMs <= config.activeWindowMs;
    const liveSlugs = liveSlugsByAgent.get(info.agent) || new Set();
    if (fresh && info.slug && liveSlugs.has(info.slug)) activeKeys.add(key);
  }

  cache = { at: now, activeKeys, transcripts, liveSlugsByAgent, resumeByKey };
  return cache;
}

export async function sessionOccupancy(agent, sessionId) {
  const normalized = normalizeRef({ agent, id: sessionId });
  const { resumeByKey, transcripts, liveSlugsByAgent } = await refresh();
  const key = agentKey(normalized.agent, normalized.id);
  const info = transcripts.get(key);
  const liveSlugs = liveSlugsByAgent.get(normalized.agent) || new Set();
  return {
    resumedPid: resumeByKey.get(key) || null,
    slugBusy: info?.slug ? liveSlugs.has(info.slug) : false,
    projectSlug: info?.slug || null,
    transcript: info?.transcript || null,
    lastSeenMs: info?.mtimeMs || null,
  };
}

export async function resolveSessions(refs) {
  const normalized = refs.map(normalizeRef).filter(Boolean);
  const { activeKeys, transcripts } = await refresh();
  return normalized.map((ref) => {
    const key = agentKey(ref.agent, ref.id);
    const info = transcripts.get(key);
    return {
      agent: ref.agent,
      id: ref.id,
      active: activeKeys.has(key),
      lastSeen: info?.mtimeMs ? new Date(info.mtimeMs).toISOString() : null,
      projectSlug: info?.slug || null,
      transcript: info?.transcript || null,
    };
  });
}

export async function sessionSnapshot() {
  const { activeKeys, transcripts, liveSlugsByAgent } = await refresh();
  return {
    activeSessions: [...activeKeys],
    liveProjectSlugs: Object.fromEntries(
      [...liveSlugsByAgent].map(([agent, slugs]) => [agent, [...slugs]])
    ),
    knownTranscripts: transcripts.size,
    activeWindowMs: config.activeWindowMs,
  };
}
