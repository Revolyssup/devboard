# Chores

A chore is a bounded piece of work that usually produces no lasting knowledge: review a PR, fix
CI on a branch, bump a dependency, chase a flaky test. While an agent works on one, it keeps a
small status file up to date (what is done, what is happening now, what is left), and the
**Active chores** panel shows every chore in flight at a glance. Chores are temporary: when the
work is finished the file is deleted, and anything worth keeping goes into a
[learning](02-learnings.md) instead.

Work and Personal each have their own **Active chores** panel, below the Learnings table, backed by
their own directory. The two never mix.

## Using it

### Start a chore from an agent session

In any Claude Code or Codex session, run the start command with a short description of the work:

| | Start | End |
| --- | --- | --- |
| Work | `/start-chore <work item>` | `/end-chore` |
| Personal | `/start-personal-chore <item>` | `/end-personal-chore` |

In Codex, type `run /start-chore <item>` (and so on).

The agent creates `<yyyy-mm-dd>-<short-slug>.md` in the chore directory, appends a row to that
directory's `index.txt` with its session id and working directory, and confirms the path. From then
on it updates the file on every step that moves the work forward:

- finished work moves into **What is done**, written as a result (PR number, commit, test name);
- the thing in flight goes in **What is happening** (ideally one bullet; `BLOCKED: <on what>` if
  stuck);
- newly discovered work is appended to **What is pending**.

The chore appears in the panel within about 10 seconds. Before creating a file, the agent checks
whether devboard or an earlier command already made one for this session, so you do not get
duplicates.

### End a chore

Run `/end-chore` (or `/end-personal-chore`) in the session. The agent:

1. finds the chore whose index row carries the current session id (or asks which one, if none
   match; you can also name it: `/end-chore review-pr-1214`);
2. reads it, and asks before closing if *What is happening* or *What is pending* still has items;
3. offers to capture anything reusable first (`/handoff` for work, a personal learning for
   personal);
4. deletes the chore file and removes its `index.txt` row.

### Resume a chore: `/resume-chore`

`/resume-chore <path-to-chore-file>` (Codex: `resume chore <path>`) continues an existing chore
without creating a new one. The agent reads the whole file, adds the current session to the file's
`agent_sessions` and to the index row's `Session ID` cell, then carries on from the three status
sections. You rarely type it yourself: the **❯ Run** button on a chore row types it for you (see
below).

### Read the panel

| Column | What it shows |
| --- | --- |
| **Timestamp** | When the chore file was last modified, next to the ✎ Design button (and environment / code ontology markers when the session has them). |
| **Filename** | The chore file name. |
| **Chore** | The file's `# ` title. Underneath, a `▸ now` line shows the first item of *What is happening*. |
| **Progress** | Three pills: `<n> done`, `<n> now`, `<n> left`, counting the items in *What is done*, *What is happening* and *What is pending*. |
| **Session ID** | Each recorded session as `agent:<first 8 chars>…` with a **copy** button for the full id, then the directory (shortened to `~`) with its own **copy** button. `—` if none is recorded. |
| *(actions)* | **Edit**, **Delete**, **❯ Run**. |

Click `▸` next to a title to expand the row: *What is done*, *What is happening* and *What is
pending* side by side, followed by the index summary line. The panel shows 6 chores per page,
newest edit first, and re-reads the directory every 10 seconds so you can watch an agent work.

### Search

