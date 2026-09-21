import { expand, chooseParent } from './catalog.js';
import { runProbe, defaultsFor, PROBE_STATE } from './probe.js';
import { expandClaims, findConflicts } from './claims.js';

/**
 * The resolver: desired spec + probe results -> an ordered plan.
 *
 * Deterministic by construction: the same spec and the same probe output always produce the same
 * plan. Nothing here consults an LLM, and nothing executes — planning and execution are separate
 * so a destructive step can always be shown before it happens.
 *
 * Contract: ~/.agents/specs/environments.md
 */

export const ACTION = {
  REUSE: 'REUSE',
  REPAIR: 'REPAIR',
  REBUILD: 'REBUILD',
  CREATE: 'CREATE',
  TEARDOWN: 'TEARDOWN',
  MANUAL: 'MANUAL',
  BLOCKED: 'BLOCKED',
};

/** Does an observed value satisfy a declared one, under this parameter's match mode? */
export function satisfies(declared, observed, mode = 'exact') {
  // A declared null means "whatever exists" and never forces a rebuild on its own.
  if (declared === null || declared === undefined) return true;
  if (mode === 'any') return true;
  if (observed === null || observed === undefined) return false;

  switch (mode) {
    case 'gte':
      return Number(observed) >= Number(declared);
    case 'semverGte':
      return cmpSemver(String(observed), String(declared)) >= 0;
    // Component-wise prefix: say as much precision as you actually care about.
    //   declared 1.14      vs observed 1.14.13  -> satisfied
    //   declared 1.14.12   vs observed 1.14.13  -> NOT satisfied
    //   declared 1.14.1    vs observed 1.14.13  -> NOT satisfied
    // String `prefix` gets that last case wrong ("1.14.1" is a string prefix of "1.14.13"), which
    // would silently accept the wrong patch release.
    case 'semverPrefix': {
      const d = String(declared).replace(/^v/, '').split('.');
      const o = String(observed).replace(/^v/, '').split('.');
      return d.every((part, i) => o[i] === part);
    }
    case 'prefix':
      return String(observed).startsWith(String(declared));
    case 'exact':
    default:
      return String(observed) === String(declared);
  }
}

/**
 * Do two version-ish values differ only in the components beyond what they share?
 *
 * Used to flag a near miss — "you asked for 1.14.12, this machine has 1.14.13" — so /start-env can
 * put the judgement in front of the user rather than silently spending 20 minutes rebuilding, or
 * silently accepting a version they did not ask for. The resolver's own answer stays deterministic
 * (mismatch means rebuild); this only decides whether the user gets asked first.
 */
export function isNearMiss(declared, observed) {
  if (declared == null || observed == null) return false;
  const d = String(declared).replace(/^v/, '').split('.');
  const o = String(observed).replace(/^v/, '').split('.');
  if (!/^\d+$/.test(d[0]) || !/^\d+$/.test(o[0])) return false;
  // Same major.minor, differing further down.
  return d[0] === o[0] && d[1] === o[1] && String(declared) !== String(observed);
}

function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Which declared params the observation fails to satisfy. */
export function identityMismatches(layer, declared, observed) {
  const out = [];
  for (const [name, spec] of Object.entries(layer.params || {})) {
    if (!(name in declared)) continue;
    const mode = spec?.match || 'exact';
    if (!satisfies(declared[name], observed?.[name], mode)) {
      out.push({
        param: name,
        declared: declared[name],
        observed: observed?.[name] ?? null,
        mode,
        // A near miss is a judgement call, not a fact. Flagged so /start-env stops and asks
        // instead of deciding for the user.
        nearMiss: isNearMiss(declared[name], observed?.[name]),
      });
    }
  }
  return out;
}

/**
 * Probe layers. Probes are truth, so this replaces trusting instance files.
 *
 * `only` restricts the sweep to a set of layer ids. Environments are bound to a session and a
 * session cares about one chain, so probing the whole catalog to display one environment is both
 * slow and pointless — a chain is typically 6 layers, not 14. Conflict detection still needs the
 * full sweep, so `only` is opt-in rather than the default.
 */
export async function probeAll(catalog, paramsByLayer = {}, { only = null } = {}) {
  const wanted = only ? [...catalog.values()].filter((l) => only.has(l.id)) : [...catalog.values()];
  const results = new Map();
  await Promise.all(
    wanted.map(async (layer) => {
      const params = { ...defaultsFor(layer), ...(paramsByLayer[layer.id] || {}) };
      results.set(layer.id, { layer, params, probe: await runProbe(layer, { params }) });
    })
  );
  return results;
}

