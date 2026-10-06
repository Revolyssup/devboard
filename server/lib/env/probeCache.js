import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENV_ROOT } from './catalog.js';

/**
 * Cache of probe results, for DISPLAY ONLY.
 *
 * The system's central rule is "instance files are a cache of belief, probes are truth", and this
 * file does not weaken it. Nothing that makes a decision reads from here: `buildPlan`, the executor
 * and every teardown path go through `probeAll`, which always shells out and always gets the truth.
 *
 * What this fixes is a UI problem. Opening an environment re-ran every probe from scratch, and the
 * slowest of them (an authenticated round-trip to ECR) put a 12-second wall in front of a view the
 * user just wanted to glance at. Once an environment is up it does not usually change minute to
 * minute, so showing the last known result immediately — clearly stamped with when it was taken —
 * is both faster and more honest than a spinner that hides the same information.
 *
 * Every cached entry carries `probedAt`, and the UI shows it. Stale is a label, never a silent
 * substitution for fresh.
 */

const CACHE_FILE = path.join(ENV_ROOT, '.cache', 'probes.json');

/** Display-staleness. Older entries are still shown, just marked so the user can refresh. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

let mem = null;

function load() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    mem = {};
  }
  return mem;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // A cache that cannot be written is a performance problem, never a correctness one.
  }
}

/**
 * Params are part of the key: a probe run for `tag=ashish` says nothing about `tag=other`, and
 * silently reusing it across parameter sets would be exactly the stale-belief bug in a new place.
 */
function keyFor(layerId, params = {}) {
  const canonical = JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]])
  );
  return `${layerId}:${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

export function getCached(layerId, params) {
  const e = load()[keyFor(layerId, params)];
  if (!e) return null;
  return { ...e.probe, probedAt: e.probedAt, stale: Date.now() - new Date(e.probedAt).getTime() > STALE_AFTER_MS };
}

export function setCached(layerId, params, probe) {
  load()[keyFor(layerId, params)] = { layer: layerId, probe, probedAt: new Date().toISOString() };
  persist();
}

/** Drop cached results. Called after a run, since the world just changed under us. */
export function invalidate(layerIds = null) {
  const c = load();
  for (const k of Object.keys(c)) {
    if (!layerIds || layerIds.includes(c[k].layer)) delete c[k];
  }
  persist();
}
