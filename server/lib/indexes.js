import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** Split a pipe row, trimming cells. Returns [] for blank/comment lines. */
function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return [];
  return trimmed.split('|').map((c) => c.trim());
}

function parseSessionIds(cell) {
  return parseSessionRefs(cell).map((s) => s.id);
}

export function parseSessionRefs(cell, defaultAgent = 'claude') {
  if (!cell || cell === '-') return [];
  return cell
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '-')
    .map((raw) => {
      const prefixed = raw.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
      if (!prefixed) return { agent: defaultAgent, id: raw, explicitAgent: false };
      return { agent: prefixed[1].toLowerCase(), id: prefixed[2].trim(), explicitAgent: true };
    })
    .filter((s) => s.id);
}

async function readLines(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Work learnings index: `Learning | Filename | Session ID(s) | Directory | Last Updated`
 * @returns {Promise<Map<string, {summary,filename,sessionIds,directory,lastUpdated,raw,lineNo}>>}
 */
export async function readWorkIndex() {
  const lines = await readLines(path.join(config.workLearningsDir, 'index.txt'));
  const byFile = new Map();
  lines.forEach((line, i) => {
    const cells = splitRow(line);
    if (cells.length < 5) return;
    const [summary, filename, sessions, directory, lastUpdated] = cells;
    if (filename === 'Filename' || summary === 'Learning') return; // header
    if (!filename.endsWith('.md')) return;
    byFile.set(filename, {
      summary,
      filename,
      sessionIds: parseSessionIds(sessions),
      sessionRefs: parseSessionRefs(sessions),
      directory: directory && directory !== '-' ? directory : null,
      lastUpdated: lastUpdated && lastUpdated !== '-' ? lastUpdated : null,
      raw: line,
      lineNo: i,
    });
  });
  return byFile;
}

/**
 * Personal learnings index:
 * `date | track | subtype | topic | outcome | confidence | mode | hints_used`
 * There is no filename column, so rows are keyed by `<date>::<topic>` and matched to files
 * by filename convention `<date>-<track>-<topic-ish>.md`.
 */
export async function readPersonalIndex() {
  const lines = await readLines(path.join(config.personalLearningsDir, 'index.txt'));
  const rows = [];
  lines.forEach((line, i) => {
    const cells = splitRow(line);
    if (cells.length < 4) return;
    const [date, track, subtype, topic, outcome, confidence, mode, hintsUsed] = cells;
    if (date === 'date') return; // header
    rows.push({
      date,
      track,
      subtype,
      topic,
      outcome: outcome || null,
      confidence: confidence || null,
      mode: mode || null,
      hintsUsed: hintsUsed || null,
      raw: line,
      lineNo: i,
    });
  });
  return rows;
}

/**
 * Chores index: `Chore | Filename | Session ID | Directory | Started`
 * Same shape as the work learnings index so the two stay easy to reason about.
 * `dir` is the chores directory for the scope being read (work or personal).
 */
export async function readChoreIndex(dir) {
  const lines = await readLines(path.join(dir, 'index.txt'));
  const byFile = new Map();
  lines.forEach((line, i) => {
    const cells = splitRow(line);
    if (cells.length < 5) return;
    const [summary, filename, sessions, directory, started] = cells;
    if (filename === 'Filename' || summary === 'Chore') return;
    if (!filename.endsWith('.md')) return;
    byFile.set(filename, {
      summary,
      filename,
      sessionIds: parseSessionIds(sessions),
      sessionRefs: parseSessionRefs(sessions),
      directory: directory && directory !== '-' ? directory : null,
      lastUpdated: started && started !== '-' ? started : null,
      raw: line,
      lineNo: i,
    });
  });
  return byFile;
}

/**
 * Remove the row for `filename` from a 5-column index (work learnings or chores).
 * No-op when the index or the row is missing.
 */
export async function removeIndexRow(indexPath, filename) {
  let raw;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const lines = raw.split('\n');
  const kept = lines.filter((line) => {
    const cells = splitRow(line);
    if (cells.length < 5) return true;
    return cells[1] !== filename;
  });
  if (kept.length === lines.length) return false;
  await fs.writeFile(indexPath, kept.join('\n'), 'utf8');
  return true;
}
