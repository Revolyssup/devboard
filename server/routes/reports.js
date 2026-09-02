import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export const reportsRouter = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function latestHtmlReport() {
  let entries;
  try {
    entries = await fs.readdir(config.reportsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.isFile() && /\.html?$/i.test(e.name));
  if (files.length === 0) return null;

  const stats = await Promise.all(
    files.map(async (e) => {
      const full = path.join(config.reportsDir, e.name);
      const st = await fs.stat(full);
      return { name: e.name, path: full, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() };
    })
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0];
}

async function markdownReport() {
  const full = path.join(config.personalLearningsDir, 'learning-report.md');
  try {
    const [content, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
    return { name: 'learning-report.md', path: full, content, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * GET /api/reports/progress
 * Prefers ~/.claude/personal/learnings/learning-report.md (rendered read-only in place);
 * falls back to the newest HTML produced by /progress-in-learning-shit (opened in a new tab).
 */
reportsRouter.get(
  '/progress',
  asyncRoute(async (_req, res) => {
    const md = await markdownReport();
    if (md) {
      return res.json({
        kind: 'markdown',
        name: md.name,
        path: md.path,
        mtime: md.mtime,
        content: md.content,
      });
    }
    const html = await latestHtmlReport();
    if (html) {
      return res.json({
        kind: 'html',
        name: html.name,
        path: html.path,
        mtime: html.mtime,
        url: `/reports/file/${encodeURIComponent(html.name)}`,
      });
    }
    res.status(404).json({
      error: 'No progress report found',
      hint: `Run /progress-in-learning-shit — it writes HTML into ${config.reportsDir}`,
    });
  })
);

/** GET /reports/file/:name — serve a report HTML file (mounted outside /api). */
export const reportsFileRouter = express.Router();
reportsFileRouter.get(
  '/file/:name',
  asyncRoute(async (req, res) => {
    const name = path.basename(req.params.name);
    if (!/\.html?$/i.test(name)) return res.status(400).send('Not a report');
    const full = path.resolve(config.reportsDir, name);
    if (path.dirname(full) !== path.resolve(config.reportsDir)) {
      return res.status(400).send('Invalid path');
    }
    try {
      await fs.access(full);
    } catch {
      return res.status(404).send('Report not found');
    }
    res.sendFile(full);
  })
);
