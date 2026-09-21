#!/usr/bin/env node
/**
 * Tests for the environment resolver.
 *
 * The conflict engine is the central claim of the design ("conflict is derived from claims, never
 * asserted pairwise") and it cannot be exercised against the live machine while nothing is
 * running. So the probe layer is stubbed here and the planner is driven over synthetic worlds.
 *
 * Run: node scripts/verify-env.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalog } from '../server/lib/env/catalog.js';
import { buildPlan, paramsFor, ACTION, satisfies } from '../server/lib/env/plan.js';
import { claimsOverlap, findConflicts, expandClaims, interpolate } from '../server/lib/env/claims.js';
import { defaultsFor } from '../server/lib/env/probe.js';

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
  } else {
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const catalog = loadCatalog();

/** Build a probes map where every layer is absent, then override specific ones. */
function world(overrides = {}) {
  const probes = new Map();
  for (const layer of catalog.values()) {
    const params = { ...defaultsFor(layer), ...(overrides[layer.id]?.params || {}) };
    const o = overrides[layer.id];
    const present = o ? o.present !== false : false;
    const healthy = o ? o.healthy !== false : false;
    probes.set(layer.id, {
      layer,
      params,
      probe: {
        state: !present ? 'absent' : healthy ? 'healthy' : 'degraded',
        present,
        healthy,
        identity: o?.identity || (present ? params : {}),
        details: o?.details || [],
        errors: o?.errors || [],
      },
    });
  }
  return probes;
}

const HOST = { present: true, healthy: true };
const baseUp = {
  'host-docker': { ...HOST, identity: { dockerVersion: '29.0.1', minCpu: 11, minMemGi: 30 } },
  'registry-local': { ...HOST, identity: { name: 'local-docker-registry', port: 5000 } },
  // Omit `identity` so the fixture falls back to the declared params — an explicitly empty
  // identity means "the probe observed nothing", which correctly forces a rebuild.
  'ecr-auth': { ...HOST },
  'images-xcp': { ...HOST, identity: { tag: 'ashish', hub: 'localhost:5000' } },
  'images-tsb': { ...HOST, identity: { tag: 'ashish', hub: 'localhost:5000' } },
  'tctl-bin': { ...HOST },
  'kind-clusters': { ...HOST, identity: { clusters: 2, k8sVersion: '1.33.7' } },
};

// ---------------------------------------------------------------- catalog invariant
// Every declared param must be reported by its probe, unless match is 'any'. A param the probe
// never observes reads as a permanent identity mismatch, so the layer would be REBUILT on every
// single resolve — silently, and expensively. This is a static check because the failure is
// invisible on a machine where the layer happens to be absent anyway.
{
  const probeSrc = new Map();
  for (const layer of catalog.values()) {
    probeSrc.set(layer.id, fs.existsSync(layer.probeScript) ? fs.readFileSync(layer.probeScript, 'utf8') : '');
  }
  // Params can be emitted directly (identS/identJ) or through a shared helper. Helpers that emit
  // params on a probe's behalf must be declared here, or this lint reports false failures for
  // params that are in fact reported.
  const HELPER_EMITS = [
    // emit_provenance_identity <json> <prefix>  ->  <prefix>Version, <prefix>Sha
    {
      call: /emit_provenance_identity\s+\S+\s+(\w+)/g,
      params: (m) => [`${m[1]}Version`, `${m[1]}Sha`],
    },
  ];

  for (const layer of catalog.values()) {
    const src = probeSrc.get(layer.id);
    const viaHelper = new Set();
    for (const { call, params } of HELPER_EMITS) {
      for (const m of src.matchAll(call)) params(m).forEach((p) => viaHelper.add(p));
    }
    for (const [name, spec] of Object.entries(layer.params || {})) {
      if ((spec?.match || 'exact') === 'any') continue;
      const reported = new RegExp(`ident[SJ]\\s+${name}\\b`).test(src) || viaHelper.has(name);
      check(`${layer.id}: probe reports declared param '${name}'`, reported);
    }
  }
}

