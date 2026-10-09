# Design — agent procedure

Agent-neutral. Claude, Codex or any other agent driving a devboard session follows this file;
agent-specific skills (`~/.claude/skills/design`, `~/.codex/skills/design`, ...) only point here.
Contract (what the server enforces and why): `~/.agents/specs/design-facts.md`. Read both once per
session before the first write.

## How commands arrive

devboard's Design window types commands into the session's terminal, as the user would. The words
are the same for every agent; only the prefix differs (Claude: `/design …`; Codex: `run /design …`):

```
/design derive <ref>
/design verify <F-n|X-n> <ref>
/design verify-all <ref> <F-n> <F-n> ...
/design rederive <F-n|X-n|T-n> <ref>
/design prototype <T-n> branch=<name> <ref>
/verify-fact <plain-text pointer to part of the prose>      (typed by the user)
```

Everything below is shell + HTTP (`curl`, `git`, `bash`); no agent-specific tool is required.

`<ref>` is `<scope>/<kind>/<file.md>` (e.g. `work/learning/2026-10-08-foo.md`) and goes into every
API call as `"ref"`. API base: `http://localhost:5178/api/design`.

```bash
B=http://localhost:5178/api/design; REF='work/learning/2026-10-08-foo.md'
curl -s "$B/state?ref=$REF"            # prose (doc), items with status, runs, folder paths
```

## Rules that are never bent

- **Never write `design.md`.** The prose is the user's. Not via the API, not via the filesystem.
- **Never write `item.json` or `runs/` by hand.** Items change only through `POST $B/items` and
  `POST $B/item/update`. The server validates quotes, resolves anchors and journals every change.
- **You do write the experiment files**: `<item dir>/verify.sh`, `inputs/`, `control/` (the item's
  `dir` is in `/state`). Shared setup goes in `<design dir>/fixtures/`.
- **You never report a result.** The server runs `verify.sh` (`POST $B/run`) and the exit code is the
  result. Don't summarise a run as passed unless `/run` says `"result":"pass"`.
- **Read code at the item's sha** (`git show <sha>:<path>`), not the working tree.
- **When done with a request, clear its spinner**: include `"request": null` in your final
  `item/update` patch, or `POST $B/request {"ref":..,"item":"F-7","action":null}`. For derive:
  `POST $B/request {"ref":..,"action":null}` (no item).

## derive

