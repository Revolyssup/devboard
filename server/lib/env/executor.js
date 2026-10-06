import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ENV_ROOT, loadCatalog } from './catalog.js';
import { runProbe, defaultsFor, PROBE_STATE } from './probe.js';
import { ACTION } from './plan.js';
import { expandClaims } from './claims.js';
import { recordInstance, removeInstance, instanceId, acquireLease } from './instances.js';
import { setCached } from './probeCache.js';

/**
 * Plan executor.
 *
 * devboard owns execution rather than the agent, for three reasons that all bite in practice:
 *   1. a 20-40 minute setup must outlive the session that started it
 *   2. two sessions resolving against one machine must serialise — hence the single-writer lock
 *   3. log streaming and the tree view come free from the existing WS infrastructure
 *
 * After every step the layer is RE-PROBED. A setup script exiting 0 is a claim, not proof; the
 * probe is what decides whether the instance is recorded as healthy.
 */

const RUNS_DIR = path.join(ENV_ROOT, 'runs');
const MAX_BUFFERED_LINES = 5000;

/** One run at a time, machine-wide. Concurrent teardowns of a shared cluster are unrecoverable. */
let activeRun = null;
const runs = new Map();

export function currentRun() {
  return activeRun ? summarise(runs.get(activeRun)) : null;
}

export function getRun(id) {
  const r = runs.get(id);
  return r ? summarise(r) : readPersistedRun(id);
}

export function listRuns(limit = 20) {
  const live = [...runs.values()].map(summarise);
  const seen = new Set(live.map((r) => r.id));
  const past = [];
  try {
    for (const d of fs.readdirSync(RUNS_DIR).sort().reverse()) {
      if (seen.has(d)) continue;
      const r = readPersistedRun(d);
      if (r) past.push(r);
      if (live.length + past.length >= limit) break;
    }
  } catch {
    /* no runs yet */
  }
  return [...live, ...past]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit);
}

