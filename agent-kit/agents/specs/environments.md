# Environment Composition — contract

What devboard's environment engine (`server/lib/env/`, `server/routes/env.js`,
`scripts/envctl.mjs`) does, and what a recipe must do to work with it. Where this file and the code
disagree, the code wins and this file is wrong. The agent procedure for `/start-env` and `/end-env`
is in `~/.agents/specs/env-agent.md`. An example catalog ships in devboard's
`agent-kit/agents/environments/meta/` and is used for the examples below.

## Problem

Reproducing an issue, or answering "what happens when X runs on an N-node cluster", depends on
*having an environment*. Standing one up by hand takes time, and deciding which steps you can skip
depends on remembering what was left on the machine last time. That memory is often wrong: either
you rebuild what already exists, or a stale piece quietly poisons the run.

The goal: spend your time on the issue, not on spinning environments up and tearing them down.

## Model

An **environment** is a path through a DAG of **recipes** (also called layers), from broad to
specific. The example catalog:

```
host-docker                     Docker daemon
└── registry-local              local registry container on 127.0.0.1:5000
    └── kind-clusters           devboard-0..N-1
        └── echo-workload       echo server in a namespace on devboard-0
            (namespace=a and namespace=b can both be live: disjoint exclusive claims)
```

A **recipe** is a definition in the catalog. An **instance** is a recipe materialised on this
machine, with its recorded identity and provenance. Instances point *up* to their parent.

### The central rule

> **Instance files are a cache of belief. Probes are truth.**
> Never act on an instance file without a fresh probe.

Live infrastructure drifts. A cluster gets deleted, a namespace gets wiped, the Docker daemon
restarts. A recorded instance is a hypothesis that must be checked again before it is reused.
Example of the trap: kubeconfig files that are present and readable while `kind get clusters`
returns nothing. A check that only tests "does the kubeconfig file exist?" declares dead clusters
healthy.

### Determinism, precisely

*Decisions* are deterministic: the same desired spec plus the same probe output always gives the
same plan. Nothing in planning consults an LLM. *Outcomes* are not deterministic: kind flakes,
image pulls fail. So every recipe must cope with having been left half-built, and its probe must be
able to say so.

## Identity: declared vs observed

Every instance carries two identities:

- **declared**: the parameters that were *asked for*. Their hash is part of the instance id.
- **observed**: what the probe actually found.

| probe says | planner action |
| --- | --- |
| absent | `CREATE` |
| healthy, observed satisfies declared | `REUSE` |
| present, observed does **not** satisfy declared | `REBUILD` (drift or version change) |
| present but not healthy, identity matches | `REPAIR` if the recipe has `repair: true`, else `REBUILD` |
| probe failed (`unknown`) | `BLOCKED`, and the whole plan is not executable |

Keeping both identities means "never built" and "built, then rotted" are different states, and
they need different actions. Observed identity also lets a recipe *adopt* something built by hand:
a cluster someone created manually can be probed, found to satisfy the spec, and reused.

"Satisfies" is per parameter, not plain equality. See `match` below.

## Probe contract

Every recipe ships `probe.sh`. It is **read-only**, has **no side effects**, and should finish in a
few seconds: it runs on every plan.

It prints exactly one JSON object to stdout:

```json
{
  "present": true,
  "healthy": true,
  "identity": { "clusters": 2, "k8sVersion": "1.31.0", "names": ["devboard-0", "devboard-1"] },
  "details": ["devboard-0: 1/1 nodes Ready, k8s 1.31.0", "devboard-1: 1/1 nodes Ready, k8s 1.31.0"],
  "errors": []
}
```

| field | meaning |
| --- | --- |
| `present` | the recipe's primary resources exist at all |
| `healthy` | present **and** working (rollouts complete, endpoints answering) |
| `identity` | observed values; keys are the recipe's param names (extra keys are fine) |
| `details` | human-readable evidence, shown in plans and in the devboard tree |
| `errors` | why it isn't healthy; the first one becomes the plan step's reason |

