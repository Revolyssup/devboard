# Environments

An environment is the infrastructure you need to reproduce an issue or test a behaviour: a Docker
host, a local registry, some kind clusters, a control plane, a set of workloads and config. devboard
composes it from reusable pieces, checks what already exists on your machine, and builds only the
parts that are missing. Use it when standing up an environment by hand would cost more time than
the investigation itself, or when you can't remember what was left running from last time.

> **Requirements.** Everything ships with devboard. `scripts/install.sh` installs the `/start-env`
> and `/end-env` skills for Claude and Codex, the procedure every agent follows
> (`~/.agents/specs/env-agent.md`) and the contract (`~/.agents/specs/environments.md`). If you have
> no recipe catalog yet, it also seeds an **example catalog** in `~/.agents/environments/meta/`:
> Docker → a local registry → kind clusters → an echo workload. It's a starting point. Edit or
> replace it to describe your own environments; the installer never touches an existing catalog.
> Its source is [`agent-kit/agents/environments/meta/`](../agent-kit/agents/environments/meta/).

## The model

| Term | Meaning |
| --- | --- |
| **Recipe** (layer) | A definition of one kind of sub-environment, e.g. "kind clusters" or "local registry". It lives in its own directory with a `recipe.yaml` and shell scripts: `probe.sh` (required), `setup.sh`, `teardown.sh`, and optionally `resources.sh`. |
| **Layer graph** | Recipes form a DAG. `parent` is containment: if the parent is rebuilt, the child dies with it. `requires` is a dependency that must exist before setup, but rebuilding it does not destroy the dependant. A recipe can list several alternative parents. |
| **Instance** | A recipe that has been materialised on this machine, recorded as a JSON file with what was asked for (declared params), what was found (observed), and who is using it (leases). |
| **Probe** | `probe.sh` is read-only and prints one JSON object: `present`, `healthy`, `identity`, `details`, `errors`. |
| **Lease** | A session's claim on an instance. Leases tell a teardown who would be hurt. |
| **Session binding** | Links one agent session to one environment (1:1). This is what makes the Env button appear on that session's row. |

**Probes are truth.** Instance files are a record of belief, not proof. Nothing that makes a
decision (planning, running, tearing down) acts on an instance file without running the probes
again. A probe can report four states:

| State | Meaning | What the planner does |
| --- | --- | --- |
| `absent` | not there | `CREATE` |
| `healthy` | there and working | `REUSE`, or `REBUILD` if what is there doesn't match what you asked for |
| `degraded` | there but broken or half-built | `REPAIR` if the recipe supports it, otherwise `REBUILD` |
| `unknown` | the probe itself failed, timed out or printed invalid JSON | `BLOCKED`, and the whole plan is marked not executable |

An `unknown` is never treated as `absent`. A broken probe must not green-light rebuilding
something that is actually alive.

The planner is deterministic: the same request plus the same probe results always gives the same
plan. It also handles:

- **Cascades.** If a layer is created or rebuilt, everything contained in it is rebuilt too.
- **Conflicts.** Recipes declare what they claim (`exclusive`, `shared`, `writes`). If a layer you
  want to create claims something a live layer outside your plan also claims, that live layer gets
  a `TEARDOWN` step, with the overlapping claim as the reason. Recipes with `teardown: never`
  (artifacts, credentials) are never proposed for teardown.
- **Manual steps.** Recipes marked interactive, or with `teardown: manual`, become `MANUAL` steps.
  The run shows the recipe's `manualHint` and skips them; it never fakes them.
- **Decisions.** Where the planner had to guess, it records it under `decisions`: near-miss
  versions (asked for 1.14.12, found 1.14.13), alternative parents, params no probe can observe,
  and material defaults you never stated. When any exist, `/start-env` is expected to ask you
  before running anything.

## Using it

### From an agent session: `/start-env`

1. In an agent session (started from the dashboard or a terminal), run
   `/start-env <what you want>` (in Codex: `run /start-env …`), e.g. with the example catalog
   `/start-env an echo server in namespace demo on one cluster`. If you pass an issue or ticket URL,
   the agent reads it if it has a tool for that, and otherwise asks you to paste the relevant part.