function readPersistedRun(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

function summarise(run) {
  if (!run) return null;
  return {
    id: run.id,
    target: run.target,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    session: run.session || null,
    steps: run.steps.map((s) => ({
      layer: s.layer,
      title: s.title,
      action: s.action,
      reason: s.reason,
      status: s.status,
      startedAt: s.startedAt || null,
      finishedAt: s.finishedAt || null,
      exitCode: s.exitCode ?? null,
      probeAfter: s.probeAfter || null,
      error: s.error || null,
    })),
  };
}

function persist(run) {
  const dir = path.join(RUNS_DIR, run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(summarise(run), null, 2)}\n`);
}

function paramEnv(params = {}) {
  const env = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    env[`ENV_PARAM_${k.replace(/[-a-z]/g, (c) => (c === '-' ? '_' : c.toUpperCase()))}`] = String(v);
  }
  return env;
}

/**
 * Start executing a plan.
 *
 * @param plan     the plan object from buildPlan
 * @param opts     { session, agent, directory, confirmedDestructive }
 * @returns        { id } — subscribe with subscribe(id, fn) for live events
 */
export function startRun(plan, opts = {}) {
  if (activeRun) {
    const err = new Error('another environment run is already in progress');
    err.status = 409;
    err.runId = activeRun;
    throw err;
  }
  if (!plan.executable) {
    const err = new Error('plan is not executable: a probe could not determine state');
    err.status = 400;
    throw err;
  }
  if (plan.requiresConfirmation && !opts.confirmedDestructive) {
    const err = new Error('plan contains destructive steps and was not confirmed');
    err.status = 412;
    throw err;
  }

  const catalog = loadCatalog();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.target}-${crypto
    .randomBytes(3)
    .toString('hex')}`;

  const run = {
    id,
    target: plan.target,
    session: opts.session || null,
    agent: opts.agent || null,
    directory: opts.directory || null,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    aborted: false,
    child: null,
    emitter: new EventEmitter(),
    log: [],
    steps: plan.steps
      // MANUAL steps cannot be executed here; they are surfaced to the UI and skipped.
      .map((s) => ({ ...s, status: 'pending' })),
  };
  runs.set(id, run);
  activeRun = id;
  persist(run);

  // Deliberately not awaited: the caller gets a run id immediately and follows via events.
  execute(run, catalog).catch((e) => {
    run.status = 'failed';
    run.error = e.message;
    emit(run, { t: 'done', ok: false, error: e.message });
    finish(run);
  });

  return { id };
}

export function abortRun(id) {
  const run = runs.get(id);
  if (!run || run.status !== 'running') return false;
  run.aborted = true;
  if (run.child) {
    // SIGTERM so the script's own traps run; kind/kubectl clean up their temp state on it.
    run.child.kill('SIGTERM');
  }
  emit(run, { t: 'log', chunk: '\n[aborted by user]\n' });
  return true;
}

export function subscribe(id, fn) {
  const run = runs.get(id);
  if (!run) return () => {};
  // Replay buffered output so a client that connects mid-run sees the whole step, not the tail.
  fn({ t: 'snapshot', run: summarise(run), log: run.log.join('') });
  run.emitter.on('event', fn);
  return () => run.emitter.off('event', fn);
}

function emit(run, ev) {
  if (ev.t === 'log') {
    run.log.push(ev.chunk);
    if (run.log.length > MAX_BUFFERED_LINES) run.log.splice(0, run.log.length - MAX_BUFFERED_LINES);
  }
  run.emitter.emit('event', ev);
}

function finish(run) {
  run.finishedAt = new Date().toISOString();
  run.child = null;
  if (activeRun === run.id) activeRun = null;
  persist(run);
}

async function execute(run, catalog) {
  for (const [i, step] of run.steps.entries()) {
    if (run.aborted) {
      step.status = 'skipped';
      continue;
    }

    const layer = catalog.get(step.layer);
    if (!layer) {
      step.status = 'failed';
      step.error = `unknown layer ${step.layer}`;
      break;
    }

    if (step.action === ACTION.REUSE) {
      step.status = 'reused';
      emit(run, { t: 'step', i, layer: step.layer, status: 'reused' });
      // Still record the instance: reuse is exactly when a lease should be taken out.
      await recordFromProbe(run, layer, step);
      continue;
    }

    if (step.action === ACTION.MANUAL) {
      // The MFA gate and the TSB tenant download live here. Surfaced, never faked.
      step.status = 'manual';
      emit(run, {
        t: 'step',
        i,
        layer: step.layer,
        status: 'manual',
        hint: manualHint(layer),
      });
      emit(run, { t: 'log', chunk: `\n[manual step] ${step.layer}: ${manualHint(layer)}\n` });
      continue;
    }

    const script = step.action === ACTION.TEARDOWN ? 'teardown.sh' : 'setup.sh';
    const file = path.join(layer.dir, script);
    if (!fs.existsSync(file)) {
      step.status = 'failed';
      step.error = `${step.layer}: no ${script}`;
      emit(run, { t: 'step', i, layer: step.layer, status: 'failed', error: step.error });
      break;
    }

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    emit(run, { t: 'step', i, layer: step.layer, status: 'running', action: step.action });
    emit(run, { t: 'log', chunk: `\n${'─'.repeat(70)}\n${step.action} ${step.layer}\n${'─'.repeat(70)}\n` });

    const code = await runScript(run, file, {
      ...defaultsFor(layer),
      ...(step.declared || {}),
    }, layer);

    step.exitCode = code;
    step.finishedAt = new Date().toISOString();

    if (run.aborted) {
      step.status = 'aborted';
      break;
    }
    if (code !== 0) {
      step.status = 'failed';
      step.error = `${script} exited ${code}`;
      emit(run, { t: 'step', i, layer: step.layer, status: 'failed', error: step.error });
      break;
    }

    // A script exiting 0 is a claim, not proof. The probe decides.
    const verified = await verifyStep(run, layer, step);
    step.status = verified ? 'done' : 'unverified';
    emit(run, { t: 'step', i, layer: step.layer, status: step.status, probeAfter: step.probeAfter });
    if (!verified) {
      step.error = `${step.layer}: ${script} succeeded but the probe does not agree`;
      break;
    }
    persist(run);
  }

  const bad = run.steps.find((s) => ['failed', 'unverified', 'aborted'].includes(s.status));
  run.status = run.aborted ? 'aborted' : bad ? 'failed' : 'succeeded';
  emit(run, { t: 'done', ok: run.status === 'succeeded', error: bad?.error || null });
  finish(run);
}

/**
 * What a human has to do for a manual step.
 *
 * Read from the recipe, never inferred from the id. The engine must contain no domain knowledge —
 * an earlier version hardcoded "run refresh.sh for your MFA code" and "download the admin config
 * from the TSB UI" here, which silently made a general engine TSB-specific.
 */
function manualHint(layer) {
  return layer.setup?.manualHint || `${layer.id} must be set up by hand`;
}

function runScript(run, file, params, layer) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [file], {
      env: {
        ...process.env,
        ...paramEnv(params),
        // Scripts print progress for a human reading a stream; keep colour.
        FORCE_COLOR: '1',
      },
      cwd: layer.dir,
    });
    run.child = child;

    const onData = (buf) => emit(run, { t: 'log', chunk: buf.toString() });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timeoutMs = (layer.setupTimeoutSec || 1800) * 1000;
    const timer = setTimeout(() => {
      emit(run, { t: 'log', chunk: `\n[timeout after ${timeoutMs / 1000}s — terminating]\n` });
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      run.child = null;
      resolve(code === null ? 124 : code);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      run.child = null;
      emit(run, { t: 'log', chunk: `\n[spawn failed: ${e.message}]\n` });
      resolve(127);
    });
  });
}

