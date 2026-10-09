# Design: prose → facts, flags and targets

Status: draft 1 (2026-10-08)
Scope: per-session (learning or chore row) design documents in devboard.

## Problem

Agent-written code is meaningless if the human doesn't understand the system it changes. The fact
sheet tried to fix that by making the human write structure (Given/When/Then, ids, statuses) up
front. That moved the hard part earlier instead of removing it, and it was judged "tedious and
wonky".

This design keeps the human writing **only prose**, in any shape: behaviour as they understand it,
design concerns, bugs, environment notes. The agent turns the prose into checkable
claims tied to exact code and runnable scripts. The human navigates the system through those claims,
starting from their own sentences.

## The central rules

> **Prose is the human's; everything else is the agent's.** The agent never edits `design.md`.
> It writes facts, flags and targets, and only through the server.

> **A green fact has passed and has failed.** A result counts only if the same `verify.sh` also
> FAILs where it should (a control run, or the base branch for a prototype). A script that cannot
> fail proves nothing.

> **A result belongs to (sha, environment), not to the fact.** The fact holds the claim and the
> script; each run is recorded separately against the SHA that was actually *running*.

## Constructs

| Kind | Comes from | Button | Attributed to | Ends |
|---|---|---|---|---|
| **Fact** | A claim the code agrees with | Verify | branch@sha | Never deleted silently |
| **Flag** | A claim the code contradicts | Verify (confirm the contradiction at runtime) | branch@sha | When the user removes its lines from the prose, or a Re-derive they asked for reclassifies/retires it |
| **Target** | A wish (intended behaviour) | Prototype(branch) | Nothing until prototyped | Becomes a Fact on `branch@sha` |

IDs are short and stable so they can be referred to from the terminal: `F-7`, `X-2`, `T-3`. A
Target that becomes a Fact keeps its history (`F-9 (was T-3)`).

Visual states (the only ones):

- Fact: **orange** = code-backed (anchored at a sha, not run); **green** = runtime-verified (PASS +
  control FAIL); a spinner while running.
- Flag: **red**, with the same orange/green distinction for code-only vs runtime-confirmed.
- Target: **grey** (bare intent); spinner while prototyping.
- Any item: a **"source changed"** marker when its source sentence was edited. Nothing else happens
  until the user acts.

## How items are created

1. **Derive facts** (button above the sidebar) is the only button that creates items. The agent
   reads the whole document and creates an item for every verifiable claim and every wish it finds.
   - A claim can be spread across several lines, so an item's source is a **list of quoted
     fragments** of the prose, not a single span.
   - Incremental: it skips claims already covered by an item and never duplicates or rewrites
     existing items. Re-running it after edits only picks up new prose.
   - The agent classifies kind, so derived items carry `kindBy: agent` and show a small **auto**
     badge. There is no flip button: what an item *is* follows from the prose and the code. If the
     agent got the kind wrong, the user clarifies the prose and clicks **Re-derive**.
   - It prefers claims that matter to behaviour and skips restatements and trivia. It reports in
     the terminal what it chose to skip.
2. **`/verify-fact <plain-text pointer>`** typed in the terminal, for something Derive missed:
   "the part where I say anonymous requests are rejected". The agent finds those fragments in
   the prose and creates one item (fact, flag or target), the same way Derive would.

Neither path runs anything. Verify and Prototype are always per item, on the user's click.

**Re-derive** (per item, any kind) asks the agent to re-read the current prose and the code for that
one item after the user has edited the document. Outcomes: unchanged, updated (claim/quotes/anchors),
reclassified (e.g. flag → fact once the clarified prose agrees with the code; a target Derive
misread may become a fact/flag only if it has no prototype work yet — no runs, no frozen script, no
diff), or retired (the
prose no longer makes the claim; kept under `removed/` with the reason). The server allows the
agent to reclassify a flag, or retire any item, only while a re-derive request is open on that
item. So nothing changes kind or disappears unless the user asked for it.

## Verify (Facts and Flags)

1. Generate `inputs/` (configs, arguments, preconditions) and `verify.sh`.
2. Run `./verify.sh` (expect PASS for a Fact, or the contradicting outcome for a Flag) and
   `./verify.sh --control` (expect FAIL: same assertion, inputs changed so the claim should not hold).
3. Record both runs under `runs/`. The item turns green only when both behave as expected.

**Verify all** (sidebar header) sends every code-backed fact that has no runtime check yet as one
`/design verify-all` command. The agent verifies them one at a time, never in parallel because they
share the environment, and stops at the first "cannot run here" result, since the ones after it
would fail the same way.

## Prototype (Targets)

Prototype takes an explicit branch name. If the branch exists it is reused, otherwise it is created
from the current base.

1. **Script first.** Write `inputs/` and `verify.sh` for the target behaviour.
2. **Must fail on base.** Run it against the base sha. It must FAIL (`1`). If it PASSes, the target
   already holds, so stop and tell the user. That base run is the control.
3. **Freeze.** From here the agent may only change product code. If it believes the script or its
   inputs are wrong, it stops and asks in the terminal. It never edits them to make the run pass.
4. **Loop.** Write code on the branch, build/deploy into the environment, and run `verify.sh` until it
   PASSes.
5. **Regression.** Re-run every Fact already attributed to this branch. If one breaks, report it as a
   regression; don't overwrite anything.