1. `GET /state`. Read `doc` in full, and the existing `items` (don't duplicate a claim an item already
   covers, even if worded differently; don't rewrite existing items).
2. Pull out every claim that matters to behaviour, and every wish:
   - **fact**: a claim about current behaviour that the code agrees with.
   - **flag**: a claim about current behaviour that the code contradicts. The `explanation` says what
     the code actually does.
   - **target**: intended behaviour ("I want", "should", "we need", a design proposal). No code.
   A claim may be spread over several lines or sentences; quote every fragment it rests on.
   Skip restatements, trivia, and claims you can't tie to code. Unsure if a claim is
   a fact or a flag? Read more code until you're sure. Don't guess.
3. For facts and flags, find the code that proves or disproves it. Use symbol anchors where possible
   (`{"path":"pkg/x/gate.go","symbol":"Gate"}`), plus `endLine` to cover the block that matters.
   Several anchors are fine. Set `branch` (the session repo's current branch, or `master`) and
   optionally `repo` (absolute path) if the code isn't in the design's repo.
4. Create everything in one call:

```bash
curl -s -X POST $B/items -H 'content-type: application/json' -d @- <<'JSON'
{"ref":"<ref>","items":[
 {"kind":"flag","claim":"Requests without a token are rejected by the gateway",
  "explanation":"authorize() lets tokenless requests through when allowAnonymous is set (L88)",
  "source":{"quotes":["every request without a token","is rejected at the gateway"]},
  "branch":"main","anchors":[{"path":"internal/gateway/auth.go","symbol":"authorize","endLine":95}]},
 {"kind":"target","claim":"Rate limits apply per tenant, not per IP",
  "source":{"quotes":["I want","rate limits to be per tenant"]}}
]}
JSON
```

   Quotes are copied **verbatim** from `doc` (whitespace differences are fine, nothing else). A 400
   names fragments that aren't in the prose: fix and resend. Check `verification.anchors` in the
   response; fix any `ok:false` with `item/update` before finishing.
5. Clear the derive spinner. In the terminal, list what you created (id + one line) and **what you
   skipped and why**, in a few lines.

## verify-all (several facts)

`/design verify-all <ref> F-1 F-4 F-7` — the user's bulk button, for code-backed facts with no
runtime check yet. It is the **verify** procedure below, once per item, **one item at a time** in
the order given:

- Before starting, look for setup the items share (same cluster, same base config) and put it in
  `<design dir>/fixtures/` once, rather than copying it into every item.
- Never run two items' `verify.sh` at the same time: they share the environment and would
  contaminate each other.
- Finish each item fully (normal + control run, spinner cleared with `"request": null`) before
  starting the next, so the sidebar fills in as you go.
- If an item hits `cannot-run` (exit 2) because the environment itself is missing or broken, stop
  there and report: every item after it would fail the same way. Clear the spinners of the items
  you didn't get to.
- End with one line per item: id, result, sha that ran.

## verify (fact or flag)

Goal: a `verify.sh` the user can copy anywhere and run to check this one claim themselves.

1. `GET /state`, find the item. Work out the runtime experiment: which env, what config/input, what
   observation proves the claim. Environment: use the session's existing environment if it has
   one; the `## Environment` section of the prose, if present, says how the user wants it set up.
   Never build infrastructure inside verify.sh.
2. Write `inputs/` (configs applied for the claim) and `control/` (the same, changed so the claim
   should NOT hold). Then `verify.sh`, using this contract:
   - `#!/usr/bin/env bash`, `set -uo pipefail`. A header comment states the claim, the item id,
     and the preconditions.
   - **Exit codes:** `0` = the claim holds; `1` = it doesn't; `2` = can't run here (missing
     cluster/context/tool, wrong image). Check preconditions first and `exit 2` with a clear message.
   - `./verify.sh` uses `inputs/`; `./verify.sh --control` uses `control/`, with the same assertion.
   - Paths only relative to the script: `HERE=$(cd "$(dirname "$0")" && pwd)`. Shared setup from
     `$HERE/../../fixtures/`.
   - Print `VERIFY_SHA=<sha or image tag actually running>` (probe it, e.g. the deployment image) and
     `VERIFY_ENV=<context/cluster>`.
   - Save evidence into `${OUT:-$HERE/out}`: the applied config, the generated objects, effective
     config dumps, request results, the relevant log lines (e.g. `generated.yaml`,
     `envoy-rbac.txt`, `results.txt`).
   - **Assert on who decided**, not just the outcome. A 403 must be shown to come from the thing the
     claim is about (e.g. `rbac_access_denied` in the gateway access log), not from an upstream.
   - Clean up what it applied (trap), so runs don't contaminate each other.
   - For a **flag**, the script asserts what the code ACTUALLY does (the contradiction). Exit 0
     confirms the flag.
3. Run it, then the control:

```bash
curl -s -X POST $B/run -H 'content-type: application/json' -d '{"ref":"<ref>","item":"F-7","mode":"normal"}'
# → {"runId":"..."}; wait for it (long-poll, up to 540s per call; repeat if still running):
curl -s "$B/run?ref=<ref>&item=F-7&runId=<id>&wait=500"
curl -s -X POST $B/run ... '"mode":"control"' ...
```

   Green needs: normal = `pass` AND control = `fail`, from the same script. If the control also
   passes, the script isn't testing the claim. Fix the script, not the conclusion.
4. If normal **fails**, the claim is wrong at runtime. Don't touch the prose. Tell the user plainly, and
   suggest turning it into a flag (`item/update {"patch":{"kind":"flag","explanation":...}}`) once they
   agree. A `cannot-run` (exit 2) is "couldn't test", not a failure. Say what is missing.
5. Clear the spinner. Report: result, the sha that ran, and where the evidence is.

## rederive (one item, any kind)

The user has edited the prose, maybe to clarify, correct or withdraw what this item was derived from,
and wants it looked at again. Only this item.

1. `GET /state`. Re-read the **whole** current `doc`, not just the old quotes: the clarification
   may be somewhere else. Re-read the code at the item's sha (or the current branch if the claim
   now points elsewhere).
2. Decide one outcome, then do it with a `note` that says what in the prose changed:
   - **Unchanged.** The edits don't affect this claim: `item/update {"patch":{"request":null},
     "note":"..."}`.
   - **Updated.** Same idea, sharper claim: patch `claim` / `source.quotes` (verbatim from the new
     doc) / `explanation` / `anchors`.
   - **Reclassified.** e.g. the clarified prose now agrees with the code, so flag → fact (or fact →
     flag). Patch `kind` (+ claim/quotes/explanation). The server only lets a flag change kind during
     a re-derive. A target can be reclassified only if Derive misread a claim about current
     behaviour as a wish AND it has no prototype work (no runs, not frozen, no diff); it then becomes
     an unverified fact/flag. A target with prototype work becomes a fact only through prototype.
   - **Retired.** The prose no longer makes this claim at all:
     `POST $B/item/retire {"ref":..,"item":"X-2","reason":"<what changed in the prose>"}`.
     Only works during a re-derive. The item is kept under `removed/` with the reason.
3. If the claim's *meaning* changed, the existing `verify.sh` no longer tests it. Say so, and tell
   the user to click Verify again; don't re-run on your own. For a **frozen target**, a changed claim
   means a new experiment: ask them before touching its script (unfreeze rules apply).
   A flag → fact flip keeps its runs. The script asserted what the code actually does, which is now
   also what the prose says.
4. Clear the spinner (`"request": null` in the patch; retire clears it itself) and report the
   outcome in one or two lines.

## prototype (target)

`branch=<name>`: use it if it exists, otherwise create it from the current base branch. Work in a
worktree if the main checkout is busy. The order is fixed, and the server enforces it:

1. **Script first.** Write `inputs/` + `verify.sh` for the target behaviour (same contract as verify).
2. **Baseline.** Deploy or point at the base, then `POST /run` with `"mode":"baseline"`. It **must
   fail** (`exit 1`). If it passes, the target already holds: stop and tell the user. A failing
   baseline **freezes** verify.sh + inputs (server-side hash).
3. **Frozen.** From now on change only product code. If you think the script or inputs are wrong,
   STOP and ask the user in the terminal. Only when they say so, re-run with
   `"unfreeze":true,"reason":"<their words>"` (journalled).
4. **Loop.** Implement on the branch, build and deploy it into the environment, `POST /run`
   `"mode":"normal"`, until it passes. Commit on the branch.
5. **Regression.** Re-run (`mode: normal`) every fact whose `branch` is this branch. Report anything
   that broke, and never overwrite it.
6. **Promote**:

```bash
curl -s -X POST $B/item/update -H 'content-type: application/json' -d '{"ref":"<ref>","item":"T-3",
 "patch":{"kind":"fact","branch":"<branch>","code":{"diff":{"base":"<base sha>","head":"<branch>"}},
 "anchors":[...key changed code...],"request":null},"note":"prototyped"}'