async function verifyStep(run, layer, step) {
  const params = { ...defaultsFor(layer), ...(step.declared || {}) };
  const probe = await runProbe(layer, { params });
  step.probeAfter = { state: probe.state, errors: probe.errors, identity: probe.identity };
  // The world just changed; keep the display cache honest rather than leaving the tree showing
  // pre-run state until someone hits refresh.
  setCached(layer.id, params, probe);

  if (step.action === ACTION.TEARDOWN) {
    const gone = probe.state === PROBE_STATE.ABSENT;
    emit(run, {
      t: 'log',
      chunk: gone
        ? `\n[verified] ${layer.id} is gone\n`
        : `\n[NOT VERIFIED] ${layer.id} still reports present after teardown\n`,
    });
    if (gone) removeInstance(instanceId(layer.id, params));
    return gone;
  }

  const ok = probe.state === PROBE_STATE.HEALTHY;
  emit(run, {
    t: 'log',
    chunk: ok
      ? `\n[verified] ${layer.id} is healthy\n`
      : `\n[NOT VERIFIED] ${layer.id} probes as ${probe.state}: ${probe.errors.join('; ')}\n`,
  });
  if (ok) await recordFromProbe(run, layer, step, probe);
  return ok;
}

async function recordFromProbe(run, layer, step, probeResult = null) {
  const params = { ...defaultsFor(layer), ...(step.declared || {}) };
  const probe = probeResult || (await runProbe(layer, { params }));
  if (probe.state !== PROBE_STATE.HEALTHY) return;

  const inst = recordInstance({
    layer: layer.id,
    declared: params,
    observed: probe.identity,
    parent: step.parent ? instanceId(step.parent, {}) : null,
    claims: expandClaims(layer, params),
    probeResult: probe.state,
  });
  if (run.session) {
    acquireLease(inst.id, { session: run.session, agent: run.agent, directory: run.directory });
  }
}
