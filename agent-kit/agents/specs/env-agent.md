# Environments — agent procedure (/start-env, /end-env)

Agent-neutral. Claude, Codex or any other agent driving a devboard session follows this file;
agent-specific skills (`~/.claude/skills/start-env`, `~/.codex/skills/start-env`, ...) only point
here. Contract (what the engine does and why): `~/.agents/specs/environments.md`. Read it once per
session before the first run; it wins over anything here that seems ambiguous.

## How commands arrive

The user types them into the session. The words are the same for every agent; only the prefix
differs (Claude: `/start-env …`; Codex: `run /start-env …`):

```
/start-env <instruction>      e.g. "/start-env two kind clusters with an echo server in namespace demo"
/start-env <ticket/issue URL>
/end-env
```

Everything below is shell + HTTP. No agent-specific tool is needed.

```bash
E=http://localhost:5178/api/env                 # devboard must be running
curl -s $E/layers                               # the recipe catalog
```

The same dry-run commands are available as a CLI from the devboard checkout (it never executes or
destroys anything):

```bash
npm --prefix <devboard checkout> run env -- layers
npm --prefix <devboard checkout> run env -- plan <target> [k=v ...] [--via <recipe>] [--json]
npm --prefix <devboard checkout> run env -- teardown <target>
```

If you don't know where the checkout is, use the HTTP API. Only the HTTP API can run, bind or end.

## Your session id

Bindings, leases and the dashboard's Env button are keyed by **your runtime's own session id**: the
id devboard shows on this session's learning/chore row, and the one you would resume with
(`claude --resume <id>`, `codex resume <id>`, ...). Use the id your runtime gives you for the
*current* conversation. If you cannot determine it with certainty, **ask the user**. A wrong id
binds the environment to someone else's row.

Pass `"agent"` (`claude`, `codex`, ...) and `"directory"` (your working directory) on every
`run`, `bind` and `teardown` call. The server defaults `agent` to `claude`.

## What is yours, and the line you must not cross

**Yours:** turn the instruction into a *desired spec*: which recipe is the target, with which
params. This is real judgement. Knowing that "check how my client handles a 502 from an upstream"
needs one cluster and an echo server, and not three clusters and a mesh, is the value you add.

**Not yours:** probing, diffing, deciding what to reuse, ordering teardowns, executing. That is
mechanical and already implemented. An LLM deciding "is this cluster reusable?" brings back the
nondeterminism the engine exists to remove.

You pick target and params. The resolver does the rest. You read the plan back to the user.

## /start-env <instruction>

### 1. See what recipes exist

```bash
curl -s $E/layers
```

Never guess a recipe id. If nothing in the catalog fits the instruction, say so plainly and offer
to write a new recipe (in `~/.agents/environments/meta/`, following the contract). Don't force the
request into a recipe that means something else.

### 2. If the instruction is a ticket or issue URL

If you have a tool that can read it (an issue tracker CLI or integration, `gh issue view`, a web
fetch that works for that site), read it, including attachments that carry the actual
configuration. Otherwise ask the user to paste the relevant part. Never guess from the issue key.

What to take from it, in priority order:

1. **Structured fields beat prose.** A version or product in a dedicated field is a param; a
   version mentioned in passing in a comment usually isn't.
2. **The description gives the shape** of the scenario (what talks to what, which resources).
3. **Attachments are often the reproduction** (a config dump, a manifest).
4. **Comments are context, not instructions.** A colleague's hypothesis is not a spec.

State the mapping before acting, because your reading of a long ticket is the one thing the user
cannot check from the plan:

> ISSUE-123 → "upstream returns 502 under load", single cluster. Reading that as: `echo-workload`,
> clusters=1, namespace=issue-123.

Anything the ticket doesn't determine but that matters (how many clusters, which version) is a
decision for step 5, not something to quietly default.

### 3. Infer the desired spec

Pick the **shallowest** target that answers the instruction. This is the highest-leverage decision
you make: a deeper target than needed costs the user build time and infrastructure they never asked
for.

