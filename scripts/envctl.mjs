#!/usr/bin/env node
/**
 * envctl — probe and plan environments. DRY RUN ONLY: this never executes or destroys anything.
 *
 *   envctl probe [layer]         probe one layer, or the whole catalog
 *   envctl plan <target> [k=v..] show the plan to reach <target>
 *   envctl layers                print the layer graph
 *
 * Options: --json, --via <layer>
 *
 * Contract: ~/.agents/specs/environments.md
 */
import { loadCatalog, META_DIR } from '../server/lib/env/catalog.js';
import { runProbe, defaultsFor } from '../server/lib/env/probe.js';
import { probeAll, buildPlan, buildTeardownPlan, paramsFor, ACTION } from '../server/lib/env/plan.js';

const C = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      magenta: (s) => `\x1b[35m${s}\x1b[0m`,
    }
  : new Proxy({}, { get: () => (s) => s });

const ACTION_COLOR = {
  [ACTION.REUSE]: C.green,
  [ACTION.CREATE]: C.cyan,
  [ACTION.REBUILD]: C.yellow,
  [ACTION.REPAIR]: C.yellow,
  [ACTION.TEARDOWN]: C.red,
  [ACTION.MANUAL]: C.magenta,
  [ACTION.BLOCKED]: C.red,
};

const argv = process.argv.slice(2);
const flags = { json: false, via: null };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') flags.json = true;
  else if (argv[i] === '--via') flags.via = argv[++i];
  else rest.push(argv[i]);
}
const [cmd, ...args] = rest;

function fmtDuration(sec) {
  if (!sec) return '0m';
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `~${m}m` : `~${(m / 60).toFixed(1)}h`;
}

function stateLabel(p) {
  if (p.present === null) return C.red('UNKNOWN');
  if (!p.present) return C.dim('absent');
  return p.healthy ? C.green('healthy') : C.yellow('degraded');
}

async function cmdProbe() {
  const catalog = loadCatalog();
  const only = args[0];
  const targets = only ? [catalog.get(only)] : [...catalog.values()];
  if (only && !targets[0]) {
    console.error(`unknown layer '${only}' (see: envctl layers)`);
    process.exit(1);
  }

  const results = [];
  await Promise.all(
    targets.map(async (layer) => {
      const probe = await runProbe(layer, { params: defaultsFor(layer) });
      results.push({ layer, probe });
    })
  );
  results.sort((a, b) => a.layer.id.localeCompare(b.layer.id));

  if (flags.json) {
    console.log(
      JSON.stringify(
        results.map((r) => ({ layer: r.layer.id, ...r.probe })),
        null,
        2
      )
    );
    return;
  }

  for (const { layer, probe } of results) {
    console.log(`${C.bold(layer.id.padEnd(20))} ${stateLabel(probe)}`);
    for (const d of probe.details) console.log(`  ${C.dim('·')} ${d}`);
    for (const e of probe.errors) console.log(`  ${C.red('!')} ${e}`);
  }
}

