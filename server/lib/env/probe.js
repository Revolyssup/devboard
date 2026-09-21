import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { expandHome } from './catalog.js';

/**
 * Probe runner.
 *
 * The central rule from the spec: instance files are a cache of belief, probes are truth. Nothing
 * in the planner may act on recorded state without a fresh probe result from here.
 *
 * Probe exit codes:
 *   0        -> it ran; trust the JSON it printed
 *   non-zero -> the probe itself broke. That is `unknown`, NOT absent. Treating it as absent
 *               would let a broken probe green-light a destructive rebuild of something that
 *               is actually alive.
 */

export const PROBE_STATE = {
  ABSENT: 'absent',
  DEGRADED: 'degraded',
  HEALTHY: 'healthy',
  UNKNOWN: 'unknown',
};

function paramEnv(params = {}) {
  const env = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    env[`ENV_PARAM_${k.replace(/[-a-z]/g, (c) => (c === '-' ? '_' : c.toUpperCase()))}`] = String(v);
  }
  return env;
}

export function runProbe(layer, { params = {}, parentInstance = null, timeoutSec } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(layer.probeScript)) {
      resolve({
        state: PROBE_STATE.UNKNOWN,
        present: null,
        healthy: null,
        identity: {},
        details: [],
        errors: [`no probe.sh for layer '${layer.id}'`],
      });
      return;
    }

    const timeout = (timeoutSec || layer.probeTimeoutSec || 30) * 1000;
    const env = {
      ...process.env,
      ...paramEnv({ ...defaultsFor(layer), ...params }),
      ENV_PARENT_JSON: parentInstance ? JSON.stringify(parentInstance) : '',
    };

    execFile('/bin/bash', [layer.probeScript], { env, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = err.killed || err.signal === 'SIGTERM';
        resolve({
          state: PROBE_STATE.UNKNOWN,
          present: null,
          healthy: null,
          identity: {},
          details: [],
          errors: [
            timedOut
              ? `probe timed out after ${timeout / 1000}s`
              : (stderr || err.message || '').trim() || `probe exited ${err.code}`,
          ],
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve({
          state: PROBE_STATE.UNKNOWN,
          present: null,
          healthy: null,
          identity: {},
          details: [],
          errors: [`probe emitted invalid JSON: ${stdout.slice(0, 200)}`],
        });
        return;
      }
      const present = parsed.present === true;
      const healthy = parsed.healthy === true;
      resolve({
        state: !present ? PROBE_STATE.ABSENT : healthy ? PROBE_STATE.HEALTHY : PROBE_STATE.DEGRADED,
        present,
        healthy,
        identity: parsed.identity || {},
        details: parsed.details || [],
        errors: parsed.errors || [],
      });
    });
  });
}

export function defaultsFor(layer) {
  const out = {};
  for (const [name, spec] of Object.entries(layer.params || {})) {
    if (spec && spec.default !== undefined && spec.default !== null) {
      // Expand ~ so declared paths compare equal to what probes report. The probes resolve $HOME
      // before echoing a path back, so leaving the tilde here made every path param a permanent
      // mismatch — tctl-bin was being scheduled for a 10-minute rebuild purely over '~'.
      out[name] = typeof spec.default === 'string' ? expandHome(spec.default) : spec.default;
    }
  }
  return out;
}