/** The layer ids that make up `target`'s environment: its containment spine plus requirements. */
export function chainFor(catalog, target, { via = null } = {}) {
  return new Set(expand(catalog, target, { via }).map((e) => e.layer.id));
}

/**
 * Spread a desired spec's params across the chain.
 *
 * A spec param applies to EVERY recipe in the chain that declares a param of that name, not just
 * the target. Versions and cluster counts are inherently cross-cutting: `xcpVersion: 1.14` has to
 * reach both `images-xcp` (so the images get rebuilt from 1.14) and `xcp-stack` (so the running
 * stack is not left on old pods). Applying it to the target alone produced a plan that rebuilt the
 * stack and redeployed the SAME 1.12 images — a fix that fixed nothing.
 *
 * The same rule makes `clusters: 4` reach kind-clusters, xcp-stack and echo-workloads together,
 * which is what anyone asking for four clusters means.
 */
export function paramsFor(catalog, target, specParams = {}, { via = null } = {}) {
  const out = {};
  for (const { layer } of expand(catalog, target, { via })) {
    const applicable = {};
    for (const [k, v] of Object.entries(specParams)) {
      if (k in (layer.params || {})) applicable[k] = v;
    }
    out[layer.id] = { ...defaultsFor(layer), ...applicable };
  }
  return out;
}

/**
 * Build a plan that tears `target` down, together with everything live that sits on top of it.
 *
 * Needed as a first-class operation, not just as a conflict side-effect: `/cleanup-env` and
 * "destroy this and start over" are direct requests. Ordering is strictly deepest-first — tearing
 * out kind-clusters while an XCP stack is still on it leaves orphaned instance records and, worse,
 * namespaces that were never cleaned from clusters that no longer exist.
 */
export function buildTeardownPlan(catalog, target, probes, { includeDescendants = true } = {}) {
  const layer = catalog.get(target);
  if (!layer) throw new Error(`unknown layer '${target}'`);

  const live = new Set(
    [...probes.entries()].filter(([, r]) => r.probe.present === true).map(([id]) => id)
  );

  // Depth via the containment chain, so descendants can be ordered without a second traversal.
  const depthOf = (id, guard = new Set()) => {
    if (guard.has(id)) return 0;
    guard.add(id);
    const p = chooseParent(catalog.get(id), { live });
    return p ? depthOf(p, guard) + 1 : 0;
  };

  const isDescendantOf = (id, ancestor) => {
    let cur = chooseParent(catalog.get(id), { live });
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      if (cur === ancestor) return true;
      guard.add(cur);
      cur = chooseParent(catalog.get(cur), { live });
    }
    return false;
  };

  const victims = [...catalog.values()].filter((l) => {
    if (l.id !== target && !(includeDescendants && isDescendantOf(l.id, target))) return false;
    if (!live.has(l.id)) return false;
    // Artifacts and credentials are never destroyed — a stale image costs disk, a deleted one
    // costs a rebuild.
    return (l.teardown || 'allowed') !== 'never';
  });

  const steps = victims
    .sort((a, b) => depthOf(b.id) - depthOf(a.id)) // deepest first
    .map((l) => {
      const r = probes.get(l.id);
      const manual = (l.teardown || 'allowed') === 'manual';
      return {
        layer: l.id,
        title: l.title || l.id,
        kind: l.kind,
        action: manual ? ACTION.MANUAL : ACTION.TEARDOWN,
        reason:
          l.id === target
            ? 'requested'
            : `sits on ${target}, which is being torn down`,
        parent: chooseParent(l, { live }),
        declared: { ...defaultsFor(l), ...(r?.params || {}) },
        observed: r?.probe.identity || {},
        details: r?.probe.details || [],
        errors: [],
        mismatches: [],
        cost: l.cost || null,
        estimateSec: 60,
      };
    });

  // Only an unknown TARGET blocks. An unknown descendant is a warning, not a veto:
  //   - we cannot tear down what we cannot see, and
  //   - it dies with its parent regardless.
  // Blocking on it would make teardown impossible exactly when a dependency is unreachable —
  // e.g. tsb-config probes `unknown` whenever TSB is down, which is precisely when you want to
  // destroy the cluster underneath it.
  const targetUnknown = probes.get(target)?.probe.state === PROBE_STATE.UNKNOWN;
  const unknownDescendants = [...catalog.values()]
    .filter((l) => l.id !== target && isDescendantOf(l.id, target))
    .filter((l) => probes.get(l.id)?.probe.state === PROBE_STATE.UNKNOWN)
    .map((l) => l.id);

  return {
    target,
    teardown: true,
    steps,
    warnings: unknownDescendants.length
      ? [
          `state unknown for ${unknownDescendants.join(', ')} — cannot confirm whether anything is running there; it will be destroyed along with ${target}`,
        ]
      : [],
    summary: {
      reuse: 0,
      create: 0,
      rebuild: 0,
      repair: 0,
      teardown: steps.filter((s) => s.action === ACTION.TEARDOWN).length,
      manual: steps.filter((s) => s.action === ACTION.MANUAL).length,
      blocked: targetUnknown ? 1 : 0,
      destructive: steps.filter((s) => s.action === ACTION.TEARDOWN).length,
      estimateSec: steps.reduce((a, s) => a + (s.estimateSec || 0), 0),
      estimateIsLowerBound: false,
    },
    decisions: { nearMisses: [], alternatives: [], unobservable: [], assumed: [], needsUserDecision: false },
    requiresConfirmation: steps.some((s) => s.action === ACTION.TEARDOWN),
    // A teardown we cannot verify afterwards must not run.
    executable: !targetUnknown,
  };
}