The engine computes the state from the two booleans: `present: false` is absent;
`present && healthy` is healthy; `present && !healthy` is degraded.

**Exit code.** `0` if the probe *ran*, whatever it found. Non-zero, a timeout
(`probeTimeoutSec`, default 30), or output that isn't JSON all mean the probe itself broke (missing
tool, daemon down, no permission). The engine reads that as **unknown**, which blocks the plan. A
probe that cannot tell must never guess "absent": absent is what green-lights a CREATE on top of
something alive, and what tells the executor a teardown succeeded.

**Inputs.** The probe gets its recipe's params as environment variables `ENV_PARAM_<NAME>`, where
`<NAME>` is the param name upper-cased with `-` turned into `_` (so `registryPort` becomes
`ENV_PARAM_REGISTRYPORT`). Path defaults starting with `~` are expanded first. `ENV_PARENT_JSON` is
set but, as of this writing, always empty: the planner probes every recipe independently and in
parallel, not top-down. So a probe must answer correctly on its own even when its parent is absent
(for example, "no cluster" means the namespace is absent, not unknown).

**Every declared param must be observable.** A param whose `match` is not `any` and that the probe
never reports in `identity` reads as a permanent mismatch, so the recipe is rebuilt on every plan.

## Claims and conflict

Recipes do **not** list the recipes they conflict with. A pairwise list is O(n²) and goes stale the
moment a recipe is added. Each recipe declares what it **claims**, and conflict is *derived*:

```yaml
claims:
  exclusive: ["host:port:${registryPort}", "host:container:${registryName}"]
  shared:    ["host:docker", "host:network:kind"]
  writes:    []
```

- `exclusive`: only one live owner. Conflicts with another `exclusive` or a `writes` on the same
  resource.
- `writes`: mutates but doesn't own. Two writers of the same resource conflict.
- `shared`: read/attach only. Never a source of conflict.

Claim strings are `<domain>:<path>`, free-form; the engine only compares them. `*` matches any run
of characters except `/`. Two claims overlap if either, read as a pattern, matches the other.
`${param}` interpolates the recipe's declared param; an unresolved param becomes `*` (the widest,
safest reading).

When the planner is about to CREATE or REBUILD a recipe, it compares that recipe's claims with every
recipe that probes **present** and is **not part of this plan**. Each overlap becomes a `TEARDOWN`
step for the live recipe (or `MANUAL` if its `teardown` is `manual`), annotated with the claim that
forced it. Recipes with `teardown: never` are never proposed.

**Why this shape.** When two things believed to be independent turn out to collide, the fix is
*one claim on one recipe*, and every pairwise relationship updates for free. Example:
`echo-workload` claims `cluster:devboard-0/ns:${namespace}`. With `namespace=a` and `namespace=b`
the exclusive sets are disjoint, so two sessions can each hold one. Two requests for the same
namespace collide.

## Recipe catalog

One directory per recipe under `~/.agents/environments/meta/<id>/`. The directory name must equal
the `id`. `layer.yaml` is accepted as an older name for `recipe.yaml`. `meta/lib/` holds shared
shell helpers and is not a recipe.

```
recipe.yaml     definition                                    (required)
probe.sh        read-only state check                         (required; missing = unknown)
setup.sh        create / repair / rebuild                     (needed for any non-REUSE step)
teardown.sh     destroy                                       (exactly when teardown: allowed)
resources.sh    optional: list/show the configs it manages
```

`recipe.yaml`:

