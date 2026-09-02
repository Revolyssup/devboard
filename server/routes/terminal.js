import express from 'express';
import { preflight, preflightNew, suggestDirectories, terminalSnapshot } from '../lib/terminals.js';

export const terminalRouter = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Validate a terminal request and mint a single-use ticket. Every rejection is a normal status +
 * `{ error, code }`, so the UI can say something useful before mounting any terminal chrome.
 */
terminalRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { scope, kind, agent, filename, sessionId, directory, cols, rows } = req.body || {};
    res.json(await preflight({ scope, kind, agent, filename, sessionId, directory, cols, rows }));
  })
);

terminalRouter.post(
  '/new',
  asyncRoute(async (req, res) => {
    const { scope, agent, directory, newKind, filename, title, learningTitle, choreTitle, choreDescription, cols, rows } =
      req.body || {};
    res.json(
      await preflightNew({
        scope,
        agent,
        directory,
        newKind,
        filename,
        title,
        learningTitle,
        choreTitle,
        choreDescription,
        cols,
        rows,
      })
    );
  })
);

terminalRouter.get(
  '/directories',
  asyncRoute(async (req, res) => {
    res.json(await suggestDirectories(String(req.query.q || '')));
  })
);

terminalRouter.get('/status', (_req, res) => res.json(terminalSnapshot()));