async function cmdPlan() {
  const target = args[0];
  if (!target) {
    console.error('usage: envctl plan <target> [param=value ...]');
    process.exit(1);
  }
  const catalog = loadCatalog();
  if (!catalog.has(target)) {
    console.error(`unknown layer '${target}' (see: envctl layers)`);
    process.exit(1);
  }

  const params = {};
  for (const kv of args.slice(1)) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i);
    const raw = kv.slice(i + 1);
    params[k] = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
  }

  const probes = await probeAll(catalog, paramsFor(catalog, target, params, { via: flags.via }));
  const plan = buildPlan(catalog, { target, params, via: flags.via }, probes);

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`\n${C.bold(`plan: ${target}`)}${Object.keys(params).length ? C.dim(` ${JSON.stringify(params)}`) : ''}\n`);
  for (const s of plan.steps) {
    const color = ACTION_COLOR[s.action] || ((x) => x);
    console.log(`${color(s.action.padEnd(9))} ${C.bold(s.layer.padEnd(20))} ${s.reason || ''}`);
    if (s.requiredBy?.length) {
      console.log(`${' '.repeat(30)}${C.dim(`required by ${s.requiredBy.join(', ')}`)}`);
    }
  }

  const su = plan.summary;
  console.log('');
  console.log(
    [
      `${C.green(`${su.reuse} reuse`)}`,
      `${C.cyan(`${su.create} create`)}`,
      su.rebuild ? C.yellow(`${su.rebuild} rebuild`) : null,
      su.repair ? C.yellow(`${su.repair} repair`) : null,
      su.teardown ? C.red(`${su.teardown} teardown`) : null,
      su.manual ? C.magenta(`${su.manual} manual`) : null,
      su.blocked ? C.red(`${su.blocked} blocked`) : null,
    ]
      .filter(Boolean)
      .join('  ') +
      `   ${C.dim(`${su.estimateIsLowerBound ? 'at least' : 'estimated'} ${fmtDuration(su.estimateSec)}`)}`
  );

  // Judgement calls belong to the user, so print them prominently rather than burying them in
  // --json. A plan that destroys nothing can still be the wrong environment.
  const d = plan.decisions;
  if (d?.needsUserDecision) {
    console.log(C.yellow('\nDECISIONS FOR YOU — the resolver picked, but you may not agree:'));
    for (const n of d.nearMisses) {
      console.log(
        `  ${C.yellow('near miss')}  ${n.layer}.${n.param}: asked ${C.bold(n.declared)}, machine has ${C.bold(
          n.observed
        )} → plan ${n.action}s`
      );
    }
    for (const a of d.alternatives) {
      const live = a.alsoLive.length ? `also live: ${a.alsoLive.join(', ')}` : `other options: ${a.available.join(', ')}`;
      console.log(`  ${C.yellow('alternative')} ${a.layer} on ${C.bold(a.chosen)} (${live})`);
    }
    for (const u of d.unobservable) {
      console.log(
        `  ${C.yellow('unknowable')}  ${u.layer}.${u.param}: asked ${C.bold(u.declared)}, cannot observe → ${u.action}s out of ignorance`
      );
    }
    for (const a of d.assumed) {
      console.log(`  ${C.yellow('assumed')}    ${a.layer}.${a.param} = ${C.bold(a.assumed)} (you did not say)`);
    }
  }

  if (!plan.executable) {
    console.log(C.red('\nNOT EXECUTABLE — a probe could not determine state. Nothing will be planned on a guess.'));
  } else if (plan.requiresConfirmation) {
    console.log(C.red(`\n${su.destructive} destructive step(s) — confirmation required before execution.`));
  }
  console.log(C.dim('\ndry run: nothing was executed.\n'));
}

function cmdLayers() {
  const catalog = loadCatalog();
  if (flags.json) {
    console.log(
      JSON.stringify(
        [...catalog.values()].map((l) => ({
          id: l.id,
          kind: l.kind,
          parent: l.parents,
          requires: l.requires,
          claims: l.claims,
        })),
        null,
        2
      )
    );
    return;
  }
  console.log(`\n${C.bold('recipe catalog')} ${C.dim(META_DIR)}\n`);
  for (const l of [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const parent = l.parents.length ? l.parents.join(' | ') : C.dim('(root)');
    console.log(`${C.bold(l.id.padEnd(20))} ${C.dim(l.kind.padEnd(11))} parent: ${parent}`);
    if (l.requires.length) console.log(`${' '.repeat(20)} ${C.dim(`requires: ${l.requires.join(', ')}`)}`);
    for (const c of l.claims.exclusive) console.log(`${' '.repeat(20)} ${C.dim(`excl: ${c}`)}`);
  }
  console.log('');
}

async function cmdTeardown() {
  const target = args[0];
  if (!target) {
    console.error('usage: envctl teardown <target>');
    process.exit(1);
  }
  const catalog = loadCatalog();
  if (!catalog.has(target)) {
    console.error(`unknown layer '${target}' (see: envctl layers)`);
    process.exit(1);
  }
  const probes = await probeAll(catalog);
  const plan = buildTeardownPlan(catalog, target, probes);

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`\n${C.bold(`teardown: ${target}`)}\n`);
  if (!plan.steps.length) {
    console.log(C.dim(`${target} is not live; nothing to tear down\n`));
    return;
  }
  for (const s of plan.steps) {
    const color = ACTION_COLOR[s.action] || ((x) => x);
    console.log(`${color(s.action.padEnd(9))} ${C.bold(s.layer.padEnd(20))} ${s.reason}`);
    for (const d of s.details.slice(0, 2)) console.log(`${' '.repeat(30)}${C.dim(d)}`);
  }
  console.log(C.red(`\n${plan.summary.destructive} destructive step(s) — confirmation required.`));
  console.log(C.dim('\ndry run: nothing was executed.\n'));
}

const commands = { probe: cmdProbe, plan: cmdPlan, layers: cmdLayers, teardown: cmdTeardown };
const fn = commands[cmd];
if (!fn) {
  console.error('usage: envctl <probe|plan|layers> [args]   (--json, --via <layer>)');
  process.exit(1);
}
await fn();