```yaml
id: kind-clusters
title: Kind clusters            # display name
icon: "☸️"                       # optional; the dashboard row shows the ROOT recipe's icon
kind: runtime                   # free-form label shown in the UI and CLI (host | runtime | workload | artifact | ...)
parent: registry-local          # null for a root; a list means "any one of these"
requires: []                    # non-containment dependencies

params:
  clusters:
    type: int                   # documentation only; the engine does not enforce types
    default: 2
    match: gte                  # 3 live clusters satisfy a request for 2
    material: true              # if the user didn't state it, surface it as a decision
  k8sVersion:
    type: string
    default: null               # null = "whatever exists"; never forces a rebuild on its own
    match: semverGte

claims:
  exclusive: ["host:kind:devboard-*"]
  shared: ["host:docker", "host:network:kind"]
  writes: []

teardown: allowed               # allowed | never | manual
repair: false                   # true: a degraded-but-matching instance gets REPAIR (runs setup.sh)

probeTimeoutSec: 60             # default 30
setupTimeoutSec: 1200           # default 1800; the step is killed after this
estimateSec: 150                # realistic wall-clock for setup, used for plan estimates

setup:                          # only for recipes a human must complete (see below)
  interactive: false
  interactiveUnless: null
  manualHint: null
```

`match` values: `exact` (default), `gte` (numeric), `semverGte`, `semverPrefix` (component-wise:
`1.14` accepts any `1.14.x`, `1.14.12` accepts only `1.14.12`), `prefix` (plain string; wrong for
versions, because `1.14.1` is a string prefix of `1.14.13`), `any` (never causes a rebuild; use it
for passthrough params a script needs but that are not part of identity).

The engine ignores unknown keys, so you can add your own (for example `source:` pointing back at
the script a recipe was carved out of, or `cost:`). `cost` is copied into plan steps but **no
capacity check is implemented**.

### parent vs requires

`parent` is the **containment** edge: if the parent is created or rebuilt, this recipe is rebuilt
with it, whatever its own probe says. kind clusters are contained by the Docker host; a workload is
contained by its cluster. Cascades follow `parent` only.

`requires` is the **dependency** edge: it must exist and be healthy before setup runs, but
rebuilding it does *not* destroy the dependant. Example: a workload that `requires` a built image
set. Rebuilding the images doesn't tear down the running workload; it only matters on the next
deploy. Conflating the two produces false teardowns.

**Requirements are pulled in only for recipes that need work.** A recipe classified `REUSE` does
not drag its `requires` into the plan. This rule matters: without it, a perfectly usable layer could
demand an interactive login (or a 15-minute build) for a dependency of something the plan was never
going to touch.

### Alternative parents

`parent` may be a list: any one of them satisfies containment. The engine picks, in order: the one
given as `via` in the request, the one on the path to the requested target, the one already live,
the first listed. Picking among alternatives is recorded as a decision for the user.

### Params spread across the chain

A param in the request applies to **every** recipe in the chain that declares a param of that name,
not only to the target. `clusters=3` reaches every recipe declaring `clusters`, and
`registryPort=5001` reaches both `registry-local` and the passthrough copy in `kind-clusters`. Name
cross-cutting params identically on purpose; name unrelated params differently.

### Interactive and manual recipes

Some steps need a human: logging in with a one-time code, resizing a VM in a GUI, downloading a
file from a web console. The engine never fakes them.

- `teardown: manual`: a CREATE or REBUILD of this recipe becomes a `MANUAL` step, and a teardown
  plan shows it as `MANUAL` instead of running anything. No `teardown.sh`.
- `setup.interactive: true`: any non-REUSE step becomes `MANUAL`...
- ...unless `setup.interactiveUnless: <flag>` names an identity key that the probe reports as
  `true`, meaning "it can run headless right now" (for example, a saved session can be resumed
  without a new code). A missing flag never counts as permission.
- Every manual or interactive recipe must declare `setup.manualHint`: the exact thing the human
  should do. The executor shows it as `[manual step] <id>: <hint>`. The engine has no domain
  knowledge to fall back on.

**The executor does not stop at a MANUAL step.** It logs the hint, marks the step `manual`, and
carries on with the next one. If later steps depend on the manual one, they will fail (and stop the
run). So: do the manual step first, then plan again. A secret a human types (an MFA code) must never
pass through the agent or be written to a run log.

## Instances

`~/.agents/environments/instances/<recipe-id>-<hash8>.json`, where `hash8` is a hash of the
declared params:

