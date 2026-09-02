import express from 'express';
import { listChores, readChore, writeChore, deleteChore } from '../lib/chores.js';
import { search, paginate } from '../lib/search.js';

export const choresRouter = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** GET /api/chores/:scope?page=&pageSize=&q= — active chores, latest updated first */
choresRouter.get(
  '/:scope',
  asyncRoute(async (req, res) => {
    const { scope } = req.params;
    const { page = 1, pageSize = 10, q = '' } = req.query;
    const records = await listChores(scope);
    records.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const filtered = q ? search(records, q) : records;
    res.json({ scope, query: q, ...paginate(filtered, page, pageSize) });
  })
);

/** GET /api/chores/:scope/file/:filename */
choresRouter.get(
  '/:scope/file/:filename',
  asyncRoute(async (req, res) => {
    res.json(await readChore(req.params.scope, req.params.filename));
  })
);

/** PUT /api/chores/:scope/file/:filename — edit the live chore file */
choresRouter.put(
  '/:scope/file/:filename',
  asyncRoute(async (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'body.content (string) required' });
    }
    res.json(await writeChore(req.params.scope, req.params.filename, content));
  })
);

/** DELETE /api/chores/:scope/file/:filename — same effect as /end-chore */
choresRouter.delete(
  '/:scope/file/:filename',
  asyncRoute(async (req, res) => {
    res.json(await deleteChore(req.params.scope, req.params.filename));
  })
);