```

   A 409 means the guard is not satisfied (no failing baseline or passing normal run of the current
   script). Do what it says. Never work around it.

## Challenges and advice from the user

When the user refers to an item in the terminal ("X-2: use the config with mTLS off", "F-7's control
isn't a real negation", "T-3 is really two things"), act on that item and only that item:
- Change its files / anchors / claim through the routes above. Pass a `note` quoting what they asked;
  it goes into `journal.md`.
- Re-run if the experiment changed, and report the new result.
- Splitting an item = create the new items with their quotes, then ask them whether to remove the old
  one (removal is their button).
- Never delete or reclassify a flag on your own. It goes away when the user removes its lines from
  the prose, or through a re-derive they asked for (the server refuses otherwise).

## verify-fact (one item Derive missed)

The user points at part of their prose in plain words, e.g. `/verify-fact the bit where I say
anonymous requests are rejected`. Make **one** item out of it, with exactly the rules of **derive**.

1. Find the design. It's the one devboard opened for this session's learning/chore file. The `ref`
   is `<scope>/<kind>/<file.md>`. If you have seen a `/design ... <ref>` command in this session, use
   that ref. Otherwise `curl -s localhost:5178/api/design/list` and pick the entry for this
   session's file. If it's ambiguous, ask them.
2. `GET /api/design/state?ref=<ref>`. Locate the part of `doc` they mean. It may span several
   lines, so quote every fragment the claim rests on, verbatim. If an existing item already covers
   it, say which one and stop. If you can't locate it, quote your best candidates and ask.
3. Classify (fact / flag / target), anchor facts and flags in code at a pinned branch/sha, and create
   it with `POST /api/design/items` (one item).
4. Fix any anchor that failed verification. In the terminal, reply with the new id, its kind, and one
   line on why. It shows up in their sidebar right away. Verifying it at runtime is their next click
   (Verify), not yours.
