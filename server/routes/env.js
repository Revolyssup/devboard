import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadCatalog, chooseParent } from '../lib/env/catalog.js';
import { probeAll, buildPlan, buildTeardownPlan, chainFor, paramsFor } from '../lib/env/plan.js';
import { defaultsFor, runProbe } from '../lib/env/probe.js';
import { getCached, setCached, invalidate } from '../lib/env/probeCache.js';
import { startRun, abortRun, getRun, listRuns, currentRun } from '../lib/env/executor.js';
import {
  listInstances,
  listSessionBindings,
  sessionBinding,
  bindSession,
  unbindSession,
  endSession,
  releaseLease,
} from '../lib/env/instances.js';

export const envRouter = express.Router();

/**
 * Environment composition API.
 *
 * Probing is not free (it shells out to every layer), so `tree` and `plan` are POST/GET endpoints
 * the UI calls deliberately rather than on a poll.
 */

const asError = (res, e) => res.status(e.status || 500).json({ error: e.message, runId: e.runId });

envRouter.get('/layers', (_req, res) => {
  const catalog = loadCatalog();
  res.json(
    [...catalog.values()].map((l) => ({
      id: l.id,
      title: l.title || l.id,
      kind: l.kind,
      parents: l.parents,
      requires: l.requires,
      claims: l.claims,
      params: l.params,
      teardown: l.teardown || 'allowed',
      interactive: Boolean(l.setup?.interactive),
      estimateSec: l.estimateSec ?? null,
    }))
  );
});

/**
 * The tree the UI renders for ONE session's environment.
 *
 * `?session=<id>` is the normal call: it resolves that session's bound target and probes only
 * that chain. Environments are per-session (1:1 for now), so probing the whole catalog to render
 * one of them is wasted work — and probing at all is something that only happens when a user
 * explicitly opens an environment, never on page load.
 *
 * Omitting `session` probes everything; that path exists for debugging, not for the UI.
 */
