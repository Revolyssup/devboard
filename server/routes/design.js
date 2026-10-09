import express from 'express';
import {
  parseKey,
  keyRef,
  listDesigns,
  ensureDesign,
  designState,
  writeDoc,
  createItems,
  updateItem,
  removeItem,
  retireItem,
  setRequest,
  startRun,
  waitRun,
  readItemFile,
  itemDiff,
  parseItemRef,
} from '../lib/design.js';

/**
 * Design documents (~/.agents/specs/design-facts.md).
 *
 * Two kinds of caller. The UI: open, autosave the prose, remove items, mark a request. The
 * session's agent (via curl, per the /design skill): create items, update them, run verify.sh.
 * The prose itself has exactly one writer — the PUT /doc route, which only the editor calls.
 *
 * Every route accepts the design key either as {scope, kind, filename} or as `ref`
 * ("work/learning/<file>.md"), and items as `item: "F-7"` or `n: 7`.
 */
export const designRouter = express.Router();

const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

const keyFrom = (req) => parseKey({ ...req.query, ...(req.body || {}) });
const itemFrom = (req) => {
  const src = { ...req.query, ...(req.body || {}) };
  return parseItemRef(src.item ?? src.n);
};

designRouter.get('/list', route(() => listDesigns()));

designRouter.post(
  '/open',
  route((req) => {
    const key = keyFrom(req);
    const binding = ensureDesign(key, { repo: req.body?.repo });
    return { binding, ref: keyRef(key) };
  })
);

designRouter.get(
  '/state',
  route((req) => {
    const s = designState(keyFrom(req));
    if (!s) {
      const err = new Error('no design for this file yet');
      err.status = 404;
      throw err;
    }
    return s;
  })
);

designRouter.put(
  '/doc',
  route((req) => {
    writeDoc(keyFrom(req), req.body?.content);
    return { ok: true, savedAt: new Date().toISOString() };
  })
);

designRouter.post(
  '/items',
  route((req) => createItems(keyFrom(req), req.body?.items, { note: req.body?.note }))
);

designRouter.post(
  '/item/update',
  route((req) => updateItem(keyFrom(req), itemFrom(req), req.body?.patch || {}, { note: req.body?.note, by: 'agent' }))
);

designRouter.post(
  '/item/remove',
  route((req) => {
    removeItem(keyFrom(req), itemFrom(req));
    return { ok: true };
  })
);

/** Agent-only, during a re-derive: the prose no longer makes this claim. */
designRouter.post(
  '/item/retire',
  route((req) => {
    retireItem(keyFrom(req), itemFrom(req), req.body?.reason);
    return { ok: true };
  })
);

/** Spinner state. `item` absent = the design-wide request (Derive). `action: null` clears. */
designRouter.post(
  '/request',
  route((req) => {
    const b = req.body || {};
    const n = b.item !== undefined || b.n !== undefined ? itemFrom(req) : null;
    setRequest(keyFrom(req), n, b.action || null, { scope: b.scope });
    return { ok: true };
  })
);

designRouter.post(
  '/run',
  route((req) => {
    const b = req.body || {};
    return startRun(keyFrom(req), itemFrom(req), {
      mode: b.mode || 'normal',
      unfreeze: b.unfreeze === true,
      reason: b.reason || '',
      label: b.label || '',
    });
  })
);

/** Poll a run. `wait=<seconds>` long-polls until it finishes (capped at 9 minutes). */
designRouter.get(
  '/run',
  route((req) => waitRun(keyFrom(req), itemFrom(req), String(req.query.runId || ''), Number(req.query.wait || 0)))
);

designRouter.get('/file', route((req) => readItemFile(keyFrom(req), itemFrom(req), req.query.path)));

designRouter.get('/diff', route((req) => itemDiff(keyFrom(req), itemFrom(req))));
