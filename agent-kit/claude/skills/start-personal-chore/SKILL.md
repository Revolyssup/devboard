---
name: start-personal-chore
description: Begin tracking a personal chore (a side-project task, a study exercise, a dotfiles fix, something on a personal repo) — creates a tracked file in ~/.claude/personal/chores with What is done / What is happening / What is pending, plus an index.txt row carrying the session ID. Use when the user runs /start-personal-chore <item>, or asks to track a personal (non-work) chore.
---

# /start-personal-chore — track a personal chore

The personal counterpart of `/start-chore`. Identical mechanics, different directory: personal
chores live in `~/.claude/personal/chores/` and surface in the **Personal** section of the
devboard dashboard, while `/start-chore` writes to `~/.claude/chores/` and surfaces under
**Work**. The two never mix.

Use this one for anything that is not job work: a task on a personal repo, a study
exercise you want to keep visible across sessions, a dotfiles or tooling fix, a side project
chore.

Chores are **ephemeral**: they live only until `/end-personal-chore` deletes them. Anything worth
keeping past that point belongs in a personal learning file in `~/.claude/personal/learnings/`,
not here.

## On invocation

0. **Read the shared contract first, every time this runs.** Read `~/.agents/AGENTS.md` and
   `~/.agents/specs/start-chore.md` before doing anything else below. The canonical personal chore
   root is `~/.agents/data/chores/personal` (`~/.claude/personal/chores` is the compatibility path).

1. **Identify the current session ID.** It is the UUID segment of the scratchpad directory path
   in the system prompt (`.../<project>/<SESSION-UUID>/scratchpad`). Also note the current
   working directory — both go into the index row.

2. **Create the directory if needed.** `~/.claude/personal/chores/` may not exist yet; create it
   before writing.

3. **Check for an existing chore for this session.** First read
   `~/.agents/data/sessions/index.jsonl` and look for a row whose `{agent, id}` matches this
   Claude session. If it has `chore_file`, update that devboard-created chore file instead of
   creating a duplicate. Otherwise read `~/.claude/personal/chores/index.txt`. If a row already
   carries the current session ID, ask whether to continue that chore or start a second one. Do not
   silently create a duplicate.

4. **Create the chore file** at `~/.claude/personal/chores/<yyyy-mm-dd>-<short-slug>.md`, where
   `<short-slug>` is 2–5 kebab-case words derived from the item (`finish-two-sum-writeup`,
   `fix-statusline-script`, `migrate-notes-to-notion`). Get the date from `date +%F`.

   Exact structure — the dashboard parses these three headings by name, so do not rename them:

   ```markdown
   # <Chore title — one line, human readable>

   - **Started:** <yyyy-mm-dd HH:MM>
   - **Session:** <session-uuid>
   - **Directory:** <cwd>
   - **Ask:** <the raw item the user typed>

   ## What is done

   - <nothing yet — leave empty until something actually lands>

   ## What is happening

   - <the one thing being worked on right now>

   ## What is pending

   - <the concrete remaining steps, as you understand them at kickoff>
   ```

5. **Append an index row** to `~/.claude/personal/chores/index.txt`. Create the file with this
   header if it does not exist:

   ```
   Chore | Filename | Session ID | Directory | Started
   ```

   The row is 5 pipe-separated columns:
   - `Chore`: one crisp line naming the item and its target (repo, exercise, file), phrased so it
     is searchable — this is what the dashboard fuzzy-search matches against, alongside the
     filename and title. Must contain no literal ` | `.
   - `Filename`: the file name only, no path.
   - `Session ID`: the current session UUID.
   - `Directory`: the absolute working directory.
   - `Started`: `yyyy-mm-dd`.

6. **Confirm to the user** in one line: the chore file path and the tracked title.

## For the rest of the session — keep it current

After `/start-personal-chore`, treat the chore file as a live status board. **On every action
that moves the work forward**, update it before moving on:

- Something finished → move that bullet from *What is happening* / *What is pending* into
  **What is done**, rewritten as a completed statement with the concrete result.
- Starting the next thing → put it in **What is happening** (keep this to what is genuinely in
  flight, ideally one bullet).
- Discovering new required work → append it to **What is pending**.
- Blocked → keep the bullet in *What is happening* and mark it `BLOCKED: <on what>`.

Keep bullets short and factual — this file is read at a glance on a dashboard, not as prose. Do
not rename the headings or add extra top-level sections.

If the chore produced a real, reusable learning, capture it as a personal learning in
`~/.claude/personal/learnings/` — it
will then show up in the dashboard's Personal learnings table independently of this chore.

## Finishing

When the work is done, the user runs `/end-personal-chore`, which deletes the file and its index
row. Deleting the chore from the devboard Personal panel does exactly the same thing.
