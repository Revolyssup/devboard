# Learnings

The Learnings table lists the distilled write-ups your agents leave behind at the end of a
session: what was found, what was ruled out, where to pick up. devboard shows them newest first,
tells you which ones still have a live agent session, and lets you read, edit, search and delete
them without leaving the browser. Use it to find prior work before you start on something, and
to keep the library tidy.

There are two tables with the same shape: **Work** (job learnings) and **Personal** (deliberate
practice). Switch between them with **Work** / **Personal** in the left sidebar; the number next
to each is its file count.

## Using it

### The table

Each section has a **Learnings** panel, sorted by last edit, 8 rows per page. Use **‹ Prev** /
**Next ›** (or **««** / **»»** for first and last page) at the bottom. The table refreshes every
15 seconds so the Active column stays current.

| Column | What it shows |
| --- | --- |
| **Active** | One dot per agent session recorded for the file (see below). |
| **Timestamp** | When the file was last modified on disk. The ✎ Design button and, when a session has one, the environment and code ontology markers sit next to it. |
| **Filename** | The `.md` file name. |
| **Learning name** | The first `# ` heading in the file (or the first non-empty line if there is none). Personal rows also show tags for track, subtype, outcome and confidence. A **not in index** tag means no `index.txt` row matched the file. |
| *(actions)* | **Edit**, **Delete**, **❯ Run**. |

**Keywords.** Click the `▸` next to a learning name to expand a Keywords row: chips derived from
the index summary (Work) or from the front-matter (Personal), followed by the full summary line.
Click `▾` to collapse it.

**Active dots.**

| Dot | Meaning |
| --- | --- |
| Green | A live agent session is working on this file right now. |
| Grey | A session is recorded but is not live. |
| Dashed / empty | No session is recorded for the file. |

A session counts as live when both are true: its transcript was written within the last 15
minutes (`DEVBOARD_ACTIVE_WINDOW_MS`), **and** a running `claude` or `codex` process has that
session's project directory as its working directory. Hover the dots to see, for each session,
the agent, the full session id, the directory, "last seen" time, and a ready-made resume command
(`cd <dir> && claude --resume <id>` or `codex resume <id>`), each with a **copy** button.

### Read

Click anywhere on a row to open it in an overlay, rendered as Markdown (GFM tables, syntax
highlighting). The overlay header shows the title and absolute path, plus **Open in tab ↗**,
**Edit**, **Delete** and **Close ✕**. `Esc` closes it.

### Edit

Click **Edit** on a row (or in the Read overlay). The editor shows a `✎ EDITING <filename>` banner
with the absolute path across the top, so you always know which file you are changing.

- Type in the source. **Preview** renders it; **Edit source** goes back.
- **Save** or `⌘S` / `Ctrl-S` writes the content straight to the file on disk.
- **Revert** throws away unsaved changes.
- **Close ✕** or `Esc` closes; if you have unsaved changes it asks "Discard unsaved changes?".

### Delete

Click **Delete**, then confirm in the "Delete this learning?" dialog.

- **Work:** removes the file *and* its row from `index.txt`, so the index never points at a
  missing file.