2. The agent lists the recipes, picks the shallowest target that answers your instruction, and
   states the target and params it chose in one line.
3. It runs a dry-run plan and shows it to you: what is reused, created, rebuilt or torn down, and
   the time estimate.
4. If the plan has decisions, it asks you about each one. If you change your mind, it re-plans.
5. Anything destructive needs a separate, explicit yes from you.
6. devboard runs the plan (not the agent), so the run survives the session dying. The agent binds
   the environment to the session, and the Env button appears on the session's row within about
   10 seconds. You don't need to refresh the page.

### Opening an environment

There are two ways in:

- **Env button on a row.** Every learning and chore row has a slot next to its other buttons.
  With no environment it shows a greyed `▢` ("No environment for this session — /start-env creates
  one"). Once bound, it shows the icon of the environment's root recipe (for example 🐳 for a
  Docker host, `▣` if the recipe has no icon). Hover for the root, target and original instruction.
- **Environment button in the terminal toolbar.** Inside a running session's terminal, the
  **Environment** button opens the same overlay without leaving the terminal. It is disabled
  until the session has an environment.

### The Environment overlay

The header reads **Environment · \<target\>**, with your original instruction underneath.

**Tree (left).** One row per layer in this environment's chain: state dot, title, kind, the number
of sessions with a live lease, the state label, and a **↻** button to re-probe that one layer.
Healthy layers sort first.

- The tree draws immediately from cached probe results. Layers with no cached result show a
  spinner and **probing…**, never `absent`. Pending layers and anything older than 10 minutes are
  re-probed in parallel, and each row updates on its own.
- Hover a state label to see when it was last probed.
- **Refresh all** (top right) throws away the cached results for this environment and re-probes
  every layer.

**Detail (right).** Click a layer to see:

| Section | What it shows |
| --- | --- |
| observed | the identity the probe reported (versions, cluster names, tags) |
| evidence | the probe's `details` |
| problems | the probe's `errors` |
| configs | only for recipes with a `resources.sh`: the configs that layer manages, each with a drift state; click one to expand its YAML |
| claims exclusively | the layer's exclusive claims |
| instance | the instance id, when it was created, and who holds or last held a lease |

Buttons: **Re-probe**, **Plan to reach this**, and **Tear down** (only for live layers whose
recipe allows teardown). Recipes with manual teardown say "teardown is manual"; artifacts say
"never torn down".

**Plans.** **Plan to reach this** and **Tear down** both re-probe every recipe from scratch (plans
never use the display cache) and show the plan: one line per step with its action and reason, a
summary (`reuse · create · rebuild · teardown · manual — Nm`), and a warning if the plan is not
executable. If the plan destroys anything, you must tick **I understand N steps will destroy live
infrastructure** before **Run plan** / **Run teardown** is enabled. **Cancel** discards the plan.
The overlay plans with the params the environment was bound with, not recipe defaults. Running a
plan for a single layer does not retarget the session's environment to that layer.

The overlay's plan view does not list the planner's `decisions`. Use `/start-env` or
`npm run env -- plan` to see them.

**Runs and logs.** Once you start a run, the right side switches to it: each step with its status
(`reused`, `running`, `done`, `manual`, `failed`, `unverified`, `aborted`, `skipped`) and a live log
stream that follows the output. **Abort** sends SIGTERM to the running script. After every setup
or teardown step the layer is probed again: a script that exits 0 but whose probe disagrees is
marked `unverified` and the run stops. When the run finishes, the tree reloads. The overlay shows
the run you started from it; past runs are kept on disk (see below).

### Ending an environment: `/end-env`

1. In the session, run `/end-env`.
2. The agent shows a dry-run teardown of what is live under this environment and asks whether to
   keep it (the default) or tear it down.
3. If you choose teardown, it shows you the plan and runs it only after you say yes. If any step
   fails or comes back unverified, it stops there and does not unbind.
4. It then ends the session's claim: releases this session's leases and removes the binding. The
   Env button disappears from the row. Any instance another session still leases is reported.