```json
{
  "schema": 1,
  "id": "kind-clusters-3f9a2c11",
  "layer": "kind-clusters",
  "parent": "registry-local-0a11bc42",
  "declared": { "clusters": 2, "registryName": "kind-registry", "registryPort": 5000 },
  "declaredHash": "3f9a2c11",
  "observed": { "clusters": 2, "k8sVersion": "1.31.0", "names": ["devboard-0", "devboard-1"] },
  "claims": { "exclusive": ["host:kind:devboard-*"], "shared": ["host:docker", "host:network:kind"], "writes": [] },
  "createdAt": "...",
  "lastProbedAt": "...",
  "lastProbeResult": "healthy",
  "leases": [
    { "session": "<session id>", "agent": "codex", "directory": "/path/to/repo", "acquiredAt": "...", "expiresAt": "..." }
  ]
}
```

An instance is recorded only after a probe reports it **healthy**: after a successful setup step,
and for every `REUSE` step of a run. Records describe the environment; they are not deleted when a
session lets go. They are removed in exactly one place: after a teardown step whose probe confirms
the thing is absent.

**Parent pointer only**, no child list. Two-way pointers get out of sync the first time a teardown
is interrupted; children are derived by indexing on `parent`. (Known gap: the executor currently
records the parent pointer as the parent's id hashed with *empty* params, so it does not match the
parent's actual instance id.)

### Leases

A run started with a `session` takes a lease on every instance it records, for one hour
(`LEASE_TTL_MS`). There is no heartbeat endpoint yet, so in practice leases expire an hour after the
run.

- Expired leases are kept and shown as expired: "last held by session X, expired 3h ago" is
  different from "nobody ever used this", and it is what a teardown prompt needs to say.
- `blockingLeases` (live leases held by other sessions) exists in the engine but is **not enforced**
  by `/run` or `/teardown`. Checking who else holds an instance before destroying it is the
  agent's job (see env-agent.md).
- An instance with no live leases is not auto-collected. Nothing garbage-collects.

## Resolver

Input: a **desired spec**: a target recipe, params, and optionally `via` (forced alternative
parent).

```json
{ "target": "echo-workload", "params": { "clusters": 1, "namespace": "demo" } }
```

1. **Expand** the target into its chain: the containment spine up to the root, plus `requires`,
   ordered parents-first.
2. **Probe** every recipe in the catalog in parallel, each with its spread params. (Probing the
   whole catalog, not only the chain, is what conflict detection needs.)
3. **Classify** each chain step by the identity table above. `unknown` → `BLOCKED`.
4. **Cascade**: if a step's parent is `CREATE` or `REBUILD`, the step becomes `REBUILD` (if present)
   or `CREATE`, regardless of its own probe.
5. **Manual gates**: `teardown: manual` or `setup.interactive` turn a non-REUSE action into
   `MANUAL` (see above).
6. **Prune**: keep the containment spine; pull in `requires` only through steps that need work.
7. **Conflict scan**: claims of every CREATE/REBUILD step against every live recipe outside the
   plan; overlaps become `TEARDOWN` steps, placed first.
8. **Emit the plan**. Nothing has run.

The plan (`--json` or `POST /api/env/plan`):

```
{ target, via,
  steps: [ { layer, title, kind, action, reason, parent, declared, observed, details, errors,
             mismatches: [{param, declared, observed, mode, nearMiss}], requiredBy?, estimateSec } ],
  decisions: { nearMisses, alternatives, unobservable, assumed, needsUserDecision },
  summary: { reuse, create, rebuild, repair, teardown, manual, blocked, destructive,
             estimateSec, estimateIsLowerBound },
  requiresConfirmation,   // any TEARDOWN or REBUILD step
  executable }            // false if any step is BLOCKED
```

CLI rendering:

```
REUSE     host-docker          docker 29.0.1: 11 cpu, 30Gi
CREATE    registry-local       no container named kind-registry
CREATE    kind-clusters        parent registry-local is being created
CREATE    echo-workload        parent kind-clusters is being created

1 reuse  3 create   estimated ~3m
```

## Decisions belong to the user

The resolver is deterministic. Deterministic is not the same as *the only reasonable answer*.
Wherever it breaks a tie, guesses, or falls back on a default, it records that in
`plan.decisions`. `needsUserDecision: true` obliges `/start-env` to stop and ask **before running
anything**, including plans that destroy nothing.

| | |
| --- | --- |
| `nearMisses` | a version differing only below what was asked: 1.31.2 requested, 1.31.4 present (same major.minor) |
| `alternatives` | more than one parent could host a step; which was chosen and which others are live |
| `unobservable` | a declared param the probe reported nothing for, so the step rebuilds out of ignorance |
| `assumed` | `material: true` params the user never stated, on steps that will be built |

All four are generic; nothing in the mechanism knows about versions, Docker or Kubernetes.

**Known noise in `unobservable`:** the engine also lists params of recipes that are simply
*absent* (a CREATE step: there was nothing to observe). Those entries carry no information. Only
an `unobservable` entry on a REBUILD/REPAIR step of something that is present is a real question.

**Version precision is the user's choice.** Use `match: semverPrefix` for version params: declaring
`1.31` accepts any `1.31.x`, declaring `1.31.2` accepts only that. Probes should therefore report
the **full** version.

**Only `material: true` params are surfaced as assumptions.** Listing every default drowns the real
question in plumbing (a registry hostname, an image tag, a path) and trains the user to skip the
prompt. Recipe authors mark what deserves attention; the default is silence. A param defaulting to
`null` is never an assumption: null means "whatever exists".

## Teardown safety

- Any plan with a destructive step (`TEARDOWN` or `REBUILD`) has `requiresConfirmation: true`. The
  server refuses to run it without `confirmDestructive: true` (HTTP 412). An agent only sends that
  after the user has seen the plan and said yes. Never by default.
- `POST /api/env/teardown/plan {target}` previews tearing down `target` plus everything live
  contained in it, **deepest first**. `teardown: never` recipes are skipped; `teardown: manual`
  ones become `MANUAL`.
- Only an `unknown` *target* blocks a teardown. An `unknown` descendant is a warning: you cannot
  see it, and it dies with its parent anyway. Blocking on it would make teardown impossible exactly
  when something underneath is broken.
- **Known gap:** teardown plans probe and run with each recipe's **default** params, not the params
  the session was bound with. For an environment built with non-default params (say
  `namespace=demo`), the teardown targets the default instance (`namespace=echo`). Until fixed, tear
  such an environment down by hand or plan it with defaults only.

Rationale for always confirming: a wrong probe under auto-destroy costs a cluster someone was in the
middle of debugging. A wrong probe under confirm costs one glance.

## Execution ownership

devboard runs plans, not the agent:

1. a long setup must outlive the session that started it;
2. two sessions on one machine must serialise. There is **one run at a time, machine-wide**; a
   second `/run` gets HTTP 409;
3. log streaming and the tree view come free from devboard.

The executor re-derives the plan server-side from `{target, params, via}` (a plan posted minutes
later may be stale), then for each step:

- `REUSE`: records the instance and takes the session's lease.
- `MANUAL`: logs the hint and moves on (see above).
- `CREATE`, `REPAIR`, `REBUILD`: runs `setup.sh`. There is no separate teardown before a REBUILD,
  so **setup.sh must converge from any state**, including "present but wrong".
- `TEARDOWN`: runs `teardown.sh`.

Scripts run as `/bin/bash <script>` with the recipe's directory as cwd, `ENV_PARAM_*` set, and
`setupTimeoutSec` as a kill timer. A non-zero exit fails the step and stops the run. **After every
step the recipe is probed again**: setup must leave it `healthy`, teardown must leave it `absent`,
otherwise the step is `unverified` and the run stops. A script exiting 0 is a claim, not proof.
Runs are kept in `~/.agents/environments/runs/<run-id>/run.json`.

The agent's role is bounded to:

- **spec inference**: instruction → target + params. Real judgement: knowing which recipe is the
  *shallowest* one that answers the question, and which params the user actually stated.
- **putting decisions in front of the user**, and reading results back in terms of their question.
- **post-hoc fixes**: when two things turn out to collide, adding a claim to a recipe.

Probing, diffing, planning, ordering and executing are mechanical and stay out of the model. An LLM
deciding "is this cluster reusable?" brings back exactly the nondeterminism this system exists to
remove.

## Directory layout

Definitions and instances live apart; that separation keeps the engine general.

```
~/.agents/environments/
  meta/                                   RECIPES: definitions (yours to edit)
    lib/{probe-lib.sh,setup-lib.sh}       shared shell helpers
    <recipe-id>/recipe.yaml
    <recipe-id>/{probe.sh,setup.sh,teardown.sh,resources.sh}
  instances/<recipe>-<hash8>.json         INSTANCES: what exists right now (a cache of belief)
  runs/<run-id>/run.json                  plan + execution record
  sessions/<session-id>.json              session → environment binding
  .cache/probes.json                      probe results, for display only
```

Everything lives under `~/.agents`, not under an agent-specific directory: recipes are shared
knowledge that any agent reads and extends. `DEVBOARD_ENV_ROOT` moves the whole root;
`DEVBOARD_ENV_META` points the engine at a different recipe directory.

**The engine is domain-agnostic.** It knows nothing about Docker, kind or Kubernetes. Point
`DEVBOARD_ENV_META` at a different catalog and you get a different kind of environment with no code
change. Any domain wording (manual hints, resource listings) comes from the recipe, never from the
engine.

### resources.sh (optional)

```
resources.sh list        -> JSON array of {id, kind, name, namespace, cluster, state, file?}
resources.sh show <id>   -> YAML on stdout
```

`state` is one of `applied`, `modified`, `missing`, `live-only`, `unknown`. Read-only, run with the
session's params. The Environment overlay shows these under "configs".

## Environments are per-session

An environment belongs to one agent session (1:1 for now). `sessions/<id>.json` is the binding:

```json
{ "session": "<id>", "agent": "claude|codex", "directory": "...", "target": "echo-workload",
  "via": null, "params": { "namespace": "demo" }, "instructions": "the user's original words",
  "instances": ["host-docker", "registry-local", "kind-clusters", "echo-workload"],
  "boundAt": "...", "updatedAt": "..." }
```

`POST /api/env/run` with a `session` writes it (with params and via) unless `rebind: false`;
`POST /api/env/bind` writes it directly. Binding again replaces the previous binding. The session
id is the agent runtime's own session id: the same one devboard shows on the session's
learning/chore row, which is how the row finds its environment.

Consequences for the UI, all deliberate:

- **No global environment view.** An environment is reached from the row of the session that owns
  it (the Env button), or from that session's terminal toolbar.
- **Nothing probes on page load.** Whether a row gets an Env button is a plain file read
  (`GET /api/env/sessions`).
- **Opening probes one chain.** `GET /api/env/tree?session=<id>` returns the bound chain from the
  probe cache immediately (`pending` where there is no cached result, never `absent`); the client
  then calls `POST /api/env/probe/<recipe>` for pending or stale rows in parallel.
- **The cache is for display only.** Plans, runs and teardowns always probe fresh. Cached entries
  carry `probedAt` and are marked `stale` after 10 minutes; staleness is a label, never a silent
  substitute. Cache keys include params.

`POST /api/env/end {session}` releases the session's leases and removes the binding. It destroys
nothing: not the infrastructure, not the instance records.

## HTTP API (localhost:5178/api/env)

| method + path | body / query | does |
| --- | --- | --- |
| `GET /layers` | | catalog summary |
| `GET /layers/:id/defaults` | | a recipe's default params |
| `POST /plan` | `{target, params?, via?}` | probe + plan; runs nothing |
| `POST /run` | `{target, params?, via?, session?, agent?, directory?, confirmDestructive?, rebind?}` | start a run → `{runId, plan}` |
| `GET /runs/:id`, `GET /runs`, `GET /runs/current` | | run status (`running`, `succeeded`, `failed`, `aborted`) |
| `POST /runs/:id/abort` | | SIGTERM the running script |
| `POST /teardown/plan` | `{target}` | preview a teardown |
| `POST /teardown` | `{target, session?, agent?, directory?, confirmDestructive}` | run a teardown |
| `POST /bind` | `{session, target, instructions?, via?, params?, agent?, directory?}` | bind without running |
| `POST /end` | `{session}` | release leases, unbind → `{released, stillHeld, unbound, target}` |
| `GET /sessions` | | all bindings (file read, no probes) |
| `GET /tree` | `?session=&fresh=1` | the bound chain, from cache |
| `POST /probe/:layer` | `{session?}` | probe one recipe, refresh its cache entry |
| `POST /tree/refresh` | `{session?}` | drop cached probes |
| `GET /resources/:layer[/show]` | `?session=&id=` | `resources.sh` passthrough |
| `GET /instances` | | instance records |

CLI (dry-run only, never executes): `npm run env -- layers | probe [recipe] | plan <target> [k=v ...]
| teardown <target>`, with `--json` and `--via <recipe>`. `true`/`false` and plain integers in
`k=v` are parsed as booleans and numbers.

## Writing recipe scripts

Rules learned the expensive way. Most are the same failure: something that could not be determined
got reported as "not there".

**1. Existence and reachability are different questions.** Decide `present` from the authority on
existence (`kind get clusters`, `docker ps -a`), and `healthy` from whether the thing actually
works (API answers, rollout complete). A kind-clusters probe that derived both from `kubectl` would
report two running clusters as `absent` the moment their kubeconfigs were deleted, and since
`absent` is what tells the executor a teardown worked, a failed teardown would turn green.

**2. If you could not look, exit non-zero.** "Docker daemon not responding, so I can't see the
container" is `unknown`, not `absent`. "There is no such cluster, so there is no namespace in it" is
a genuine `absent`.

**3. macOS `/bin/bash` is 3.2. Write for it.** The executor spawns `/bin/bash`. `mapfile`,
`readarray`, `declare -A` and `${var^^}` don't exist there, and their absence is a *runtime*
"command not found" that does not abort the script. A `mapfile` in a teardown leaves the delete loop
iterating over an empty array; the script exits 0 with everything still running. Use the `collect`
helper in `lib/setup-lib.sh`. Watch `"${arr[@]}"` on empty arrays under `set -u` too: write
`"${arr[@]+"${arr[@]}"}"`.

**4. setup.sh is idempotent and converges.** CREATE, REPAIR and REBUILD all run it, the last with
something wrong already in place. Check, then act. Leave the data a rebuild would lose (an image
volume, for instance) unless deleting it is the point.

**5. teardown.sh deletes what it owns and nothing else,** cleans up the files that would mislead the
next probe (kubeconfigs of deleted clusters), and exits non-zero if anything it owns is still there.

**6. Report every non-`any` param in `identity`**, under the param's exact name, including when the
thing is present but degraded (a stopped registry still has a port binding). Otherwise a repairable
instance is classified as a mismatch and rebuilt.

**7. Bound every external call** in a probe (`timeout`), so a wedged API server can't stall a plan.

## For agents

- Never trust an instance file. Probe first, always.
- Never promote a probe's `unknown` to `absent`. Fix the probe, or the thing it can't see.
- Never widen a plan's destructive scope, and never send `confirmDestructive: true`, without an
  explicit yes from the user to that specific plan.
- When a run fails because two things collided, the fix is a **claim on a recipe**, not a special
  case in the engine or the skill.
- If no recipe fits a request, say so and offer to write one. Don't force the request into a
  recipe that means something else.
- New domain knowledge goes into recipes (`~/.agents/environments/meta/`), never into the engine.