- **Personal:** removes the file only (see [Good to know](#good-to-know)).

There is no undo.

### Open a learning in its own tab

Every learning has a standalone page at `/learning/<scope>/<filename>`, for example
`http://localhost:5178/learning/work/2026-09-30-gateway-mtls-upgrade.md`. You get there from
**Open in tab ↗** in the Read overlay, or by picking a search result. The page is read-only, with
**Edit** and **Delete** in the top-right corner, and a breadcrumb back to the dashboard. After a
delete it shows **Back to dashboard**.

### Search

Click **⌕ Search** (top right) or press `⌘K` / `Ctrl-K`. Search covers the section you are in
(Work or Personal), not both.

- **What it matches:** the learning name, the filename, the keyword chips, and the index summary
  line. It does not search file bodies.
- **Multiple words:** split on spaces or commas; every word must match somewhere (each word can
  match a different field).
- **Typos:** tolerated for words of 3+ characters, but only against the name, filename and
  individual keywords (`gatway` finds the gateway file). The summary line is matched as a plain
  substring, so a short query does not match every row.
- **Ordering:** best match first. Name hits weigh most, then filename, keywords, summary. A small
  bonus favours recently edited files, and ties go to the newer file. Each result shows which
  fields matched and its score.
- **Paging:** 8 results per page; a pager appears when there are more.

Use `↑` / `↓` to move, `↵` (or a click) to open the result in a **new tab** at its standalone
page, `Esc` to close.

### Learning Progress Report (Personal only)

The **Learning Progress Report ↗** button sits at the top right of the Personal section.

1. If `~/.agents/data/learnings/personal/learning-report.md` exists, it is rendered read-only in
   an overlay.
2. Otherwise devboard opens the newest `.html` / `.htm` file in `~/dev/learning-shit/reports` in a
   new tab (change the folder with `DEVBOARD_REPORTS_DIR`).
3. If neither exists you get a "No progress report found" message and nothing opens.

The HTML reports are written by a separate practice framework (`/progress-in-learning-shit`) that
is not part of devboard's agent kit.

### Producing and using learnings: `/handoff` and `/learn-from-past`

devboard only shows learnings; your agent writes them.

- **`/handoff`** — run it at the end of (or during) a session. The agent writes or updates a
  learning file for the session and keeps `index.txt` in sync in the same change. It reuses an
  existing file instead of creating a duplicate when the session already has one: first via
  `~/.agents/data/sessions/index.jsonl` (files devboard created for a new session), then via a row
  in `index.txt` that carries the session id, then via a row clearly on the same topic. New work
  files are named `<yyyy-mm-dd>-<topic-slug>.md`. Every handoff records the session id and
  directory, which is what lights up the Active dots and the **❯ Run** button.
- **`/learn-from-past [topic] [all]`** — the read side. The agent reads `index.txt`, picks only
  the files whose summary matches your task (or the subject it infers from the session), lets you
  choose which to load (or loads all matches with `all`), and briefs you on what applies. It never
  bulk-reads the directory, which is why a good one-line `Learning` summary matters.

**New Learning Session** (top right) starts a fresh agent session in the browser terminal and
creates its standing learning file once the session is up. **❯ Run** on a row resumes the row's
session, or starts a new one that reads the file. Both are covered in
[04-agent-sessions.md](04-agent-sessions.md).

## Where the data lives

| Section | Directory |
| --- | --- |
| Work | `~/.agents/data/learnings/work/` |
| Personal | `~/.agents/data/learnings/personal/` |

The legacy paths `~/.claude/learnings/` and `~/.claude/personal/learnings/` are symlinked to these
by `install.sh`, so skills writing either path land in the same place. If the `~/.agents/...`
directory does not exist, the server falls back to the legacy one. `DEVBOARD_WORK_DIR` and
`DEVBOARD_PERSONAL_DIR` override them.

Every `*.md` file in the directory is a row, except `STEERING.md` and `MEMORY.md`. Each directory
also has an `index.txt`.

### Work: `index.txt`

Pipe-separated, five columns, one row per file:

```text
Learning | Filename | Session ID(s) | Directory | Last Updated
Gateway drops mTLS after the 1.28 upgrade; SAN matching changed | 2026-09-30-gateway-mtls-upgrade.md | claude:6f1c..., codex:0199... | /Users/you/dev/repo | 2026-09-30
```

- **Learning:** the one-line summary. It feeds the keyword chips and search, and it is what
  `/learn-from-past` routes on. It must not contain ` | `.
- **Session ID(s):** comma-separated. An id with no `agent:` prefix is treated as Claude.
- **Directory:** where the session was launched; `-` means none.

A work file may also list sessions in a front-matter `agent_sessions` block; devboard merges
those with the index.

### Personal: `index.txt` and front-matter

The personal index is an analytics table with **no filename column**:

```text
date | track | subtype | topic | outcome | confidence | mode | hints_used
```

Each personal learning file carries YAML front-matter, and devboard matches a file to its index row
by `date` + `topic` (falling back to `topic` alone):

```yaml
---
date: 2026-09-14
track: dsa
subtype: graphs
topic: dijkstra-variants
outcome: solved
confidence: 3
session_id: claude:6f1c...      # or "-" if no session was recorded
directory: /Users/you/dev/learning-shit
struggled_with: [heap-updates]
comfortable_with: [bfs]
---
```

Session provenance for personal files lives here (`session_id`, `directory`, or an
`agent_sessions` block), not in the index. Keyword chips come from `track`, `subtype`, `topic`,
`outcome`, `struggled_with` and `comfortable_with`.

### Shared front-matter for sessions

Either scope can list sessions in a structured block, which is how Claude and Codex share a file:

```yaml
agent_sessions:
  - agent: claude
    id: <session-id>
    directory: /Users/you/dev/repo
```

## Good to know

- **The Timestamp is the file's modification time**, not the index `Last Updated` date. Editing a
  file in devboard moves it to the top.
- **Editing does not touch `index.txt`.** If you change what a work learning is about, update its
  `Learning` summary row too, or search and `/learn-from-past` keep routing on the old one.
- **Deleting a personal learning leaves its index row.** That index has no filename column to
  match on, so the analytics row stays. Remove it by hand if it matters.
- **"not in index" and empty Keywords** mean no index row matched the file (for Personal, check
  that `date` and `topic` in the front-matter match the row exactly).
- **No dot, or a grey dot that should be green:** the session id was never recorded (transcripts
  are pruned after about 30 days, so a handoff that did not write the id has lost it), or `lsof`
  is not on the server's `PATH`, or the agent is running from a different directory than the one
  recorded.
- **`learning-report.md`** in the personal folder is also a `.md` file, so it shows up as a row in
  the Personal table as well as behind the report button.
- **Sorting** in the UI is always by last edit. The API also accepts `sort=title` or
  `sort=filename` (see [08-reference.md](08-reference.md)).
- **Filenames are confined to their directory:** only plain `*.md` basenames, no paths or dot-files.
  Edit only saves files that already exist; it never creates one.
- Setup and data directories: [01-setup.md](01-setup.md). The ✎ Design button on each row:
  [07-design.md](07-design.md). Environment and code ontology markers next to the timestamp:
  [05-environments.md](05-environments.md), [06-code-ontology.md](06-code-ontology.md).