// ---------------------------------------------------------------- script inventory invariant
// A layer the resolver may CREATE must have a setup.sh, and one it may TEAR DOWN must have a
// teardown.sh. Without this the planner happily emits a step nothing can execute.
{
  for (const layer of catalog.values()) {
    check(`${layer.id}: has setup.sh`, fs.existsSync(`${layer.dir}/setup.sh`));
    // A step the executor cannot automate must explain itself FROM THE RECIPE. The engine has no
    // domain knowledge to fall back on, so a missing hint leaves the user with "must be set up by
    // hand" and nothing else.
    if (layer.setup?.interactive || layer.teardown === 'manual') {
      check(`${layer.id}: manual/interactive recipe declares setup.manualHint`,
        Boolean(layer.setup?.manualHint));
    }
    const teardownable = (layer.teardown || 'allowed') === 'allowed';
    check(
      `${layer.id}: teardown.sh present iff teardown is allowed`,
      teardownable === fs.existsSync(`${layer.dir}/teardown.sh`),
      `teardown=${layer.teardown}`
    );
  }
}

// ---------------------------------------------------------------- bash 3.2 portability
// The executor spawns /bin/bash, which on macOS is 3.2. bash-4-only builtins are NOT a syntax
// error there — they fail at runtime with "command not found" and, without set -e, execution
// simply continues with an empty array.
//
// This is not hypothetical: `mapfile` in kind-clusters/teardown.sh made the delete loop iterate
// over nothing, deleted the kubeconfigs anyway, and exited 0 while both clusters kept running.
{
  const BASH4_ONLY = [
    [/\bmapfile\b/, 'mapfile (bash 4+) — use the collect() helper'],
    [/\breadarray\b/, 'readarray (bash 4+) — use the collect() helper'],
    [/\bdeclare\s+-A\b/, 'declare -A associative arrays (bash 4+)'],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^/, '${var^^} case conversion (bash 4+)'],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*,,/, '${var,,} case conversion (bash 4+)'],
  ];
  const dirs = [...catalog.values()].map((l) => l.dir);
  const libDir = path.join(dirs[0], '..', 'lib');
  const files = [];
  for (const d of [...dirs, libDir]) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.sh')) files.push(path.join(d, f));
    }
  }
  check('found layer shell scripts to lint', files.length > 0);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [re, why] of BASH4_ONLY) {
      // The collect() helper's own docs mention mapfile by name; only flag real code.
      const offending = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .some((l) => re.test(l));
      check(`${path.basename(path.dirname(file))}/${path.basename(file)}: no ${why}`, !offending);
    }
  }
}

// ---------------------------------------------------------------- claim primitives
check('glob matches exact', claimsOverlap('cluster:*/ns:istio-system', 'cluster:*/ns:istio-system'));
check('distinct namespaces do not overlap', !claimsOverlap('cluster:*/ns:istio-system', 'cluster:*/ns:tsb'));
check('wildcard matches concrete', claimsOverlap('cluster:*/ns:istio-system', 'cluster:kind-0/ns:istio-system'));
check(
  'crd glob matches concrete crd',
  claimsOverlap('cluster:*/crd:*.install.xcp.tetrate.io', 'cluster:*/crd:edgexcps.install.xcp.tetrate.io')
);
check('different domains never overlap', !claimsOverlap('host:port:5000', 'cluster:*/ns:tsb'));
check('interpolation fills params', interpolate('tsb:workspace:${workspace}', { workspace: 'A' }) === 'tsb:workspace:A');
check('unresolved param widens to wildcard', interpolate('tsb:workspace:${workspace}', {}) === 'tsb:workspace:*');

// shared claims must never produce conflict
check(
  'shared vs shared is not a conflict',
  findConflicts({ exclusive: [], shared: ['cluster:*'], writes: [] }, { exclusive: [], shared: ['cluster:*'], writes: [] })
    .length === 0
);

// ---------------------------------------------------------------- the headline conflict
{
  const xcp = catalog.get('xcp-stack');
  const tsbCp = catalog.get('tsb-controlplane');
  const conflicts = findConflicts(expandClaims(xcp, defaultsFor(xcp)), expandClaims(tsbCp, defaultsFor(tsbCp)));
  check(
    'xcp-stack conflicts with tsb-controlplane',
    conflicts.some((c) => c.claim === 'cluster:*/ns:istio-system'),
    JSON.stringify(conflicts.map((c) => c.claim))
  );
}