Ending an environment without teardown destroys nothing: not the infrastructure and not the
instance records. A later `/start-env` will probe, find what is still running and reuse it.

### The `npm run env` CLI

`scripts/envctl.mjs` probes and plans from your shell. **It never executes or destroys anything.**
Run it from the repo root, and put `--` before the arguments so npm passes flags through:

| Command | What it does |
| --- | --- |
| `npm run env -- layers` | Print the recipe catalog: each recipe's kind, parent(s), requirements and exclusive claims. |
| `npm run env -- probe [layer]` | Probe one recipe, or every recipe, with recipe defaults. Prints `healthy`, `degraded`, `absent` or `UNKNOWN`, plus details and errors. |
| `npm run env -- plan <target> [param=value ...]` | Probe and print the plan to reach `<target>`: each step's action and reason, a summary, decisions for you, and whether confirmation would be needed. |
| `npm run env -- teardown <target>` | Print what tearing down `<target>` and everything live on top of it would do. |

Options: `--json` (machine-readable output) and `--via <layer>` (force which alternative parent
to use). Param values `true`/`false` and plain integers are parsed as booleans and numbers.

Example:

```bash
npm run env -- plan kind-clusters clusters=4
```

## Where the data lives

Everything is under `~/.agents/environments/`, shared by Claude and Codex:

| Path | Contents |
| --- | --- |
| `meta/<recipe-id>/recipe.yaml` (+ `probe.sh`, `setup.sh`, `teardown.sh`, `resources.sh`) | Recipes. The directory name must equal the recipe's `id`. `layer.yaml` is still accepted as an older name. |
| `meta/lib/` | Shared shell helpers for recipe scripts (not a recipe). |
| `instances/<layer>-<hash8>.json` | Instance records. The hash is of the declared params. |
| `sessions/<session-id>.json` | Session bindings: target, params, `via`, the original instruction, agent, directory. |
| `runs/<run-id>/run.json` | Each run's plan and step results. |
| `.cache/probes.json` | Probe results cached for display only. |

Overrides: `DEVBOARD_ENV_ROOT` moves the whole root; `DEVBOARD_ENV_META` points at a different
recipe directory. The engine itself is domain-agnostic: swap the recipes and you get a different
kind of environment with no code change.

## Good to know

- **Teardown safety.** Every destructive plan needs explicit confirmation; the server refuses to
  start one without it (HTTP 412). The `/end-env` skill only confirms after you've seen the plan.
  Teardowns run deepest layer first. An instance record is deleted only after a teardown step
  whose probe confirms the layer is gone.
- **One run at a time, machine-wide.** Starting a second run while one is going fails with
  "another environment run is already in progress".
- **Not executable.** If any probe in the chain returns `unknown`, the plan is blocked. Fix the
  probe (missing tool, timeout, bad JSON) rather than working around it.
- **Nothing probes on page load.** Showing the Env button is a plain file read. Probing starts only
  when you open an environment, and only for that environment's chain.
- **Cached ≠ current.** Rows in the tree can be up to 10 minutes old before they are re-probed
  automatically. Use ↻ or **Refresh all** when it matters. Plans and runs always probe fresh.
- **Leases expire after one hour.** A lease is taken when a run records an instance and lasts one
  hour. Nothing renews it afterwards, so in practice most leases show as expired. An expired lease
  is still shown ("expired lease …") so you can see who used it last.
- **Manual and interactive steps** (for example an MFA login) are not run by the executor. The run
  log prints `[manual step] <layer>: <hint>`; do that step yourself, then plan again.
- **Long setups** use the recipe's `setupTimeoutSec` (default 30 minutes). Probes time out after
  `probeTimeoutSec` (default 30 seconds) and come back `unknown`.
- **Recipe scripts run with macOS `/bin/bash` 3.2.** Bash 4 features such as `mapfile` or
  `declare -A` fail at runtime there. `scripts/verify-env.mjs` lints for them.
- Related: [04-agent-sessions.md](04-agent-sessions.md) for running sessions in the dashboard,
  [06-code-ontology.md](06-code-ontology.md) for how an environment's pinned commit becomes an
  ontology tab, and [08-reference.md](08-reference.md) for the API.