Type in **Fuzzy search chores…** at the top of the panel. It matches the chore title, filename,
keywords derived from the index `Chore` summary, and the summary itself, with the same rules as
learnings search ([02-learnings.md](02-learnings.md#search)): every word must match, typos are
tolerated on titles, filenames and keywords, and results are ordered best match first. Clearing the
box returns to newest-first order. Each panel searches only its own chores.

### Read, edit and delete

- **Read:** click a row. The overlay renders the file and has **Edit**, **Delete** and **Close ✕**.
- **Edit:** opens the same editor as learnings (`✎ EDITING` banner, **Preview**, **Save** / `⌘S`,
  **Revert**), writing straight to the chore file. Agents own these files, so keep manual edits
  small and do not rename the three section headings.
- **Delete:** confirm in the "End this chore?" dialog with **Delete chore**. It removes the file
  and its `index.txt` row, exactly what `/end-chore` / `/end-personal-chore` do, but without the
  pending-work and learning checks.

### ❯ Run on a chore row

**❯ Run** opens an **Open with** menu listing Claude and Codex. Picking an agent that already has a
session on the chore resumes the newest one; picking one without a session starts a new session in
the chore's directory. Either way, devboard types `/resume-chore <path>` (or `resume chore <path>`
for Codex) into the session, so the agent picks up where the file says. Details on the browser
terminal are in [04-agent-sessions.md](04-agent-sessions.md).

### New Chore Session

**New Chore Session** (top right of each section) starts a chore and its agent session in one go.

1. Click **New Chore Session**.
2. Pick the **Agent** (claude or codex; codex is preselected).
3. Fill in **Chore Title** and **Description**. Both are required.
4. Set **Directory** (Work only): type a path, pick from the suggestions, or press `Tab` to take the
   first one. The directory must be inside your home directory (or `DEVBOARD_TERMINAL_ROOTS`).
   Personal chores always run in `~/dev/learning-shit`.
5. Click **Open**.

What devboard does with it:

1. Creates the chore file right away as `<yyyy-mm-dd>-devboard-<slug>.md`, with `Session: -`, the
   **Description** as the **Ask** line and as the *What is pending* items (one per line), and both
   agent sections. It appends an index row with `-` as the session id. The chore shows up in the
   panel immediately.
2. Starts a fresh agent session in the directory in the browser terminal and types the start
   command into it: `/start-chore <title>: <description>. Use existing chore file <path>; do not
   create a duplicate. …` (`/start-personal-chore` for Personal, prefixed with `run ` for Codex).
3. As soon as it detects the new session's transcript, it fills in the session: adds an
   `agent_sessions` entry to the file's front-matter, replaces `Session: -` with the real id,
   writes `agent:<id>` into the index row, and records the pairing in
   `~/.agents/data/sessions/index.jsonl`. That record is what the start skill checks, so the agent
   updates this file instead of creating a second one.

## Where the data lives

| Section | Directory |
| --- | --- |
| Work | `~/.agents/data/chores/work/` |
| Personal | `~/.agents/data/chores/personal/` |

The legacy paths `~/.claude/chores/` and `~/.claude/personal/chores/` are symlinked to these by
`install.sh`; if the `~/.agents/...` directory does not exist, the server reads the legacy one.
`DEVBOARD_CHORES_DIR` and `DEVBOARD_PERSONAL_CHORES_DIR` override them. Every `*.md` file in the
directory is listed as a chore.

### Chore file

```markdown
---
agent_sessions:
  - agent: claude
    id: <session-id>
    directory: /Users/you/dev/repo
---

# Review PR 1214 in repo-x

- **Started:** 2026-10-09 14:05
- **Agent:** claude
- **Session:** <session-id>
- **Directory:** /Users/you/dev/repo
- **Ask:** review PR 1214

## What is done

- Read the diff; two call sites changed.

## What is happening

- Running the integration tests locally.

## What is pending

- Leave review comments.

## Claude Section

- **Last updated:** 2026-10-09T14:20:00Z
- Claude's own notes.

## Codex Section

- **Last updated:** -
- Pending.
```

- The three headings **What is done**, **What is happening** and **What is pending** are what the
  panel parses. devboard also accepts `Done`, `Happening` / `In progress` and `Pending`. Every
  non-empty line under a heading (bullet marker stripped) counts as one item; the next heading of
  any level ends the section.
- `agent_sessions` is the structured session list; the `Agent:`, `Session:` and `Directory:` lines
  are kept for older commands.
- Both agents may work the same chore. Each reads the whole file but writes only its own
  `## Claude Section` or `## Codex Section`; the three status sections are shared.

### `index.txt`

Each chore directory has its own index, five pipe-separated columns:

```text
Chore | Filename | Session ID | Directory | Started
Review PR 1214 in repo-x | 2026-10-09-review-pr-1214.md | claude:<id>, codex:<id> | /Users/you/dev/repo | 2026-10-09
```

- **Chore:** a searchable one-line summary; it feeds keyword chips and search. No ` | ` inside.
- **Session ID:** comma-separated; an id without an `agent:` prefix is read using the file's
  `Agent:` line, or as Claude if there is none. `-` means no session yet.
- **Started:** `yyyy-mm-dd`.

## Good to know

- **No Active column.** Chores do not show green/grey liveness dots; the **❯ Run** button shows
  **❯ Running** when a browser terminal for that chore is open.
- **Placeholder bullets count.** A fresh file's `- <nothing yet>` under *What is done* counts as one
  item, so a new chore shows `1 done` until the agent replaces it.
- **A chore that will not go away** usually means only one of the two was removed: delete the file
  *and* its index row. A file with no index row still shows (sessions then come only from its
  front-matter); an index row with no file does not.
- **Deleting from the panel skips the safety checks** that `/end-chore` does (pending work,
  capturing a learning). Use the command when the chore might have taught you something.
- **Ending a chore from inside a devboard terminal:** the terminal shows a warning banner naming
  the chore file, and closes itself on a countdown (with **Stay open**) once the file is actually
  gone. See [04-agent-sessions.md](04-agent-sessions.md).
- **New Chore Session errors:** "chore title is required" / "chore description is required" if
  either is empty; a directory outside the allowed roots is rejected; at most 10 terminals can be
  open at once (`DEVBOARD_MAX_TERMINALS`).
- **Empty panel:** a missing chore directory is not an error; the panel says which command creates
  the first chore.
- Setup and data directories: [01-setup.md](01-setup.md). API routes: [08-reference.md](08-reference.md).
  The ✎ Design button on each row: [07-design.md](07-design.md).