// ---------------------------------------------------------------- tsb-config exclusivity
// Deliberately restrictive for now (Ashish, 2026-09-07): one tsb-config at a time, so a parent
// stack is never shared. The knob to relax it is documented in the layer's claims block. These
// tests pin the CURRENT decision — when the knob is turned, they are what must be updated.
{
  const cfg = catalog.get('tsb-config');
  const a = expandClaims(cfg, { ...defaultsFor(cfg), workspace: 'A' });
  const b = expandClaims(cfg, { ...defaultsFor(cfg), workspace: 'B' });
  check('workspace-A and workspace-B currently conflict (single-parent rule)',
    findConflicts(a, b).length > 0);
  check('the conflict is the cluster claim, not the workspace claim',
    findConflicts(a, b).some((c) => c.claim === 'cluster:*'),
    JSON.stringify(findConflicts(a, b).map((c) => c.claim)));
  check('tsb-config declares exclusiveInstances', cfg.exclusiveInstances === true);
  check('workspace identity still distinguishes instances',
    a.exclusive.includes('tsb:workspace:A') && b.exclusive.includes('tsb:workspace:B'));
}

// ---------------------------------------------------------------- identity matching
check('gte: 4 clusters satisfy a request for 2', satisfies(2, 4, 'gte'));
check('gte: 1 cluster does not satisfy 2', !satisfies(2, 1, 'gte'));
check('null declared means "whatever exists"', satisfies(null, '1.29.2', 'exact'));
check('semverGte compares numerically not lexically', satisfies('1.9.3', '1.10.0', 'semverGte'));
check('exact mismatch is a mismatch', !satisfies('ashish', 'other', 'exact'));
check('missing observation fails a concrete demand', !satisfies('ashish', null, 'exact'));