6. **Promote.** The Target becomes a Fact attributed to `branch@sha`. Its Code is the prototype
   diff (`base..sha`), not just a code excerpt.

## verify.sh contract

Each fact's script must run standalone: copy the fact's folder anywhere and run `./verify.sh`.

- Exit codes: `0` PASS, `1` FAIL, `2` **cannot run here** (wrong image, missing cluster or tool,
  unreachable dependency). `2` is never shown as FAIL.
- Preconditions are checked first and declared at the top of the script: the required image/sha,
  kube contexts and tools.
- Inputs are read only via paths relative to the script (`$(dirname "$0")/inputs/...`). Shared setup
  is copied in or referenced relative to the design root (`../../fixtures/`).
- Assert on **who decided**, not just the outcome. Example: a 403 must be attributed to the
  gateway's RBAC (`rbac_access_denied`), not to an upstream rate limit.
- `--control` runs the same assertion against the control inputs (or is omitted for targets, whose
  control is the base-branch run).
- The script writes its own evidence into `$OUT` (default `./runs/<sha12>-<ts>/sentinel/`):
  generated objects, effective config dumps, request results and logs. The agent never assembles
  sentinels by hand.

## Environment

Optional `## Environment` heading inside `design.md`, written in prose like everything else. The
agent compiles it into a `/start-env` target (`environments.md`); without one it deduces the target
from the claims. Verify never builds infrastructure itself. It probes, and returns `2` if the env
is missing. Each run records the env instance and the running image sha from the probe, never the
checked-out branch.

## Storage

Next to the session's learning (or chore) file:

```
<dir>/<slug>.md                     the learning/chore file (unchanged)
<dir>/<slug>.design/
  binding.json                      key, repo, nextId, design-wide request (Derive spinner)
  design.md                         the user's prose; agents never write it
  journal.md                        every write and run: what changed, why
  fixtures/                         shared setup used by several items
  items/7/                          numbered by the stable item number (F-7 / X-7 / T-7)
    item.json                       claim, kind, kindBy, source.quotes[], repo, branch, sha, anchors[], code.diff, frozen
    inputs/  control/               configs for the run and the control run
    verify.sh
    runs/<ts>-<mode>/
      run.json                      {mode, exit, result, scriptHash, sha (VERIFY_SHA), env (VERIFY_ENV), took}
      log.txt
      sentinel/                     $OUT
  removed/                          items the user removed (kept, not deleted)
```

API (devboard, `localhost:5178/api/design`): `GET state|list|file|diff|run`, `POST open|items|item/update|item/flip|item/remove|request|run`, `PUT doc` (editor only). The server runs verify.sh; a run's result is its exit code.

Sources are stored as quoted fragments (whitespace-insensitive), so they still resolve when the
surrounding prose moves. If some fragments are gone, the item is marked "source changed". A Flag
whose fragments are all gone is resolved; that is the only way a Flag goes away.

## Who does the work

**The session's main agent, in its terminal**, the same pattern as codont. There is no second agent.

- **UI → agent:** the Derive / Verify / Prototype buttons make the server type a short
  command into the session's terminal pty, e.g. `/design verify X-2`. The user sees it and can
  interrupt or add to it.
- **Agent → UI:** `POST /api/design/update` with the delta for the items involved. The server
  resolves code anchors at the item's sha (reusing codont's `resolveAnchor`), rejects writes to
  `design.md`, appends to `journal.md`, and the panel re-renders.
- **Challenge from the terminal:** "X-2: use the config with mTLS off" or "F-7: your control isn't a
  real negation". The agent edits that item's inputs/script, records why in `journal.md`, and
  re-runs if asked. For a Target mid-prototype this is the only way the frozen script changes.

## UI

- `<Design>` button on the session's row, next to Env and Codont.
- Left (most of the width): a nanotype-style editor for `design.md`. No toolbar, quiet serif,
  autosave. A margin dot on every line that one of an item's quoted fragments touches, in the
  item's colour.
- Right: the sidebar with **Derive facts** at the top, then items grouped Flags → Targets → Facts.
  Clicking an item highlights its sentence. Expanding an item shows: claim · branch@sha · Code
  (anchored excerpt or prototype diff) · Inputs · verify.sh · latest runs (normal + control) ·
  sentinel files. Each part opens in CodePeek / file view.

## For agents

The step-by-step procedure for every command is `~/.agents/specs/design-agent.md` (agent-neutral;
Claude and Codex skills only point to it). The rules below are its non-negotiable core.


- Never write `design.md`. Never write item files directly; use `POST /api/design/update`.
- Read code at the item's sha with `git show <sha>:<path>`, not the working tree.
- A Target's script and inputs are frozen once they have failed on base. Change them only when
  the user says so in the terminal, and journal it.
- Exit `2` is "couldn't test", not FAIL. Say so plainly.
- Never promote to green without a recorded control run that failed.
- Removing a Flag is the user's act (deleting the source line), never yours.

## Open questions

1. When a chore ends (`/end-chore` deletes the chore file), does its `.design/` move into a
   learning, or get archived?
2. (decided) Editor is CodeMirror 6; it makes the margin dots
   much easier.
3. Should Verify accept a branch other than the item's, to check a claim elsewhere?
