# devboard
<img width="3015" height="1262" alt="Screenshot 2026-09-02 at 2 48 49 PM" src="https://github.com/user-attachments/assets/778b1543-7c2d-42ea-801e-704fb4493859" />
<img width="3248" height="950" alt="Screenshot 2026-09-02 at 2 48 33 PM" src="https://github.com/user-attachments/assets/3443ad0c-dd03-42d3-b11e-e21fb992bf2c" />

A browser dashboard over the shared agent learnings libraries and chore tracker that live under
`~/.agents/data`. The old `~/.claude` data paths remain compatibility links during migration.
Backend and frontend both live in this repo.

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ Personal │  Learnings table  (Active · Timestamp · Filename · Name) │
│ Work     │    └ expandable Keywords row per learning                │
│          │  Active chores    (each section tracks its own)          │
└──────────┴──────────────────────────────────────────────────────────┘
```

Both sections have the same shape; they differ only in which directories back them:

| | Work | Personal |
|---|---|---|
| Learnings | `~/.agents/data/learnings/work/` | `~/.agents/data/learnings/personal/` |
| Chores | `~/.agents/data/chores/work/` | `~/.agents/data/chores/personal/` |
| Chore commands | `/start-chore`, `/end-chore` | `/start-personal-chore`, `/end-personal-chore` |
| Extra button | — | Learning Progress Report |

## Run it

```bash
npm run install:all     # once — installs server + web deps
npm run dev             # api on :5178, vite dev server on :5177  → open http://localhost:5177
```

For a single-port setup (the API serves the built SPA):

```bash
npm run build && npm start   # → http://localhost:5178
```

## Data sources

| What | Path | Notes |
|---|---|---|
| Work learnings | `~/.agents/data/learnings/work/` | `index.txt` is `Learning \| Filename \| Session ID(s) \| Directory \| Last Updated`; unprefixed legacy session ids mean Claude |
| Personal learnings | `~/.agents/data/learnings/personal/` | `index.txt` is `date \| track \| subtype \| topic \| outcome \| confidence \| mode \| hints_used`; rows match files via front-matter |
| Work chores | `~/.agents/data/chores/work/` | `index.txt` is `Chore \| Filename \| Session ID \| Directory \| Started`; `Agent:` in the chore file or `agent:<id>` in the index can identify Codex |
| Personal chores | `~/.agents/data/chores/personal/` | same index format; created on first `/start-personal-chore` |
| Session transcripts | `~/.claude/projects/<slug>/<session-id>.jsonl`, `~/.codex/sessions/**/*.jsonl` | used for Active detection |
| Progress reports | `~/dev/learning-shit/reports/*.html` | written by `/progress-in-learning-shit` |

Every path is overridable: `DEVBOARD_DATA_ROOT`, `DEVBOARD_WORK_DIR`, `DEVBOARD_PERSONAL_DIR`,
`DEVBOARD_CHORES_DIR`, `DEVBOARD_PERSONAL_CHORES_DIR`, `DEVBOARD_REPORTS_DIR`, `PORT`.

A missing chores directory is not an error — the panel shows an empty state naming the command
that creates it.

## Features

**Learnings table** — newest edit first, paginated. Columns: Active, Timestamp, Filename,
Learning name (the first `#` heading inside the file), and per-row actions.

- **Keywords row** — the `▸` toggle on each row expands a hidden Keywords row: chips derived
  from the index `Learning` summary (work) or from `track`/`subtype`/`topic` +
  `struggled_with`/`comfortable_with` front-matter (personal), followed by the full summary.
- **Read** — markdown rendered in an overlay above the dashboard, syntax-highlighted, GFM tables.
- **Edit** — opens the file with an `✎ EDITING <filename>` banner and the absolute path across
  the top, so it is never ambiguous which file is being changed. `⌘S` or Save writes straight
  back to disk; there is a Preview toggle and a Revert.
- **Delete** — confirmation dialog, then removes the file *and* its `index.txt` row (work), so
  the index never points at a file that no longer exists.

**Active column** — one dot per session id associated with the file. Green = a live agent
session, grey = known but idle, dashed outline = no session recorded. A session counts as live
when its transcript was touched within `DEVBOARD_ACTIVE_WINDOW_MS` (default 15 min) **and** a
running matching agent process has that project directory as its cwd. Hovering a dot shows the
session id, the directory, and a ready-made resume command — `claude --resume <id>` or
`codex resume <id>` — each with a copy button.

The two scopes record that provenance in different places, because their indexes differ:

| Scope | Source of `session_id` / `directory` | Why |
| --- | --- | --- |
| Work | `Session ID(s)` + `Directory` columns of `~/.agents/data/learnings/work/index.txt`, plus optional `agent_sessions` frontmatter | Work learning files historically had no front-matter, so the index remains supported. |
| Personal | `session_id` + `directory` and optional `agent_sessions` front-matter in the learning file itself | `~/.agents/data/learnings/personal/index.txt` is the analytics table (`date \| track \| subtype \| topic \| outcome \| confidence \| mode \| hints_used`) — it has **no filename column**, so rows are matched to files by `date::topic`. |

Either field may be `-`, meaning "no recoverable session" — claude prunes transcripts after
~30 days, so any handoff that did not write the id down at the time has lost it permanently.
Both are written by `/handoff` (schema in `~/dev/learning-shit/CLAUDE.md` for personal).

**Search** (`⌕ Search` top-right, or `⌘K`) — fuzzy ranking over filename, learning name and
keywords, paginated best-first. Typos are tolerated (`waypont` finds the waypoint file);
long prose is substring-matched only, so a two-letter query cannot match everything.
`↑`/`↓` to move, `↵` opens that learning in a **new tab** at `/learning/:scope/:filename` —
read-only, with Edit and Delete in the top-right corner.

**Run session** — each row can carry Claude sessions, Codex sessions, or both. If exactly one
resumable session is recorded, the terminal button opens it directly. If multiple sessions are
recorded, the button opens a chooser showing agent, short session id, active/idle state, and last
seen time; selecting one resumes the matching CLI.

**Active chores** — each section has its own panel below its learnings table, backed by its own
directory: Work shows `/start-chore` items from `~/.agents/data/chores/work`, Personal shows
`/start-personal-chore` items from `~/.agents/data/chores/personal`. The two never mix.

Same shape as the learnings table minus Active, plus a **Session ID** column (copyable, with the
directory) and a progress readout of the three tracked sections. The `▸` toggle expands
*What is done* / *What is happening* / *What is pending* side by side, and the row shows the
current "now" item inline. Read and Delete only — chores are written by the agent, not the UI.
Deleting does exactly what the matching `/end-*-chore` does: file + index row. Each panel has its
own fuzzy search and polls every 10s so it stays live while an agent works.

**Learning Progress Report** (Personal, top-right) — opens the newest HTML report from
`~/dev/learning-shit/reports` in a new tab. If `~/.agents/data/learnings/personal/learning-report.md`
ever exists, it is rendered read-only in an overlay instead.

## Agent skills

Installed into `~/.claude/skills` for Claude and `~/.codex/skills` for Codex. The shared contract
is under `~/.agents/specs`. Two matched pairs, one per section; each pair owns exactly one
directory and never writes to the other's:

- **`/start-chore <work item>`** — job work. Creates `~/.agents/data/chores/work/<date>-<slug>.md` with the
  three tracked sections and appends an index row carrying the agent session id and cwd. The skill also
  instructs the agent to keep the file current on every step that moves the work forward.
- **`/end-chore`** — checks for unfinished work and for anything worth a `/handoff` first, then
  deletes the chore file and its index row.
- **`/start-personal-chore <item>`** — same mechanics for non-job work (side projects,
  `~/dev/learning-shit` exercises, dotfiles), writing to `~/.agents/data/chores/personal/` and
  creating that directory on first use.
- **`/end-personal-chore`** — the personal counterpart; offers to capture anything durable as a
  personal learning in `~/.agents/data/learnings/personal/` before deleting.

## API

```
GET    /api/health
GET    /api/learnings/:scope?page=&pageSize=&sort=        scope = work | personal
GET    /api/learnings/:scope/search?q=&page=&pageSize=
GET    /api/learnings/:scope/file/:filename
PUT    /api/learnings/:scope/file/:filename               body { content }
DELETE /api/learnings/:scope/file/:filename               file + index row
GET    /api/chores/:scope?page=&pageSize=&q=                scope = work | personal
GET    /api/chores/:scope/file/:filename
DELETE /api/chores/:scope/file/:filename                  file + index row
GET    /api/reports/progress
GET    /reports/file/:name                                serves a report HTML
POST   /api/terminal                                      preflight → single-use ticket
GET    /api/terminal?ticket=            (Upgrade)         the terminal websocket
GET    /api/terminal/status                               open terminals / cap
```

Filenames are confined to their scope directory (basename only, `.md` only) — no traversal.

## Run session

Every learnings and chores row has a `❯ Run` action that opens a popup terminal and resumes that
row's selected agent session under a PTY, in the row's recorded directory, proxied to xterm.js in
the browser. Claude uses `claude --resume <id>`; Codex uses `codex resume <id>`. Closing the popup
(`Close ✕`) terminates the process; it does not just hide the window.

The button is **disabled** when a row has no recorded session or no directory (the tooltip says
which). Opening is **blocked** when that session is already running somewhere else, because two
claude processes appending to one transcript corrupts it for every future resume.

```
POST /api/terminal  ──▶ validates, reserves the session, returns a 30s single-use ticket
     ws ?ticket=…   ──▶ redeems it, spawns the pty
     server → client   binary frames = raw pty bytes; text frames = ready/exit/error/chore-gone
     client → server   {t:"i"|"resize"|"ping"|"kill"}
```

Why the shape is what it is:

- **Two phases.** Every rejection is an ordinary HTTP status + `{ error, code }`, so a failure is
  explained before any terminal chrome mounts, and neither the session id nor an absolute path ever
  rides in a websocket URL.
- **Binary output frames.** JSON-wrapping pty output splits multi-byte UTF-8 across chunk
  boundaries, and this TUI is wall-to-wall box drawing.
- **A preflight reserves the session.** Otherwise two rapid clicks both pass (nothing is running
  yet) and both attach.
- **Our own pids are excluded from the liveness scan** (`sessions.js`). Without that, opening a
  terminal for one chore marks its whole project directory live and every *other* row sharing that
  directory falsely becomes "already live" — three of the current work chores share one directory.
- Occupancy is only hard-blocked on the definitive signal (`claude --resume <id>` in `ps` argv).
  The weaker directory-level heuristic is surfaced as a warning banner instead. A session resumed
  from *inside* the TUI via `/resume` keeps a bare `claude` argv and cannot be detected at all.

### `/end-chore` from inside the terminal

A chore terminal shows a **permanent amber banner** naming the file at risk, and an advisory modal
the first time `/end-chore` appears in your input. Neither gates the keystroke — nothing is ever
swallowed.

That is deliberate. `/end-chore` is conversational: it asks *which* chore when the session id
doesn't match a row, asks again if work is still pending, and offers to run `/handoff` first. A
modal asserting "this will be deleted" would frequently be wrong, and inferring intent from
keystrokes desyncs against slash-command autocomplete, paste, and `↑` history recall.

Instead the **outcome** is detected: the server watches the chore directory (`fs.watch` plus a 3s
stat backstop, since `fs.watch` misses things) and pushes `chore-gone` when the file actually
disappears. The overlay then refreshes the table and closes on a 10s countdown with a **Stay open**
button — claude is usually still printing its confirmation, and you may want to run `/handoff`.

Security: the server binds **127.0.0.1 only** and checks `Origin` on upgrade — it can spawn a
claude session with your credentials, so it must never be reachable from the network. The session
id is regex-validated (it is the only value reaching argv), the process is spawned with an argv
array and never a shell, and the cwd must resolve under `DEVBOARD_TERMINAL_ROOTS` (default `$HOME`)
because `directory` comes from a file on disk.

| Env | Default | |
| --- | --- | --- |
| `DEVBOARD_CLAUDE_BIN` | `claude` | binary to resume with; the verifier points it at a stand-in |
| `DEVBOARD_TERMINAL_ROOTS` | `$HOME` | `:`-separated allowlist for the spawn cwd |
| `DEVBOARD_MAX_TERMINALS` | `3` | concurrent terminals |
| `DEVBOARD_TERMINAL_IDLE_MS` | `1800000` | idle timeout |
| `DEVBOARD_ALLOWED_ORIGINS` | localhost:5177/5178 | websocket `Origin` allowlist |

**node-pty note:** its prebuilt `spawn-helper` ships without the execute bit, and without it every
spawn fails with a bare `posix_spawnp failed`. `scripts/fix-node-pty-perms.mjs` runs on
`postinstall` to re-apply it.

## Layout

```
server/
  index.js              express app + SPA fallback
  config.js             paths, active-session window
  lib/
    indexes.js          index.txt parsers (3 formats) + row removal
    learnings.js        list / read / write / delete, path confinement
    chores.js           chore listing + section parsing
    sessions.js         live-session detection (ps + lsof + transcript mtimes)
    terminals.js        pty registry, tickets, occupancy, chore watcher, teardown
    markdown.js         front-matter, title extraction, keyword derivation
    search.js           fuzzy ranking + pagination
  routes/
web/                    vite + react + typescript
scripts/                headless end-to-end verifiers (see below)
  fake-claude.sh        deterministic stand-in so terminals can be tested without real sessions
  fix-node-pty-perms.mjs  postinstall: restore +x on node-pty's spawn-helper
```

## Verification

`scripts/` holds the headless end-to-end runs (puppeteer-core against a local Chromium-based
browser; the path is set at the top of each script):

```bash
npm run build                            # the suites hit :5178, which serves web/dist
npm start &                              # or npm run dev
npm run verify                           # all five, in order
# …or individually:
node scripts/verify-ui.mjs               # renders every view, screenshots, asserts no console errors
node scripts/verify-extras.mjs           # pagination, chore search, progress report, standalone tab
node scripts/verify-personal-chores.mjs  # Personal panel is backed by its own dir, isolated from Work
node scripts/verify-mutations.mjs        # edit → save → on-disk diff, delete → file + index row gone
node scripts/verify-terminal.mjs         # terminal: reject matrix, pty round-trip, resize, teardown
```

`verify-terminal.mjs` runs its own server on port 5179 with `DEVBOARD_CLAUDE_BIN` pointed at
`scripts/fake-claude.sh`, so it never spawns a real session. Its fixtures live under `$HOME`, not
`/tmp` — on macOS `/tmp` is a symlink to `/private/tmp`, so a slug derived from the path would not
match what `lsof` reports for the same directory.

The two mutating suites seed and then delete their own scratch files (a learning, and a personal
chore), so they never touch real content; assertions are relative to the pre-run state rather than
hardcoded counts. Pass `DEVBOARD_TEST_SESSION=<live session uuid>` to `verify-mutations.mjs` to
also assert the green Active dot. Screenshots land in `$SHOTS` (default `/tmp/devboard-shots`).