envRouter.get('/tree', async (req, res) => {
  try {
    const catalog = loadCatalog();
    const session = req.query.session ? String(req.query.session) : null;

    let only = null;
    let binding = null;
    let params = {};
    if (session) {
      binding = sessionBinding(session);
      if (!binding) return res.status(404).json({ error: `no environment bound to session ${session}` });
      only = chainFor(catalog, binding.target, { via: binding.via || null });
      // Probe with the params this environment was built for, not defaults.
      params = paramsFor(catalog, binding.target, binding.params || {}, { via: binding.via || null });
    }

    // Cached-only: this returns immediately and never shells out. Layers with no cached result
    // come back as `pending`, and the client probes them individually so a slow one (ECR) renders
    // a spinner on its own row instead of holding up the whole tree.
    const probes = new Map();
    for (const layer of catalog.values()) {
      if (only && !only.has(layer.id)) continue;
      const p = params[layer.id] || defaultsFor(layer);
      const cached = req.query.fresh === '1' ? null : getCached(layer.id, p);
      probes.set(layer.id, {
        layer,
        params: p,
        probe: cached || {
          state: 'pending',
          present: null,
          healthy: null,
          identity: {},
          details: [],
          errors: [],
          probedAt: null,
          stale: true,
        },
      });
    }

    const instances = listInstances();
    const bindings = listSessionBindings();
    const now = Date.now();

    const live = new Set([...probes.entries()].filter(([, r]) => r.probe.present).map(([id]) => id));

    const nodes = [...catalog.values()]
      .filter((l) => !only || only.has(l.id))
      .map((layer) => {
      const r = probes.get(layer.id);
      const inst = instances.find((i) => i.layer === layer.id) || null;
      return {
        id: layer.id,
        title: layer.title || layer.id,
        kind: layer.kind,
        parent: chooseParent(layer, { live }),
        parents: layer.parents,
        requires: layer.requires,
        state: r.probe.state,
        present: r.probe.present,
        healthy: r.probe.healthy,
        // When this was last actually observed. Null means never probed — shown as pending, never
        // as absent.
        probedAt: r.probe.probedAt ?? null,
        stale: r.probe.stale ?? false,
        // Observed, not declared — what is actually running.
        properties: r.probe.identity,
        details: r.probe.details,
        errors: r.probe.errors,
        teardown: layer.teardown || 'allowed',
        estimateSec: layer.estimateSec ?? null,
        claims: layer.claims,
        instance: inst
          ? {
              id: inst.id,
              createdAt: inst.createdAt,
              leases: (inst.leases || []).map((l) => ({
                ...l,
                live: new Date(l.expiresAt).getTime() > now,
              })),
            }
          : null,
        sessions: bindings.filter((b) => (b.instances || []).includes(layer.id)).map((b) => b.session),
      };
    });

    res.json({
      nodes,
      session,
      target: binding?.target || null,
      instructions: binding?.instructions || null,
      // The params this environment was built with. The UI must plan and run with these, not with
      // recipe defaults, or it reports rebuilds that are not real.
      params: binding?.params || {},
      via: binding?.via || null,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    asError(res, e);
  }
});

/**
 * Probe ONE layer and refresh its cache entry. This is what makes the tree progressive: the client
 * renders instantly from cache, then fires one of these per pending/stale layer in parallel, so a
 * 12-second ECR check spins on its own row rather than blocking everything.
 */
envRouter.post('/probe/:layer', async (req, res) => {
  try {
    const catalog = loadCatalog();
    const layer = catalog.get(req.params.layer);
    if (!layer) return res.status(404).json({ error: `unknown recipe '${req.params.layer}'` });

    const { session = null } = req.body || {};
    let params = defaultsFor(layer);
    if (session) {
      const b = sessionBinding(session);
      if (b) params = paramsFor(catalog, b.target, b.params || {}, { via: b.via || null })[layer.id] || params;
    }

    const probe = await runProbe(layer, { params });
    setCached(layer.id, params, probe);
    res.json({
      id: layer.id,
      state: probe.state,
      present: probe.present,
      healthy: probe.healthy,
      properties: probe.identity,
      details: probe.details,
      errors: probe.errors,
      probedAt: new Date().toISOString(),
      stale: false,
    });
  } catch (e) {
    asError(res, e);
  }
});

/** Drop cached probe results for a session's chain, so the next tree load re-probes everything. */
envRouter.post('/tree/refresh', (req, res) => {
  const { session = null } = req.body || {};
  const catalog = loadCatalog();
  let layers = null;
  if (session) {
    const b = sessionBinding(session);
    if (!b) return res.status(404).json({ error: `no environment bound to session ${session}` });
    layers = [...chainFor(catalog, b.target, { via: b.via || null })];
  }
  invalidate(layers);
  res.json({ invalidated: layers || 'all' });
});

/**
 * RESOURCE CONTRACT (see any recipe's resources.sh).
 *
 *   list        -> JSON array of {id, kind, name, namespace, cluster, state, file}
 *   show <id>   -> YAML on stdout
 *
 * The engine only shells out; every notion of what a "resource" is lives in the recipe. That is
 * what lets an XCP scenario, a TSB workspace and an Istio config all be inspected the same way
 * without the engine learning any of them.
 */
function recipeResources(layer, params, args) {
  return new Promise((resolve, reject) => {
    const script = path.join(layer.dir, 'resources.sh');
    if (!fs.existsSync(script)) return resolve(null);
    execFile(
      '/bin/bash',
      [script, ...args],
      { env: { ...process.env, ...paramEnvFor(params) }, timeout: 60_000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim().slice(0, 500)));
        resolve(stdout);
      }
    );
  });
}

function paramEnvFor(params = {}) {
  const env = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    env[`ENV_PARAM_${k.replace(/[-a-z]/g, (c) => (c === '-' ? '_' : c.toUpperCase()))}`] = String(v);
  }
  return env;
}

/** Resolve a layer's params for a session, so resources reflect the bound environment. */
function paramsForLayer(catalog, layer, session) {
  let params = defaultsFor(layer);
  if (session) {
    const b = sessionBinding(session);
    if (b) params = paramsFor(catalog, b.target, b.params || {}, { via: b.via || null })[layer.id] || params;
  }
  return params;
}

