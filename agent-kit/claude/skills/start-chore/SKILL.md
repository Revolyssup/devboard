---
name: start-chore
description: Begin tracking a work chore (review this PR, fix CI, bump a dep, chase a flake) — creates a tracked file in ~/.claude/chores with What is done / What is happening / What is pending, plus an index.txt row carrying the session ID, and keeps it updated as the work progresses. Use when the user runs /start-chore <work item>, or asks to start tracking a chore.
---

# /start-chore — track a work chore

A **chore** is a bounded work item that usually produces no durable learning: review this PR,
fix CI on branch X, bump a dependency, chase a flaky test, respond to a customer ticket.
Chores are tracked so the devboard dashboard can show, in one place, everything currently in
flight and how far along each one is.

This command is for **job work** — it writes to `~/.claude/chores/` and surfaces under **Work**
on the dashboard. For anything personal (a side project, a study exercise, a
dotfiles fix), use `/start-personal-chore` instead: it writes to `~/.claude/personal/chores/` and
surfaces under **Personal**. The two directories never mix.

Chores are **ephemeral**: they live only until `/end-chore` deletes them. Anything worth
keeping past that point belongs in a learning file via `/handoff`, not here.

## On invocation

0. **Read the shared contract first, every time this runs.** Read `~/.agents/AGENTS.md` and
   `~/.agents/specs/start-chore.md` before doing anything else below. The canonical work chore
   root is `~/.agents/data/chores/work` (`~/.claude/chores` is the compatibility path); the specs
   define the `agent_sessions` provenance format this skill should use.

1. **Identify the current session ID.** It is the UUID segment of the scratchpad directory
   path in the system prompt (`.../<project>/<SESSION-UUID>/scratchpad`). Also note the
   current working directory — both go into the index row.

2. **Check for an existing chore for this session.** First read
   `~/.agents/data/sessions/index.jsonl` and look for a row whose `{agent, id}` matches this
   Claude session. If it has `chore_file`, update that devboard-created chore file instead of
   creating a duplicate. Otherwise read `~/.claude/chores/index.txt`. If a row already carries the
   current session ID, ask whether to continue that chore or start a second one. Do not silently
   create a duplicate.

3. **Create the chore file** at `~/.claude/chores/<yyyy-mm-dd>-<short-slug>.md`, where
   `<short-slug>` is 2–5 kebab-case words derived from the work item
   (`review-pr-1214`, `fix-ci-release-1.14`, `bump-go-jose`). Get the date from `date +%F`.

   Exact structure — the dashboard parses these three headings by name, so do not rename them:

   ```markdown
   # <Chore title — one line, human readable>

   - **Started:** <yyyy-mm-dd HH:MM>
   - **Session:** <session-uuid>
   - **Directory:** <cwd>
   - **Ask:** <the raw work item the user typed>

   ## What is done

   - <nothing yet — leave empty until something actually lands>

   ## What is happening

   - <the one thing being worked on right now>

   ## What is pending

   - <the concrete remaining steps, as you understand them at kickoff>
   ```

4. **Append an index row** to `~/.claude/chores/index.txt`. Create the file with this header
   if it does not exist:

   ```
   Chore | Filename | Session ID | Directory | Started
   ```

   The row is 5 pipe-separated columns:
   - `Chore`: one crisp line naming the work item and its target (repo/PR/branch), phrased so
     it is searchable — this is what the dashboard fuzzy-search matches against, alongside the
     filename and title. Must contain no literal ` | `.
   - `Filename`: the file name only, no path.
   - `Session ID`: the current session UUID.
   - `Directory`: the absolute working directory.
   - `Started`: `yyyy-mm-dd`.

5. **Confirm to the user** in one line: the chore file path and the tracked title.

## For the rest of the session — keep it current

After `/start-chore`, treat the chore file as a live status board. **On every action that moves
the work forward**, update it before moving on:

- Something finished → move that bullet from *What is happening* / *What is pending* into
  **What is done**, rewritten as a completed statement with the concrete result (PR number,
  commit SHA, test name, error that got fixed).
- Starting the next thing → put it in **What is happening** (keep this section to what is
  genuinely in flight, ideally one bullet).
- Discovering new required work → append it to **What is pending**.
- Blocked → keep the bullet in *What is happening* and mark it `BLOCKED: <on what>`.

Keep bullets short and factual — this file is read at a glance on a dashboard, not as prose.
Do not rewrite the headings, and do not add extra top-level sections; anything else you need to
record goes under one of the three.

If the chore turns out to carry a real, reusable learning, run `/handoff` as well — the learning
belongs in `~/.claude/learnings/`, and it will then show up in the dashboard's learnings table
independently of this chore.

## Finishing

When the work is done, the user runs `/end-chore`, which deletes the file and its index row.