// ---------------------------------------------------------------- planner: reuse
{
  const plan = buildPlan(catalog, { target: 'xcp-stack', params: { clusters: 2 } }, world({
    ...baseUp,
    'xcp-stack': { ...HOST, identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
  }));
  const step = plan.steps.find((s) => s.layer === 'xcp-stack');
  check('healthy matching stack is reused', step.action === ACTION.REUSE, step.action);
  check('reuse plan is not destructive', plan.requiresConfirmation === false);
}

// ---------------------------------------------------------------- planner: gte prevents pointless rebuild
{
  const plan = buildPlan(catalog, { target: 'kind-clusters', params: { clusters: 2 } }, world({
    ...baseUp,
    'kind-clusters': { ...HOST, identity: { clusters: 4, k8sVersion: '1.33.7' } },
  }));
  const step = plan.steps.find((s) => s.layer === 'kind-clusters');
  check('4 existing clusters satisfy a request for 2 (no rebuild)', step.action === ACTION.REUSE, step.action);
}

// ---------------------------------------------------------------- planner: derived teardown
{
  const plan = buildPlan(catalog, { target: 'tsb-controlplane', params: { clusters: 2 } }, world({
    ...baseUp,
    'tsb-mgmt': { ...HOST, identity: { managementCluster: 0, tag: 'ashish' } },
    'tctl-admin-config': { ...HOST, identity: { path: '~/tctl-admin.config.yaml' } },
    'xcp-stack': { ...HOST, identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
  }));
  const td = plan.steps.find((s) => s.layer === 'xcp-stack' && s.action === ACTION.TEARDOWN);
  check('live xcp-stack is torn down to make room for tsb-controlplane', Boolean(td),
    JSON.stringify(plan.steps.map((s) => `${s.action} ${s.layer}`)));
  check('teardown names the claim that forced it', td?.conflicts?.includes('cluster:*/ns:istio-system'),
    JSON.stringify(td?.conflicts));
  check('destructive plan requires confirmation', plan.requiresConfirmation === true);
}

// ---------------------------------------------------------------- planner: cascade invalidation
{
  const plan = buildPlan(catalog, { target: 'xcp-stack', params: { clusters: 2 } }, world({
    ...baseUp,
    'kind-clusters': { present: false, healthy: false },
    'xcp-stack': { ...HOST, identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
  }));
  const step = plan.steps.find((s) => s.layer === 'xcp-stack');
  check('stack on dead clusters is not reused despite a healthy probe',
    step.action === ACTION.REBUILD, step.action);
}

// ---------------------------------------------------------------- planner: requirements of reused layers
{
  // The live-machine case: ecr-auth valid, aws-session absent. aws-session must NOT be planned.
  const plan = buildPlan(catalog, { target: 'kind-clusters', params: { clusters: 2 } }, world({
    ...baseUp,
    'kind-clusters': { present: false, healthy: false },
    'aws-session': { present: false, healthy: false },
  }));
  check('reused ecr-auth does not drag in an MFA prompt',
    !plan.steps.some((s) => s.layer === 'aws-session'),
    JSON.stringify(plan.steps.map((s) => s.layer)));
}
{
  // But when ecr-auth itself is broken, aws-session must be pulled in.
  const plan = buildPlan(catalog, { target: 'kind-clusters', params: { clusters: 2 } }, world({
    ...baseUp,
    'kind-clusters': { present: false, healthy: false },
    'ecr-auth': { present: false, healthy: false },
    'aws-session': { present: false, healthy: false },
  }));
  const aws = plan.steps.find((s) => s.layer === 'aws-session');
  check('broken ecr-auth does pull in aws-session', Boolean(aws));
  check('aws-session is flagged MANUAL, never automated', aws?.action === ACTION.MANUAL, aws?.action);
}

// ---------------------------------------------------------------- version drift
// The silent-wrong-answer bug: asking for xcp 1.14 on a machine holding 1.12 images at the same
// TAG produced a full REUSE. You would test 1.12 believing it was 1.14.
{
  const at = (v) => ({
    ...baseUp,
    'images-xcp': { ...HOST, identity: { tag: 'ashish', hub: 'localhost:5000', xcpVersion: v, xcpSha: 'aaa' } },
    'xcp-stack': {
      ...HOST,
      identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish', xcpVersion: v, xcpSha: 'aaa' },
    },
  });
  const plan = (params, w) => buildPlan(catalog, { target: 'xcp-stack', params }, world(w));
  const act = (p, id) => p.steps.find((s) => s.layer === id)?.action;

  const drift = plan({ clusters: 2, xcpVersion: '1.14' }, at('1.12'));
  check('drift: images-xcp is rebuilt', act(drift, 'images-xcp') === ACTION.REBUILD, act(drift, 'images-xcp'));
  // Both must move. Rebuilding only the images leaves the stack on the old pods, so you pay 15
  // minutes and still test the old version.
  check('drift: xcp-stack is rebuilt too', act(drift, 'xcp-stack') === ACTION.REBUILD, act(drift, 'xcp-stack'));
  check('drift: kind-clusters is REUSED, not destroyed',
    act(drift, 'kind-clusters') === ACTION.REUSE, act(drift, 'kind-clusters'));
  check('drift: registry is reused', act(drift, 'registry-local') === ACTION.REUSE);

  const match = plan({ clusters: 2, xcpVersion: '1.12' }, at('1.12'));
  check('matching version reuses everything', act(match, 'xcp-stack') === ACTION.REUSE, act(match, 'xcp-stack'));

  const unspecified = plan({ clusters: 2 }, at('1.12'));
  check('unspecified version costs nothing', act(unspecified, 'xcp-stack') === ACTION.REUSE);

  // Provenance missing (images built outside the env scripts) must never satisfy a declared
  // version — guessing "it probably matches" is what caused the original bug.
  const unknownProv = plan({ clusters: 2, xcpVersion: '1.14' }, at(null));
  check('unknown provenance never satisfies a declared version',
    act(unknownProv, 'xcp-stack') === ACTION.REBUILD, act(unknownProv, 'xcp-stack'));

  // Cross-cutting spread: the param must reach every recipe declaring it, not just the target.
  const spread = paramsFor(catalog, 'xcp-stack', { clusters: 4, xcpVersion: '1.14' });
  check('param spread reaches images-xcp', spread['images-xcp'].xcpVersion === '1.14');
  check('param spread reaches kind-clusters', spread['kind-clusters'].clusters === 4);
  check('param spread does not invent params a recipe never declared',
    !('xcpVersion' in spread['kind-clusters']), JSON.stringify(spread['kind-clusters']));
}

// ---------------------------------------------------------------- prerequisites are their own layers
// A required step must not live as a trailing block inside another layer's script. The Istio image
// mirror did, below a `die`, so an unrelated failed check silently skipped it — and nothing probed
// for the result, so the plan reported success while istiod sat in CrashLoopBackOff pulling a tag
// the registry never had.
{
  const istio = catalog.get('images-istio');
  check('images-istio exists as its own recipe', Boolean(istio));
  check('images-istio has a probe that can catch a missing mirror',
    fs.existsSync(`${istio.dir}/probe.sh`));
  // Every recipe that runs Istio must depend on the images being mirrored.
  for (const id of ['xcp-stack', 'tsb-controlplane']) {
    check(`${id} requires images-istio`, catalog.get(id).requires.includes('images-istio'),
      JSON.stringify(catalog.get(id).requires));
  }
  // And the step must no longer be duplicated where it can be skipped.
  const xcpSetup = fs.readFileSync(`${catalog.get('images-xcp').dir}/setup.sh`, 'utf8');
  check('images-xcp/setup.sh no longer owns the image-load step',
    !/make .*setup-images/.test(xcpSetup.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')));

  // A layer being rebuilt must pull its prerequisites in — that is what guarantees the mirror runs.
  const plan = buildPlan(catalog, { target: 'xcp-stack', params: {} }, world({
    ...baseUp,
    'images-istio': { present: false, healthy: false },
    'xcp-stack': { present: false, healthy: false },
  }));
  check('creating xcp-stack pulls images-istio into the plan',
    plan.steps.some((s) => s.layer === 'images-istio' && s.action === ACTION.CREATE),
    JSON.stringify(plan.steps.map((s) => `${s.action} ${s.layer}`)));
}

// ---------------------------------------------------------------- interactiveUnless
// A credential layer needs a human only when it has nothing to resume from. `interactiveUnless`
// names a probe-reported flag that lifts the MANUAL requirement, so a still-valid session does not
// demand an MFA code on every devboard restart. Generic: the engine never learns this is about MFA.
{
  const withAws = (identity) => {
    const probes = world({ 'kind-clusters': { present: false } });
    probes.set('aws-session', {
      layer: catalog.get('aws-session'),
      params: defaultsFor(catalog.get('aws-session')),
      probe: { state: 'absent', present: false, healthy: false, identity, details: [], errors: [] },
    });
    probes.set('ecr-auth', {
      layer: catalog.get('ecr-auth'),
      params: defaultsFor(catalog.get('ecr-auth')),
      probe: { state: 'absent', present: false, healthy: false, identity: {}, details: [], errors: [] },
    });
    return probes;
  };
  const actOf = (identity) =>
    buildPlan(catalog, { target: 'kind-clusters', params: {} }, withAws(identity))
      .steps.find((s) => s.layer === 'aws-session')?.action;

  check('aws-session recipe declares interactiveUnless',
    catalog.get('aws-session').setup?.interactiveUnless === 'resumable');
  check('not resumable -> MANUAL, a human is required',
    actOf({ resumable: false }) === ACTION.MANUAL, actOf({ resumable: false }));
  check('resumable -> executor may run it headlessly, no MFA prompt',
    actOf({ resumable: true }) === ACTION.CREATE, actOf({ resumable: true }));
  // A missing flag must not be read as permission to run headless.
  check('absent flag -> still MANUAL', actOf({}) === ACTION.MANUAL, actOf({}));
}

// ---------------------------------------------------------------- planner: unknown is not absent
{
  const probes = world({ ...baseUp, 'kind-clusters': { present: false } });
  probes.set('kind-clusters', {
    ...probes.get('kind-clusters'),
    probe: { state: 'unknown', present: null, healthy: null, identity: {}, details: [], errors: ['kubectl missing'] },
  });
  const plan = buildPlan(catalog, { target: 'xcp-stack', params: {} }, probes);
  const step = plan.steps.find((s) => s.layer === 'kind-clusters');
  check('unknown probe blocks the plan rather than assuming absent', step.action === ACTION.BLOCKED, step.action);
  check('a blocked plan is not executable', plan.executable === false);
}

// ---------------------------------------------------------------- planner: degraded + repair
{
  const plan = buildPlan(catalog, { target: 'xcp-stack', params: { clusters: 2 } }, world({
    ...baseUp,
    'xcp-stack': {
      present: true, healthy: false,
      identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' },
      errors: ['edge not available'],
    },
  }));
  const step = plan.steps.find((s) => s.layer === 'xcp-stack');
  check('degraded repairable layer is repaired, not rebuilt', step.action === ACTION.REPAIR, step.action);
}
{
  // kind-clusters sets repair: false, so a degraded cluster set must be rebuilt.
  const plan = buildPlan(catalog, { target: 'kind-clusters', params: { clusters: 2 } }, world({
    ...baseUp,
    'kind-clusters': { present: true, healthy: false, identity: { clusters: 2, k8sVersion: '1.33.7' }, errors: ['metallb missing'] },
  }));
  const step = plan.steps.find((s) => s.layer === 'kind-clusters');
  check('degraded non-repairable layer is rebuilt', step.action === ACTION.REBUILD, step.action);
}

// ---------------------------------------------------------------- alternative parents
{
  const plan = buildPlan(catalog, { target: 'echo-workloads', params: {} }, world({
    ...baseUp,
    'xcp-stack': { ...HOST, identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
  }));
  const step = plan.steps.find((s) => s.layer === 'echo-workloads');
  check('echo-workloads attaches to the live xcp-stack', step.parent === 'xcp-stack', step.parent);
  check('choosing the live parent avoids a TSB teardown',
    !plan.steps.some((s) => s.action === ACTION.TEARDOWN), JSON.stringify(plan.steps.map((s) => s.action)));
}
{
  const plan = buildPlan(catalog, { target: 'echo-workloads', params: {}, via: 'tsb-controlplane' }, world({
    ...baseUp,
    'xcp-stack': { ...HOST, identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
  }));
  const step = plan.steps.find((s) => s.layer === 'echo-workloads');
  check('via: forces the requested parent', step.parent === 'tsb-controlplane', step.parent);
}

// ---------------------------------------------------------------- decisions surfaced to the user
// The resolver is deterministic; deterministic is not the same as "the only reasonable answer".
// Every tie it breaks, guess it makes, or default it falls back on must be reported so /start-env
// can hand the judgement to the user instead of silently spending 20 minutes.
{
  check('semverPrefix: 1.14 accepts 1.14.13', satisfies('1.14', '1.14.13', 'semverPrefix'));
  check('semverPrefix: 1.14.12 rejects 1.14.13', !satisfies('1.14.12', '1.14.13', 'semverPrefix'));
  // The case string-prefix matching gets wrong: "1.14.1" IS a string prefix of "1.14.13".
  check('semverPrefix: 1.14.1 rejects 1.14.13', !satisfies('1.14.1', '1.14.13', 'semverPrefix'));
  check('semverPrefix: exact match satisfies', satisfies('1.14.13', '1.14.13', 'semverPrefix'));

  const at = (v) => ({
    ...baseUp,
    'images-xcp': { ...HOST, identity: { tag: 'ashish', hub: 'localhost:5000', xcpVersion: v, xcpSha: 'a' } },
    'xcp-stack': {
      ...HOST,
      identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish', xcpVersion: v, xcpSha: 'a' },
    },
  });

  const patch = buildPlan(catalog, { target: 'xcp-stack', params: { xcpVersion: '1.14.12' } }, world(at('1.14.13')));
  check('patch-level drift is flagged as a near miss, not decided silently',
    patch.decisions.nearMisses.some((n) => n.declared === '1.14.12' && n.observed === '1.14.13'),
    JSON.stringify(patch.decisions.nearMisses));
  check('a near miss forces a user decision', patch.decisions.needsUserDecision === true);

  const minor = buildPlan(catalog, { target: 'xcp-stack', params: { xcpVersion: '1.14' } }, world(at('1.12.9')));
  check('a genuinely different minor is NOT a near miss', minor.decisions.nearMisses.length === 0);

  const loose = buildPlan(catalog, { target: 'xcp-stack', params: { xcpVersion: '1.14' } }, world(at('1.14.13')));
  check('declaring only what you care about reuses',
    loose.steps.find((s) => s.layer === 'xcp-stack')?.action === ACTION.REUSE);

  // Assumed material defaults — generic, not version-specific.
  const cold = buildPlan(catalog, { target: 'xcp-stack', params: {} }, world({
    'host-docker': { ...HOST }, 'registry-local': { ...HOST }, 'ecr-auth': { ...HOST },
  }));
  check('material defaults the user never stated are surfaced',
    cold.decisions.assumed.some((a) => a.layer === 'xcp-stack' && a.param === 'ambient'),
    JSON.stringify(cold.decisions.assumed));
  // Plumbing must NOT be surfaced, or the prompt becomes noise the user learns to skip.
  check('plumbing params are not surfaced as decisions',
    !cold.decisions.assumed.some((a) => ['hub', 'tag', 'path', 'name'].includes(a.param)),
    JSON.stringify(cold.decisions.assumed.map((a) => a.param)));

  // Unobservable: declared something no probe can see.
  const blind = buildPlan(catalog, { target: 'xcp-stack', params: { xcpVersion: '1.14' } }, world(at(null)));
  check('an unobservable declaration is surfaced as such',
    blind.decisions.unobservable.some((u) => u.param === 'xcpVersion'),
    JSON.stringify(blind.decisions.unobservable));

  // A fully-specified plan against a matching machine asks nothing.
  const quiet = buildPlan(catalog,
    { target: 'xcp-stack', params: { xcpVersion: '1.14.13', clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
    world(at('1.14.13')));
  check('a plan with no judgement calls does not nag', quiet.decisions.needsUserDecision === false,
    JSON.stringify(quiet.decisions));
}

// ---------------------------------------------------------------- istio: reuse vs vanilla
// "Testing an Istio CR should reuse whatever TSB/XCP mesh is up (direct mode) unless I explicitly
// ask for vanilla; and with nothing up it should build a bare cluster, not a whole TSB stack."
{
  const meshLive = {
    ...baseUp,
    'xcp-stack': { ...HOST, identity: { clusters: 2, ambient: false, managementCluster: 0, tag: 'ashish' } },
  };
  const p = (spec, w) => buildPlan(catalog, { target: 'istio-config', ...spec }, world(w));
  const parentOf = (plan) => plan.steps.find((s) => s.layer === 'istio-config')?.parent;
  const act = (plan, id) => plan.steps.find((s) => s.layer === id)?.action;

  const reuse = p({ params: { namespace: 'demo' } }, meshLive);
  check('istio-config reuses a live XCP mesh', parentOf(reuse) === 'xcp-stack', parentOf(reuse));
  check('reusing a live mesh destroys nothing', reuse.requiresConfirmation === false);

  const vanilla = p({ params: { namespace: 'demo' }, via: 'istio-vanilla' }, meshLive);
  check('via: istio-vanilla overrides the live mesh', parentOf(vanilla) === 'istio-vanilla', parentOf(vanilla));
  // Derived from the shared istio-system claim, not asserted anywhere.
  check('vanilla-over-a-live-mesh is a derived, confirmed teardown',
    act(vanilla, 'xcp-stack') === ACTION.TEARDOWN && vanilla.requiresConfirmation === true,
    act(vanilla, 'xcp-stack'));

  const cold = p({ params: { namespace: 'demo' } }, baseUp);
  check('cold start picks vanilla, not a full TSB build',
    parentOf(cold) === 'istio-vanilla', parentOf(cold));

  // Priority order when several meshes are live: vanilla > xcp > tsb. The live-preference walks
  // the declared parent list in order, so this is exactly the order in the recipe.
  const tsbLive = {
    ...baseUp,
    'tsb-mgmt': { ...HOST },
    'tctl-admin-config': { ...HOST },
    'tsb-controlplane': { ...HOST, identity: { clusters: 2, tag: 'ashish', isolationBoundaries: true } },
  };
  const vanLive = { 'istio-vanilla': { ...HOST, identity: { clusters: 1, profile: 'default' } } };
  check('priority: xcp beats tsb when both are live',
    parentOf(p({ params: { namespace: 'demo' } }, { ...meshLive, ...tsbLive })) === 'xcp-stack');
  check('priority: vanilla beats everything when all are live',
    parentOf(p({ params: { namespace: 'demo' } }, { ...meshLive, ...tsbLive, ...vanLive })) === 'istio-vanilla');
  check('priority: tsb is still used when it is the only mesh live',
    parentOf(p({ params: { namespace: 'demo' } }, tsbLive)) === 'tsb-controlplane');
  check('cold start does not build the TSB management plane',
    !cold.steps.some((s) => s.layer === 'tsb-mgmt'), JSON.stringify(cold.steps.map((s) => s.layer)));

  // The three meshes must genuinely conflict, or "vanilla over TSB" would silently collide.
  const iv = catalog.get('istio-vanilla');
  for (const other of ['xcp-stack', 'tsb-controlplane']) {
    const o = catalog.get(other);
    check(`istio-vanilla conflicts with ${other}`,
      findConflicts(expandClaims(iv, defaultsFor(iv)), expandClaims(o, defaultsFor(o)))
        .some((c) => c.claim === 'cluster:*/ns:istio-system'));
  }
}

// ---------------------------------------------------------------- artifacts are never torn down
{
  const plan = buildPlan(catalog, { target: 'tsb-controlplane', params: {} }, world({
    ...baseUp,
    'tsb-mgmt': { ...HOST, identity: { managementCluster: 0, tag: 'ashish' } },
    'tctl-admin-config': { ...HOST, identity: {} },
  }));
  check('no artifact or credential layer is ever scheduled for teardown',
    !plan.steps.some((s) => s.action === ACTION.TEARDOWN && ['artifact', 'credential'].includes(catalog.get(s.layer)?.kind)));
}

// ---------------------------------------------------------------- /end-env
// Runs in a child process against a throwaway ENV_ROOT so the real instance store is untouched.
// META is pointed at the real catalog, which is why the two roots are separate overrides.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  fs.mkdirSync(path.join(tmp, 'instances'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

  const MINE = 'sess-mine';
  const OTHER = 'sess-other';
  const future = new Date(Date.now() + 3600_000).toISOString();
  const lease = (s) => [{ session: s, agent: 'claude', directory: null, acquiredAt: future, expiresAt: future }];
  const inst = (id, layer, leases) => ({
    schema: 1, id, layer, parent: null, declared: {}, declaredHash: 'x', observed: {},
    claims: { exclusive: [], shared: [], writes: [] },
    createdAt: future, lastProbedAt: future, lastProbeResult: 'healthy', leases,
  });

  const write = (o) =>
    fs.writeFileSync(path.join(tmp, 'instances', `${o.id}.json`), JSON.stringify(o));
  write(inst('kind-clusters-a', 'kind-clusters', lease(MINE)));
  write(inst('registry-local-b', 'registry-local', lease(OTHER)));
  write(inst('images-xcp-c', 'images-xcp', [])); // unleased, untouched by this session
  fs.writeFileSync(
    path.join(tmp, 'sessions', `${MINE}.json`),
    JSON.stringify({ session: MINE, target: 'xcp-stack', instances: [] })
  );

  const script = `
    const { endSession, listInstances, sessionBinding } = await import(${JSON.stringify(
      new URL('../server/lib/env/instances.js', import.meta.url).href
    )});
    const r = endSession(${JSON.stringify(MINE)});
    console.log(JSON.stringify({
      ...r,
      remaining: listInstances().map((i) => i.id).sort(),
      binding: sessionBinding(${JSON.stringify(MINE)}),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DEVBOARD_ENV_ROOT: tmp, DEVBOARD_ENV_META: [...catalog.values()][0].dir + '/..' },
    encoding: 'utf8',
  });
  const r = JSON.parse(out);

  check('end-env releases the session’s own lease', r.released.includes('kind-clusters-a'));
  // Destroys nothing: the environment is still running, so its record is still true. Records are
  // removed only when a teardown probe confirms the thing is actually gone.
  check('end-env deletes NO instance records',
    r.remaining.includes('kind-clusters-a') &&
      r.remaining.includes('registry-local-b') &&
      r.remaining.includes('images-xcp-c'),
    JSON.stringify(r.remaining));
  check('end-env does not touch another session’s lease',
    r.released.length === 1 && r.released[0] === 'kind-clusters-a', JSON.stringify(r.released));
  check('end-env unbinds the session', r.unbound === true && r.binding === null);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