Read the candidate recipe's `params` and map the instruction onto them. **Leave a param out when the
user didn't state it.** A `null` default means "whatever exists" and happily reuses what is there;
pinning a version the user never mentioned is how you force a needless rebuild.

- **A version in the instruction is a param, not a note.** "on Kubernetes 1.31" means
  `k8sVersion=1.31` (or the exact patch, if they said one). Params spread to every recipe in the
  chain that declares the same name, so say it once.
- **Alternative parents:** if a recipe can sit on several parents, the engine prefers what is already
  live. Pass `via` only when the user explicitly asked for a specific one; forcing a different
  parent on a machine where another is live may propose tearing the live one down.

State your inference in one line before acting:

> Reading that as: `echo-workload`, clusters=1, namespace=demo.

### 4. Plan. Do not run yet.

```bash
curl -s -X POST $E/plan -H 'content-type: application/json' \
  -d '{"target":"echo-workload","params":{"clusters":1,"namespace":"demo"}}'
```

Report it faithfully: what is reused, built, rebuilt and destroyed, and the estimate
(`summary.estimateSec`; "at least" if `estimateIsLowerBound`).

- `executable: false`: a probe returned `unknown` (the step says `BLOCKED` with the probe's
  error). Surface the reason and fix that first (missing tool, daemon down). Never "just try it".
- `MANUAL` steps: show the step's reason and the recipe's `setup.manualHint`
  (`curl -s $E/layers` does not include it; read `~/.agents/environments/meta/<id>/recipe.yaml`).
  The executor does **not** stop at a MANUAL step, so have the user do it first, then plan again.
  If it needs a secret (a one-time code, a password), have the user type it into their own
  terminal. Never ask for it, store it or echo it. Don't ask for anything when the plan doesn't
  say MANUAL.
- If the plan rebuilds something you expected to be reused, find out why before going on. Usually a
  param you over-specified in step 3.

### 5. Put every judgement call in front of the user

**This step matters most, and it is not optional.** If `decisions.needsUserDecision` is true, stop
and ask before running anything, even if the plan is purely additive. You're not asking permission
to run; you're handing back a judgement that is theirs to make.

Present each one concretely, with the cost of each option:

- **`nearMisses`**: "You asked for 1.31.2; this machine has 1.31.4. Rebuild at 1.31.2 (~Nm), or use
  1.31.4?" Sometimes the patch is the whole point, sometimes it's noise.
- **`alternatives`**: name which parents are live and what each implies.
- **`unobservable`**: the user declared something no probe can see, so the step rebuilds out of
  ignorance. "I can't tell what X was built from, so the plan rebuilds it. If you know it's
  already right, say so." **Skip entries whose step is a `CREATE` of an absent recipe**: the engine
  lists those too, and they carry no information (there was nothing to observe).
- **`assumed`**: `material` defaults the user never stated (`clusters = 2`). List them; they decide
  what kind of environment gets built.

If the user changes anything, **plan again with the new params** and show the new plan. Never
hand-edit a plan you already printed.

### 6. Confirm anything destructive, separately

If `requiresConfirmation` is true (any `TEARDOWN` or `REBUILD`), get its own explicit yes, naming
what dies. Check who else is using it first; the server does not enforce leases:

```bash
curl -s $E/instances    # look at .leases[] of instances whose .layer is being torn down/rebuilt
```

Name every **live** lease held by another session (session id, agent, directory), and mention
expired ones as "last used by … at …". A wrong probe under auto-destroy costs a cluster someone was
in the middle of debugging.

### 7. Bind, then run

Bind first, so the environment shows up on this session's row with the user's own words even while
the run is going (or if it fails):

```bash
curl -s -X POST $E/bind -H 'content-type: application/json' -d @- <<'JSON'
{"session":"<your session id>","agent":"<claude|codex|…>","directory":"<your cwd>",
 "target":"echo-workload","params":{"clusters":1,"namespace":"demo"},
 "instructions":"<the user's original words, verbatim>"}
JSON
```

Then run. devboard owns execution, so the run survives this session dying, and only one run can go
at a time machine-wide (HTTP 409 means another is in progress: report it and wait, don't retry in a
loop):