/** What configs does this layer manage, and has the cluster drifted from them? */
envRouter.get('/resources/:layer', async (req, res) => {
  try {
    const catalog = loadCatalog();
    const layer = catalog.get(req.params.layer);
    if (!layer) return res.status(404).json({ error: `unknown recipe '${req.params.layer}'` });
    const params = paramsForLayer(catalog, layer, req.query.session ? String(req.query.session) : null);
    const out = await recipeResources(layer, params, ['list']);
    if (out === null) return res.json({ supported: false, resources: [] });
    res.json({ supported: true, resources: JSON.parse(out) });
  } catch (e) {
    asError(res, e);
  }
});

/** The YAML for one config — live from the cluster when it exists, the rendered file when not. */
envRouter.get('/resources/:layer/show', async (req, res) => {
  try {
    const catalog = loadCatalog();
    const layer = catalog.get(req.params.layer);
    if (!layer) return res.status(404).json({ error: `unknown recipe '${req.params.layer}'` });
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const params = paramsForLayer(catalog, layer, req.query.session ? String(req.query.session) : null);
    const yaml = await recipeResources(layer, params, ['show', id]);
    if (yaml === null) return res.status(404).json({ error: 'recipe has no resources.sh' });
    res.json({ id, yaml });
  } catch (e) {
    asError(res, e);
  }
});

envRouter.post('/plan', async (req, res) => {
  try {
    const { target, params = {}, via = null } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target is required' });
    const catalog = loadCatalog();
    if (!catalog.has(target)) return res.status(404).json({ error: `unknown layer '${target}'` });
    const probes = await probeAll(catalog, paramsFor(catalog, target, params, { via }));
    res.json(buildPlan(catalog, { target, params, via }, probes));
  } catch (e) {
    asError(res, e);
  }
});

/**
 * Execute a plan. The plan is re-derived server-side from the target rather than trusted from the
 * client: a stale plan posted minutes later could tear down something that has since changed.
 */
envRouter.post('/run', async (req, res) => {
  try {
    const {
      target,
      params = {},
      via = null,
      session = null,
      agent = 'claude',
      directory = null,
      confirmDestructive = false,
    } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target is required' });

    const catalog = loadCatalog();
    if (!catalog.has(target)) return res.status(404).json({ error: `unknown layer '${target}'` });
    const probes = await probeAll(catalog, paramsFor(catalog, target, params, { via }));
    const plan = buildPlan(catalog, { target, params, via }, probes);

    const { id } = startRun(plan, { session, agent, directory, confirmedDestructive: confirmDestructive });
    // `rebind: false` lets a caller build one layer of an existing environment without retargeting
    // the session's binding to it — otherwise clicking "Plan to reach this" on kind-clusters and
    // running it would shrink the session's whole environment to just that layer.
    if (session && req.body?.rebind !== false) {
      // Persist params/via with the binding: without them the tree would later re-probe this
      // environment with defaults and mis-report a deliberately pinned version as drift.
      bindSession(session, {
        target,
        params,
        via,
        instances: plan.steps.map((s) => s.layer),
        agent,
        directory,
      });
    }
    res.json({ runId: id, plan });
  } catch (e) {
    asError(res, e);
  }
});

/** Preview a teardown of `target` plus everything live on top of it. Never executes. */
envRouter.post('/teardown/plan', async (req, res) => {
  try {
    const { target } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target is required' });
    const catalog = loadCatalog();
    if (!catalog.has(target)) return res.status(404).json({ error: `unknown layer '${target}'` });
    const probes = await probeAll(catalog);
    res.json(buildTeardownPlan(catalog, target, probes));
  } catch (e) {
    asError(res, e);
  }
});

/** Execute a teardown. Re-derived server-side and gated on confirmDestructive, like /run. */
envRouter.post('/teardown', async (req, res) => {
  try {
    const {
      target,
      session = null,
      agent = 'claude',
      directory = null,
      confirmDestructive = false,
    } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target is required' });
    const catalog = loadCatalog();
    if (!catalog.has(target)) return res.status(404).json({ error: `unknown layer '${target}'` });
    const probes = await probeAll(catalog);
    const plan = buildTeardownPlan(catalog, target, probes);
    if (!plan.steps.length) return res.status(400).json({ error: `${target} is not live; nothing to tear down` });
    const { id } = startRun(plan, { session, agent, directory, confirmedDestructive: confirmDestructive });
    res.json({ runId: id, plan });
  } catch (e) {
    asError(res, e);
  }
});

