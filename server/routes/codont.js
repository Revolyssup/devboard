import express from 'express';
import {
  listBindings,
  getBinding,
  createBinding,
  createTab,
  listTabs,
  readOntology,
  readStatus,
  writeStatus,
  readContext,
  writeContext,
  readJournal,
  appendJournal,
  applyDelta,
  envInfoFor,
  envShaForCwd,
  headSha,
  branchSuggestions,
} from '../lib/codont.js';
import { sessionBinding as envSessionBinding } from '../lib/env/instances.js';
import { ENV_ROOT } from '../lib/env/catalog.js';

export const codontRouter = express.Router();

const asError = (res, e) => res.status(e.status || 500).json({ error: e.message });

const envDeps = { sessionBinding: envSessionBinding, envRoot: ENV_ROOT };

function envSectionText(envInfo) {
  if (!envInfo) return null;
  const prov = envInfo.provenance.map((p) => `- ${p.repo} @ ${p.sha}${p.version ? ` (v${p.version})` : ''}`).join('\n');
  return `target: ${envInfo.target}\ninstruction: ${envInfo.instructions || '-'}\nprovenance:\n${prov || '- (none recorded)'}`;
}

/** Cheap index — drives button enablement on rows/toolbar. Pure file reads, like /api/env/sessions. */
codontRouter.get('/sessions', (_req, res) => {
  res.json(
    listBindings().map((b) => ({
      session: b.session,
      instruction: b.instruction,
      cwd: b.cwd,
      createdAt: b.createdAt,
    }))
  );
});

/**
 * /codont — creates the construct, the working-tree tab, and (when the session's environment pins
 * this repo to a different sha) a second tab at the env's version, because "what the environment
 * actually runs" is a version tab like any other.
 *
 * It does NOT build the diagram. The session's own agent does that with POST /update, having just
 * read the code; handing the job to a second agent meant re-deriving context it already had, over
 * a channel that could not report its own failures.
 */
codontRouter.post('/start', async (req, res) => {
  try {
    const { session, instruction, cwd } = req.body || {};
    if (!session || !instruction || !cwd) {
      return res.status(400).json({ error: 'session, instruction and cwd are required' });
    }
    const binding = createBinding({ session, instruction, cwd });
    const tab0 = await createTab(session, { ref: null });

    const envInfo = await envInfoFor(session, envDeps);
    const envSha = await envShaForCwd(binding.cwd, envInfo);
    const head = await headSha(binding.cwd);
    let envTab = null;
    if (envSha && head && envSha !== head) {
      envTab = await createTab(session, { ref: envSha, label: `env @ ${envSha.slice(0, 8)}` });
    }

    res.json({
      binding,
      tabs: listTabs(session),
      workingTabId: tab0.id,
      envTabCreated: Boolean(envTab),
      envTabId: envTab?.id || null,
      env: envSectionText(envInfo),
      next: `Read the code the instruction names, then POST /api/codont/update with {"session":"${session}","tabId":"${tab0.id}","mode":"replace","nodes":[...],"edges":[...],"context":"..."}.`,
    });
  } catch (e) {
    asError(res, e);
  }
});

/** Everything the view needs, in one poll. File reads only — no agent, no git churn. */
codontRouter.get('/state', async (req, res) => {
  try {
    const session = String(req.query.session || '');
    const binding = getBinding(session);
    if (!binding) return res.status(404).json({ error: `no code ontology for session ${session}` });

    const tabs = listTabs(session).map((t) => ({
      ...t,
      status: readStatus(session, t.id),
      ontology: readOntology(session, t.id),
    }));

    const envInfo = await envInfoFor(session, envDeps);
    const envSha = await envShaForCwd(binding.cwd, envInfo);
    const hasEnvTab = envSha ? tabs.some((t) => t.refResolved === envSha) : true;

    res.json({
      binding,
      context: readContext(session),
      journal: readJournal(session),
      tabs,
      env: envInfo,
      envMismatch: envSha && !hasEnvTab ? { sha: envSha } : null,
    });
  } catch (e) {
    asError(res, e);
  }
});

/**
 * The write path. Merge by default so a follow-up ("also add these two functions") is a small
 * call carrying only the delta; `mode: "replace"` for the initial build or a deliberate rewrite.
 *
 * The response is the useful part: which anchors the server had to move, which edges it dropped,
 * and which elements failed verification — so the agent can correct itself in the same breath
 * rather than leaving the user to spot a red box.
 */
codontRouter.post('/update', async (req, res) => {
  try {
    const body = req.body || {};
    const session = String(body.session || '');
    const binding = getBinding(session);
    if (!binding) return res.status(404).json({ error: `no code ontology for session ${session} — run /codont first` });

    const tabs = listTabs(session);
    const tabId = body.tabId || tabs.find((t) => t.refResolved === null)?.id || tabs[0]?.id;
    if (!tabId) return res.status(404).json({ error: 'this ontology has no tabs' });
    if (!tabs.some((t) => t.id === tabId)) {
      return res.status(404).json({ error: `unknown tabId '${tabId}' — have ${tabs.map((t) => t.id).join(', ')}` });
    }

    const result = await applyDelta(session, tabId, body);

    if (typeof body.context === 'string' && body.context.trim()) writeContext(session, body.context);
    appendJournal(session, { ...result, tabLabel: result.tab.label, note: body.note || null });
    writeStatus(session, tabId, { state: 'idle', finishedAt: new Date().toISOString() });

    res.json({ ok: true, ...result, context: readContext(session) });
  } catch (e) {
    asError(res, e);
  }
});

/**
 * Diff with another version: create the pinned tab. It starts EMPTY on purpose — the agent fills
 * it by reading that ref, the same way it filled tab 0. An auto-build here would be a diagram
 * nobody checked.
 */
codontRouter.post('/tab', async (req, res) => {
  try {
    const { session, ref } = req.body || {};
    if (!session || !ref) return res.status(400).json({ error: 'session and ref are required' });
    const tab = await createTab(session, { ref });
    res.json({
      tab,
      next: `Read the code at ${tab.refResolved} via \`git show\`, then POST /api/codont/update with tabId "${tab.id}".`,
    });
  } catch (e) {
    asError(res, e);
  }
});

/** Branch/tag suggestions for the diff popup, most-recent first. */
codontRouter.get('/branches', async (req, res) => {
  try {
    const session = String(req.query.session || '');
    const binding = getBinding(session);
    if (!binding) return res.status(404).json({ error: 'no code ontology for this session' });
    res.json({ branches: await branchSuggestions(binding.cwd, String(req.query.q || '')) });
  } catch (e) {
    asError(res, e);
  }
});
