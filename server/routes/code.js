import express from 'express';
import { resolveCandidate, peekFile, openInEditor } from '../lib/code.js';

export const codeRouter = express.Router();

/**
 * Batch-verify candidate file references before the client linkifies them.
 *
 * Batched because xterm's link provider fires per hovered row and a row can carry several
 * candidates; one round-trip per row keeps hover latency invisible. Results are positional.
 */
codeRouter.post('/resolve', (req, res) => {
  const { cwd, candidates } = req.body || {};
  if (!cwd || !Array.isArray(candidates)) {
    return res.status(400).json({ error: 'cwd and candidates[] are required' });
  }
  if (candidates.length > 64) {
    return res.status(400).json({ error: 'too many candidates in one batch' });
  }
  res.json({
    results: candidates.map((c) => {
      const r = resolveCandidate(cwd, c?.path);
      return r.ok ? { ok: true, absPath: r.absPath } : { ok: false, error: r.error };
    }),
  });
});

/** File content for the peek overlay — at an explicit ref when given, else the working tree. */
codeRouter.get('/peek', async (req, res) => {
  try {
    const { cwd, path: p, ref } = req.query;
    if (!cwd || !p) return res.status(400).json({ error: 'cwd and path are required' });
    res.json(await peekFile({ cwd: String(cwd), path: String(p), ref: ref ? String(ref) : null }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * Open the reference in VS Code — with the session cwd as the workspace when the file is inside
 * it, so the editor lands with the full tree rather than a lone file.
 */
codeRouter.post('/open', async (req, res) => {
  try {
    const { cwd, path: p, line, col } = req.body || {};
    if (!cwd || !p) return res.status(400).json({ error: 'cwd and path are required' });
    res.json(await openInEditor({ cwd, path: p, line, col }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