envRouter.get('/runs', (_req, res) => res.json(listRuns()));
envRouter.get('/runs/current', (_req, res) => res.json(currentRun()));
envRouter.get('/runs/:id', (req, res) => {
  const r = getRun(req.params.id);
  if (!r) return res.status(404).json({ error: 'no such run' });
  res.json(r);
});
envRouter.post('/runs/:id/abort', (req, res) => res.json({ aborted: abortRun(req.params.id) }));

envRouter.get('/instances', (_req, res) => res.json(listInstances()));

/**
 * Which sessions have an environment. Pure file reads, NO probing — the dashboard calls this on
 * render to decide which rows get an Env button, and rendering a list must never shell out to
 * fourteen probe scripts.
 */
envRouter.get('/sessions', (_req, res) => {
  const catalog = loadCatalog();
  // The dashboard row shows the icon of the environment's ROOT — the broadest thing it stands on
  // (Docker Desktop here). Resolved by walking containment up from the target; cheap, no probes.
  const rootOf = (target, via) => {
    let cur = target;
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const next = chooseParent(catalog.get(cur), { via });
      if (!next) break;
      cur = next;
    }
    return catalog.get(cur) || null;
  };
  res.json(
    listSessionBindings().map((b) => {
      const root = catalog.has(b.target) ? rootOf(b.target, b.via || null) : null;
      return {
        session: b.session,
        agent: b.agent,
        target: b.target,
        instructions: b.instructions || null,
        directory: b.directory,
        boundAt: b.boundAt,
        updatedAt: b.updatedAt,
        root: root ? { id: root.id, title: root.title || root.id, icon: root.icon || null } : null,
      };
    })
  );
});

/** Bind an environment to a session. Called by /start-env once a target has been resolved. */
envRouter.post('/bind', (req, res) => {
  const { session, target, instructions = null, via = null, params = null, agent = 'claude', directory = null } =
    req.body || {};
  if (!session || !target) return res.status(400).json({ error: 'session and target are required' });
  const catalog = loadCatalog();
  if (!catalog.has(target)) return res.status(404).json({ error: `unknown layer '${target}'` });
  res.json(bindSession(session, { target, instructions, via, params, agent, directory, instances: [] }));
});

envRouter.delete('/bind/:session', (req, res) => res.json({ unbound: unbindSession(req.params.session) }));

/**
 * /end-env — end a session's environment.
 *
 * Releases the session's leases, deletes the instance records it alone held, and removes the
 * binding so the Env button disappears from its row. Infrastructure is NOT destroyed: that is
 * `POST /api/env/teardown`, run first and explicitly if the machine should actually be freed.
 */
envRouter.post('/end', (req, res) => {
  const { session } = req.body || {};
  if (!session) return res.status(400).json({ error: 'session is required' });

  const binding = sessionBinding(session);
  if (!binding) return res.status(404).json({ error: `no environment bound to session ${session}` });

  // Scope the sweep to this environment's own chain so an unrelated instance is never collected.
  let layers = null;
  try {
    layers = [...chainFor(loadCatalog(), binding.target, { via: binding.via || null })];
  } catch {
    layers = null; // target no longer in the catalog; fall back to lease ownership alone
  }

  res.json({ ...endSession(session, { layers }), target: binding.target });
});

envRouter.post('/instances/:id/release', (req, res) => {
  const { session } = req.body || {};
  if (!session) return res.status(400).json({ error: 'session is required' });
  res.json(releaseLease(req.params.id, session) || { released: false });
});

/** Defaults for a layer, so the UI can prefill the plan form. */
envRouter.get('/layers/:id/defaults', (req, res) => {
  const catalog = loadCatalog();
  const layer = catalog.get(req.params.id);
  if (!layer) return res.status(404).json({ error: 'unknown layer' });
  res.json(defaultsFor(layer));
});