/**
 * Build a plan for `target`.
 *
 * @param catalog  Map<id, layer>
 * @param spec     { target, params: {..}, via?: layerId }
 * @param probes   Map<id, {layer, params, probe}> from probeAll
 */
export function buildPlan(catalog, spec, probes) {
  const { target, params: specParams = {}, via = null } = spec;

  const live = new Set(
    [...probes.entries()].filter(([, r]) => r.probe.present === true).map(([id]) => id)
  );
  const chain = expand(catalog, target, { via, live });
  const inPlan = new Set(chain.map((e) => e.layer.id));
  // Cross-cutting params (versions, cluster counts) reach every recipe that declares them.
  const spread = paramsFor(catalog, target, specParams, { via });

  const steps = [];
  const decided = new Map(); // layerId -> ACTION

  for (const { layer, parent } of chain) {
    const r = probes.get(layer.id);
    const declared = spread[layer.id] || defaultsFor(layer);
    const probe = r.probe;

    // Cascade: a layer whose containment parent is being created or rebuilt cannot be reused,
    // whatever its own probe says. A healthy XCP stack sitting on clusters that are about to be
    // recreated is not reusable.
    const parentAction = parent ? decided.get(parent) : null;
    const parentGone = parentAction === ACTION.CREATE || parentAction === ACTION.REBUILD;

    let action;
    let reason;
    const mismatches = identityMismatches(layer, declared, probe.identity);

    if (probe.state === PROBE_STATE.UNKNOWN) {
      // Never promote unknown to absent — that is how a broken probe destroys a live cluster.
      action = ACTION.BLOCKED;
      reason = `probe could not determine state: ${probe.errors[0] || 'unknown'}`;
    } else if (parentGone) {
      action = probe.present ? ACTION.REBUILD : ACTION.CREATE;
      reason =
        probe.present
          ? `parent ${parent} is being ${parentAction.toLowerCase()}d — cannot reuse`
          : `parent ${parent} is being ${parentAction.toLowerCase()}d`;
    } else if (probe.state === PROBE_STATE.ABSENT) {
      action = ACTION.CREATE;
      reason = probe.errors[0] || 'absent';
    } else if (mismatches.length > 0) {
      action = ACTION.REBUILD;
      reason = mismatches
        .map((m) => `${m.param}: want ${m.mode} ${m.declared}, observed ${m.observed}`)
        .join('; ');
    } else if (probe.state === PROBE_STATE.DEGRADED) {
      action = layer.repair ? ACTION.REPAIR : ACTION.REBUILD;
      reason = probe.errors[0] || 'present but not healthy';
    } else {
      action = ACTION.REUSE;
      reason = probe.details[0] || 'observed satisfies declared';
    }

    // A layer that cannot be created automatically halts rather than guessing.
    if ((action === ACTION.CREATE || action === ACTION.REBUILD) && layer.teardown === 'manual') {
      action = ACTION.MANUAL;
    }
    // An interactive recipe normally cannot be executed headlessly. But "interactive" is often
    // conditional — a credential layer needs a human only when it has nothing to resume from — so
    // a recipe may name a probe-reported flag that lifts the requirement:
    //
    //   setup: { interactive: true, interactiveUnless: resumable }
    //
    // Generic on purpose: the engine never learns that this happens to be about MFA.
    if (action !== ACTION.REUSE && layer.setup?.interactive) {
      const unlessKey = layer.setup.interactiveUnless;
      const canRunHeadless = unlessKey ? probe.identity?.[unlessKey] === true : false;
      if (!canRunHeadless) action = ACTION.MANUAL;
    }

    decided.set(layer.id, action);
    steps.push({
      layer: layer.id,
      title: layer.title || layer.id,
      kind: layer.kind,
      action,
      reason,
      parent,
      declared,
      observed: probe.identity,
      details: probe.details,
      errors: probe.errors,
      mismatches,
      cost: layer.cost || null,
      // Real wall-clock estimate, never setupTimeoutSec — a timeout is the point at which the
      // step is killed, so summing timeouts reports a number the run will essentially never hit.
      estimateSec:
        action === ACTION.REUSE ? 0 : typeof layer.estimateSec === 'number' ? layer.estimateSec : null,
    });
  }

  // Requirements are materialised ONLY for layers being created/repaired/rebuilt. A layer
  // classified REUSE does not drag its requirements into the plan.
  //
  // This is what stops a valid-but-orphaned ecr-auth from demanding a pointless MFA prompt for
  // aws-session: ecr-auth is reused, so aws-session — absent, interactive, MFA-gated — is never
  // pulled in. Verified on 2026-09-07 against a machine in exactly that state.
  const byId = new Map(steps.map((s) => [s.layer, s]));

  // The containment spine to the target is always shown: it is the environment being described.
  const keep = new Set();
  let cursor = target;
  while (cursor) {
    keep.add(cursor);
    cursor = byId.get(cursor)?.parent || null;
  }

  // Then pull in requirements, but only through layers that actually need work.
  const requiredBy = new Map();
  const queue = [...keep].filter((id) => byId.get(id)?.action !== ACTION.REUSE);
  const walked = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (walked.has(id)) continue;
    walked.add(id);
    for (const req of catalog.get(id).requires) {
      if (!requiredBy.has(req)) requiredBy.set(req, []);
      requiredBy.get(req).push(id);
      if (!keep.has(req)) {
        keep.add(req);
        // A requirement that is itself unsatisfied needs work, so its own requirements matter.
        if (byId.get(req)?.action !== ACTION.REUSE) queue.push(req);
      }
    }
  }

  const pruned = steps.filter((s) => keep.has(s.layer));
  for (const step of pruned) {
    const dependants = requiredBy.get(step.layer);
    if (dependants?.length) step.requiredBy = [...new Set(dependants)];
  }

  // Conflicts: claims of layers we intend to create, against layers observed live but not part
  // of this plan. Each becomes a teardown annotated with the claim that forced it.
  const teardowns = [];
  for (const step of pruned) {
    if (step.action !== ACTION.CREATE && step.action !== ACTION.REBUILD) continue;
    const layer = catalog.get(step.layer);
    const mine = expandClaims(layer, step.declared);

    for (const [otherId, r] of probes.entries()) {
      if (otherId === step.layer || inPlan.has(otherId)) continue;
      if (r.probe.present !== true) continue;
      const theirs = expandClaims(r.layer, r.params);
      const conflicts = findConflicts(mine, theirs);
      if (!conflicts.length) continue;
      if (r.layer.teardown === 'never') continue; // artifacts and credentials are never destroyed

      const existing = teardowns.find((t) => t.layer === otherId);
      const entry = existing || {
        layer: otherId,
        title: r.layer.title || otherId,
        action: r.layer.teardown === 'manual' ? ACTION.MANUAL : ACTION.TEARDOWN,
        conflicts: [],
        forcedBy: [],
        details: r.probe.details,
      };
      entry.conflicts.push(...conflicts.map((c) => c.claim));
      entry.forcedBy.push(step.layer);
      if (!existing) teardowns.push(entry);
    }
  }
  for (const t of teardowns) {
    t.conflicts = [...new Set(t.conflicts)];
    t.forcedBy = [...new Set(t.forcedBy)];
    t.reason = `claims ${t.conflicts.join(', ')} — also claimed by ${t.forcedBy.join(', ')}`;
  }

  const destructive = teardowns.length + pruned.filter((s) => s.action === ACTION.REBUILD).length;
  const blocked = pruned.filter((s) => s.action === ACTION.BLOCKED);
  const manual = pruned.filter((s) => s.action === ACTION.MANUAL);

  // --- decisions the user should make, not the resolver -----------------------------------------
  //
  // The resolver's answer is always deterministic, and it is not always the ONLY reasonable one.
  // Wherever the resolver had to break a tie, guess, or fall back on a default, it records the
  // choice here instead of quietly making it. A non-empty `decisions` obliges /start-env to stop
  // and ask before executing anything.
  //
  // This is generic on purpose — nothing below knows about XCP, Istio or versions. Any recipe
  // with a near-miss param, alternative parents, an unobservable declaration, or an assumed
  // default surfaces the same way.

  // 1. Near miss: "you asked for 1.14.12, the machine has 1.14.13". Rebuilding is correct, and is
  //    also possibly 20 wasted minutes over a patch bump the user would have accepted.
  const nearMisses = pruned.flatMap((s) =>
    (s.mismatches || [])
      .filter((m) => m.nearMiss)
      .map((m) => ({ layer: s.layer, action: s.action, ...m }))
  );

  // 2. Alternative parents. Picking one is a preference, not a fact.
  const alternatives = pruned
    .map((s) => {
      const l = catalog.get(s.layer);
      if (!l || l.parents.length < 2) return null;
      const others = l.parents.filter((p) => p !== s.parent);
      if (!others.length) return null;
      return {
        layer: s.layer,
        chosen: s.parent,
        alsoLive: others.filter((p) => live.has(p)),
        available: others,
      };
    })
    .filter(Boolean);

  // 3. Unobservable: the user declared something the probe could not see, so the plan rebuilds out
  //    of ignorance rather than evidence. Safe, but the user may know it is already correct.
  const unobservable = pruned.flatMap((s) =>
    (s.mismatches || [])
      .filter((m) => m.observed === null || m.observed === undefined)
      .map((m) => ({ layer: s.layer, action: s.action, param: m.param, declared: m.declared }))
  );

  // 4. Assumed defaults on things being built. The user said nothing, so the recipe's default was
  //    used — `ambient: false`, `clusters: 2`, a profile. Each is a silent decision about what
  //    kind of environment gets built.
  //
  //    Only params the recipe marks `material: true` are surfaced. Listing every default drowns
  //    the real question in plumbing (`hub`, `tag`, a binary path) and trains the user to skip the
  //    prompt — which costs more than not prompting at all. Recipe authors decide what is worth
  //    a human's attention; the default is silence.
  //
  //    Params defaulting to null are skipped regardless: null means "whatever exists", which is a
  //    deferral rather than a choice.
  const assumed = pruned
    .filter((s) => s.action === ACTION.CREATE || s.action === ACTION.REBUILD || s.action === ACTION.REPAIR)
    .flatMap((s) => {
      const l = catalog.get(s.layer);
      return Object.entries(l?.params || {})
        .filter(
          ([name, spec]) =>
            spec?.material === true &&
            !(name in specParams) &&
            spec?.default !== null &&
            spec?.default !== undefined
        )
        .map(([name, spec]) => ({ layer: s.layer, param: name, assumed: spec.default }));
    });

  return {
    target,
    via,
    // Teardowns run first, bottom-up, before anything is built on top.
    steps: [...teardowns, ...pruned],
    // Judgement calls for the user. `needsUserDecision` means /start-env must ask before executing.
    decisions: {
      nearMisses,
      alternatives,
      unobservable,
      assumed,
      needsUserDecision:
        nearMisses.length > 0 || alternatives.length > 0 || unobservable.length > 0 || assumed.length > 0,
    },
    summary: {
      reuse: pruned.filter((s) => s.action === ACTION.REUSE).length,
      create: pruned.filter((s) => s.action === ACTION.CREATE).length,
      rebuild: pruned.filter((s) => s.action === ACTION.REBUILD).length,
      repair: pruned.filter((s) => s.action === ACTION.REPAIR).length,
      teardown: teardowns.length,
      manual: manual.length,
      blocked: blocked.length,
      destructive,
      estimateSec: pruned.reduce((a, s) => a + (s.estimateSec || 0), 0),
      // True when some step has no recorded estimate, so the total is a lower bound and the CLI
      // must say so rather than presenting a confident number.
      estimateIsLowerBound: pruned.some((s) => s.action !== ACTION.REUSE && s.estimateSec === null),
    },
    // Any destructive step means the plan must be confirmed before it runs. Never defaulted away.
    requiresConfirmation: destructive > 0,
    executable: blocked.length === 0,
  };
}
