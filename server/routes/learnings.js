import express from 'express';
import {
  listLearnings,
  readLearning,
  writeLearning,
  deleteLearning,
} from '../lib/learnings.js';
import { search, paginate } from '../lib/search.js';

export const learningsRouter = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** GET /api/learnings/:scope?page=&pageSize=&sort=  — latest edited first by default */
learningsRouter.get(
  '/:scope',
  asyncRoute(async (req, res) => {
    const { scope } = req.params;
    const { page = 1, pageSize = 10, sort = 'mtime' } = req.query;

    const records = await listLearnings(scope);
    records.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'filename') return a.filename.localeCompare(b.filename);
      return b.mtimeMs - a.mtimeMs; // latest edited first
    });

    res.json({ scope, ...paginate(records, page, pageSize) });
  })
);

/** GET /api/learnings/:scope/search?q=&page=&pageSize= */
learningsRouter.get(
  '/:scope/search',
  asyncRoute(async (req, res) => {
    const { scope } = req.params;
    const { q = '', page = 1, pageSize = 10 } = req.query;
    const records = await listLearnings(scope);
    const hits = search(records, q);
    res.json({ scope, query: q, ...paginate(hits, page, pageSize) });
  })
);

/** GET /api/learnings/:scope/file/:filename — full markdown */
learningsRouter.get(
  '/:scope/file/:filename',
  asyncRoute(async (req, res) => {
    res.json(await readLearning(req.params.scope, req.params.filename));
  })
);

/** PUT /api/learnings/:scope/file/:filename — save edits locally */
learningsRouter.put(
  '/:scope/file/:filename',
  asyncRoute(async (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'body.content (string) required' });
    }
    res.json(await writeLearning(req.params.scope, req.params.filename, content));
  })
);

/** DELETE /api/learnings/:scope/file/:filename — delete file + its index row */
learningsRouter.delete(
  '/:scope/file/:filename',
  asyncRoute(async (req, res) => {
    res.json(await deleteLearning(req.params.scope, req.params.filename));
  })
);