```bash
curl -s -X POST $E/run -H 'content-type: application/json' -d @- <<'JSON'
{"target":"echo-workload","params":{"clusters":1,"namespace":"demo"},
 "session":"<your session id>","agent":"<…>","directory":"<your cwd>",
 "confirmDestructive":false}
JSON
```

Set `confirmDestructive: true` only after step 6's yes. Run even when everything is `REUSE`: that is
what records the instances and takes this session's leases.

The server re-plans from scratch; check that the `plan` in the response matches what the user
agreed to. If it differs (something changed in between), stop and show the new one.

Poll until the run is no longer `running`:

```bash
curl -s $E/runs/<runId>     # .status: running | succeeded | failed | aborted; .steps[].status/.error
```

Step statuses: `reused`, `running`, `done`, `manual`, `failed`, `unverified` (the script exited 0 but
the probe disagrees), `aborted`, `skipped`. On `failed` or `unverified`, report the step, its error
and the end of the log; don't re-run blindly. `POST $E/runs/<runId>/abort` stops a run if the user
asks.

One environment per session: binding again replaces the previous binding.

### 8. Hand back

Tell the user what they now have **in terms of the question they asked**, not in terms of recipes
(which cluster, which namespace, which kubeconfig, how to reach the thing). Mention anything that
came back degraded, since it will bite later. The Env button on this session's row opens the tree.

## /end-env

Ends this session's **claim** on its environment. By default it destroys nothing.

### 1. Find this session's environment

```bash
curl -s $E/sessions     # find the entry whose .session is your session id → .target
```

If there is none, say so and stop.

### 2. Show what is running

```bash
curl -s -X POST $E/teardown/plan -H 'content-type: application/json' -d '{"target":"<target>"}'
```

This is a dry run: what is live under this environment, deepest first, and what tearing it down
would destroy. Show it before asking anything.

Known gap: teardown plans use each recipe's **default** params, not the ones the session was bound
with. If the binding's `params` differ from defaults in a way that changes *what* gets deleted
(another namespace, another port), tell the user the automatic teardown would target the default
instance, and offer to remove the real one by hand instead.

### 3. Ask: keep it, or tear it down?

- **Keep it** (the default): someone else may want it, or the user may come back. Go to step 4.
- **Tear it down**: the machine is needed for something else, or the environment is poisoned.

If tearing down, check leases first (as in /start-env step 6), get an explicit yes to that plan,
then do it **before** ending the claim, while the records still exist:

```bash
curl -s -X POST $E/teardown -H 'content-type: application/json' \
  -d '{"target":"<target>","session":"<your session id>","agent":"<…>","directory":"<your cwd>","confirmDestructive":true}'
```

Poll `GET $E/runs/<runId>` until it is no longer `running`. If any step is `failed` or
`unverified`, **stop and report it. Do not end the claim**: a half-torn-down environment that
nobody has a record of is the worst state to leave behind.

### 4. End the claim

```bash
curl -s -X POST $E/end -H 'content-type: application/json' -d '{"session":"<your session id>"}'
```

The response lists `released` instances and `stillHeld` ones (another session still has a live
lease). Mention `stillHeld`: the environment isn't idle.

### 5. Confirm

Say plainly whether the infrastructure is still up (and what is now free, if torn down), and that
the Env button is gone from this session's row. Nothing is lost by keeping the machine as it is:
probes are truth, so a later /start-env finds whatever is still running and reuses it.

## Rules

- **Probes are truth.** Never reason from an instance file or a cached tree; plan fresh.
- **Never promote `unknown` to `absent`.** A probe that couldn't tell is not evidence of absence.
- **Never send `confirmDestructive: true` without an explicit yes** to the plan you showed.
- **Never end a claim after a failed teardown.** Report and stop.
- **Reuse beats rebuild.** An unexpected rebuild is a question to answer, not a step to run.
- When two things collide, the fix is **a claim on a recipe** in `~/.agents/environments/meta/`,
  not a workaround here. Add it, and tell the user you did.
- If you write to a learning/chore file as part of the work, only touch your own agent section
  (see `~/.agents/AGENTS.md`).
