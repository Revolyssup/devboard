import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';

/**
 * Loads the recipe catalog from ~/.agents/environments/meta/<id>/recipe.yaml.
 *
 * DEFINITIONS vs INSTANCES — the split that keeps this engine domain-agnostic:
 *
 *   ~/.agents/environments/meta/   recipes: how to probe/build/destroy a kind of sub-environment
 *   ~/.agents/environments/        instances: what actually exists on this machine right now
 *
 * Both sit under ~/.agents, never under an agent-specific directory: recipes are shared knowledge
 * that Claude and Codex both read and write (see ~/.agents/AGENTS.md).
 *
 * The engine knows nothing about TSB, XCP, Kubernetes or Docker. Every domain fact lives in a
 * recipe. Swapping the meta directory for a different set of recipes gives you a different kind
 * of environment with no code change — the shipped TSB/XCP recipes are just the first set.
 *
 * YAML rather than JSON because claim declarations carry the *reason* a claim exists, and that
 * reasoning is the part that accumulates as things turn out to conflict.
 *
 * Contract: ~/.agents/specs/environments.md
 */

/** Where instances (materialised state) live. */
export const ENV_ROOT =
  process.env.DEVBOARD_ENV_ROOT || path.join(os.homedir(), '.agents', 'environments');
export const INSTANCES_DIR = path.join(ENV_ROOT, 'instances');

/** Where recipes (definitions) live. */
export const META_DIR = process.env.DEVBOARD_ENV_META || path.join(ENV_ROOT, 'meta');

/** Back-compat alias: the catalog directory. */
export const LAYERS_DIR = META_DIR;

/** Expand a leading ~ the way the probe scripts do, so paths compare equal across both sides. */
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function asList(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function loadCatalog(dir = META_DIR) {
  if (!fs.existsSync(dir)) throw new Error(`recipe catalog not found at ${dir}`);

  const layers = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'lib') continue; // shared shell helpers, not a recipe
    // `layer.yaml` is the pre-rename name, still accepted so an older meta dir keeps working.
    const file = ['recipe.yaml', 'layer.yaml']
      .map((n) => path.join(dir, entry.name, n))
      .find((p) => fs.existsSync(p));
    if (!file) continue;

    let def;
    try {
      def = parseYaml(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
    if (!def || !def.id) throw new Error(`${file}: missing 'id'`);
    if (def.id !== entry.name) {
      throw new Error(`${file}: id '${def.id}' does not match directory '${entry.name}'`);
    }

    layers.set(def.id, {
      ...def,
      dir: path.join(dir, entry.name),
      // `parent` may be a single id, null, or a list of alternatives.
      parents: asList(def.parent),
      requires: asList(def.requires),
      params: def.params || {},
      claims: {
        exclusive: asList(def.claims?.exclusive),
        shared: asList(def.claims?.shared),
        writes: asList(def.claims?.writes),
      },
      probeScript: path.join(dir, entry.name, 'probe.sh'),
    });
  }

  // Validate edges only after everything is loaded, so ordering in the directory does not matter.
  for (const layer of layers.values()) {
    for (const p of layer.parents) {
      if (!layers.has(p)) throw new Error(`layer '${layer.id}': unknown parent '${p}'`);
    }
    for (const r of layer.requires) {
      if (!layers.has(r)) throw new Error(`layer '${layer.id}': unknown requirement '${r}'`);
    }
  }
  detectCycles(layers);
  return layers;
}

function detectCycles(layers) {
  const state = new Map(); // id -> 1 visiting, 2 done
  const walk = (id, trail) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      throw new Error(`cycle in layer graph: ${[...trail, id].join(' -> ')}`);
    }
    state.set(id, 1);
    const l = layers.get(id);
    for (const next of [...l.parents, ...l.requires]) walk(next, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of layers.keys()) walk(id, []);
}

/**
 * Resolve which parent a layer sits on when it declares alternatives.
 *
 * Order per the spec: the one on the path to the requested target, else the one already live,
 * else the first listed. `echo-workloads` runs on either the standalone XCP stack or the TSB
 * control planes, and picking wrong would plan a teardown of the stack the user actually wants.
 */
export function chooseParent(layer, { onPath = new Set(), live = new Set(), via = null } = {}) {
  if (layer.parents.length === 0) return null;
  if (via && layer.parents.includes(via)) return via;
  const onPathPick = layer.parents.find((p) => onPath.has(p));
  if (onPathPick) return onPathPick;
  const livePick = layer.parents.find((p) => live.has(p));
  if (livePick) return livePick;
  return layer.parents[0];
}

/**
 * Everything needed to build `target`, in dependency order (parents and requirements before
 * dependants). Returns entries carrying the chosen parent so later stages do not re-decide it.
 */
export function expand(catalog, target, { via = null, live = new Set() } = {}) {
  const layer = catalog.get(target);
  if (!layer) throw new Error(`unknown layer '${target}'`);

  // First pass: collect the containment spine to the root, so alternative-parent choices below
  // can prefer whatever is already on the path to the target.
  const onPath = new Set([target]);
  const spine = (id) => {
    const l = catalog.get(id);
    const p = chooseParent(l, { onPath, live, via });
    if (p) {
      onPath.add(p);
      spine(p);
    }
  };
  spine(target);

  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const l = catalog.get(id);
    const parent = chooseParent(l, { onPath, live, via });
    if (parent) visit(parent);
    for (const r of l.requires) visit(r);
    order.push({ layer: l, parent });
  };
  visit(target);
  return order;
}

/** Index instances by the parent they point at. Children are derived, never stored. */
export function childrenOf(instances) {
  const byParent = new Map();
  for (const inst of instances) {
    if (!inst.parent) continue;
    if (!byParent.has(inst.parent)) byParent.set(inst.parent, []);
    byParent.get(inst.parent).push(inst);
  }
  return byParent;
}
