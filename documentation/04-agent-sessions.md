# Agent sessions

devboard can run a Claude or Codex session inside the browser. The board spawns the agent under a real pseudo-terminal on your machine, in the directory the learning or chore was recorded in, and streams it into a terminal popup. Use it to pick up a learning or chore exactly where it stopped, or to start a new one, without hunting for the session id and directory yourself.

## Using it

### Resume a learning or chore: `❯ Run`

Every row in the Learnings table and the Chores panel has a `❯ Run` button showing the Claude and Codex icons.

1. Click `❯ Run`. A small **Open with** menu lists `claude` and `codex`.
2. Each entry shows the session it will open: the first 8 characters of the id and when it was last active. If the row lists several sessions for that agent, devboard picks a live one first, then the most recently used.
3. If the row has no session for that agent, the entry reads `new session` / `read file` instead. Choosing it starts a fresh session in the row's directory and has the agent read the file (see the table below).
4. Click an entry. The terminal popup opens and the agent starts.

| Agent | Command devboard runs |
| --- | --- |
| Claude | `claude --resume <session-id>` |
| Codex | `codex resume <session-id>` |
| New session (either) | `claude` or `codex` with no arguments |

An entry is greyed out only when the row has no session for that agent **and** no recorded directory to start a new one in. Personal rows fall back to `~/dev/learning-shit`.

What gets typed into the agent for you once it starts:

| You opened | Auto-typed input |
| --- | --- |
| A learning row, existing session | Nothing. The session resumes as it was. |
| A chore row, existing session | `/resume-chore <chore file path>. Read the whole chore file, resume the work from its current state, update only the <agent> section, …` (Codex gets `resume chore …` instead of the slash command) |
| A learning row, `new session` | `Read the handoff/learning file <path>, continue from the latest state across all agents, and update only the <agent> section with your progress.` |
| A chore row, `new session` | The same `/resume-chore …` line as above |

When the new session's id appears, devboard records it on the row (in the learning's or chore's index), so next time `❯ Run` resumes it directly.

**Pruned transcripts.** Claude deletes old transcripts after its `cleanupPeriodDays`. If you resume a Claude session whose transcript no longer exists under `~/.claude/projects/<slug>/`, devboard does not fail. It starts a fresh Claude session seeded from the learning or chore file, as in the `new session` rows above, and shows a warning: `no transcript for session … (likely pruned) — started a fresh claude session seeded from <file>`. If the transcript exists but under a *different* directory's slug, opening fails instead, with a message naming both slugs.

While a row's session is open, its button turns into `❯ Running` with that agent's icon. Click it to bring the terminal back.

### Start something new: `New Learning Session` / `New Chore Session`

Both buttons sit in the page header, next to `⌕ Search`.

1. Pick the **Agent**: `claude` or `codex` (Codex is preselected).
2. Fill in the title:
   - **Learning Title** is optional.
   - **Chore Title** and **Description** are both required.
3. Choose the **Directory** (Work only). Start typing; devboard suggests up to 20 matching directories under `~/dev`, up to 4 levels deep, skipping `.git`, `node_modules`, `vendor`, `dist` and `build`. Press `Tab` to take the top suggestion, or click one. On the Personal page the directory is fixed to `~/dev/learning-shit`.
4. Click `Open`. `Cancel`, Escape or a click outside closes the dialog.

What happens next depends on the kind:

- **New chore.** devboard writes the chore file right away (`<date>-devboard-<title-slug>.md` in the chores directory) with an index row whose session id is `-`. When the agent is up, it types `/start-chore <title>: <description>. Use existing chore file <path>; do not create a duplicate. …` (`/start-personal-chore` on the Personal page; Codex gets `run /start-chore …`). As soon as the session id is known, it is written into the index row. The popup shows `Chore file: <filename>`.
- **New learning.** Nothing is typed; you write the first prompt. devboard creates a draft "standing handoff file" (`<date>-devboard-<topic>.md` in the learnings directory, with `agent_sessions` front-matter) and shows `Standing handoff file: <filename>`. With a title, the file is created as soon as the session id is known. Without one, it is created after your first prompt and the agent's first reply, and is named after that prompt.

devboard finds the new session's id by watching for a new transcript in that directory (Claude: `~/.claude/projects/<slug>/`; Codex: `~/.codex/sessions/`, matched by working directory). Until then the header shows `new session`.

A new session that isn't tied to a row yet appears as a `❯ Running agent:<id>` button in the page header while minimized.

### The terminal toolbar

The header shows `❯ <title>` and a line `agent · <session id or "new session"> · <directory>`. Then, left to right:

| Control | What it does |
| --- | --- |
| Status | `connecting`, `live`, `exited` or `error`. |
| Activity dot | Shown while `live`. Busy means the agent is working; idle means it is waiting for you. See below. |
| `View file` | Swaps the terminal for the rendered learning or chore file. `Refresh` reloads it, `Terminal` goes back. Disabled until a file is attached. |
| `Environment` | Opens this session's environment (prefixed with its icon). Disabled until `/start-env` has bound one to the session. See [05-environments.md](05-environments.md). |
| `🕸️ Ontology` | Swaps the terminal for this session's code ontology diagram; click `Terminal` to go back. Disabled until `/codont` has created one. See [06-code-ontology.md](06-code-ontology.md). |
| `✎ Design` | Opens the Design window over the terminal. Its buttons type commands into this session, which keeps running underneath. `❯ Terminal` or `Close ✕` returns. Disabled until a learning or chore file is attached. See [07-design.md](07-design.md). |
| `Fullscreen` / `Back` | Toggles fullscreen. |
| `Minimize` | Hides the popup. The agent keeps running. |
| `Close ✕` | Ends the session: the process gets SIGHUP, and 2 seconds later its whole process group gets SIGKILL, so tools and MCP servers it started go too. This is the only way to close the popup. |

Closing a terminal refreshes the tables, since the session may have rewritten files while it was open.

**What drives the busy/idle dot.** The server watches one shared signal file, `~/.claude/hooks/claude-signal`. Notifier hooks (`~/.claude/hooks/claude-notifier-on-*.js`, registered for Claude Code and Codex) overwrite it on every event with a line like `<reason> <timestamp> <session-id> …`. A `prompt` event marks that session busy; `done`, `input` (permission request) and `question` mark it idle. Because the file is shared, the dot is correct even if the event came from the same session running in a normal terminal. A freshly opened terminal always starts idle. Pressing Escape or Ctrl-C while busy flips it to idle right away, because an interrupted turn fires no hook. The same colour shows on the row's `❯ Running` button.

### Running several sessions at once

- Up to 10 terminals can be open at once (`DEVBOARD_MAX_TERMINALS`). Beyond that, opening fails with `at most 10 terminals can be open at once`.
- Only one is on screen at a time. Opening or restoring another minimizes the current one. Minimized sessions keep running.
- Opening a row that is already open brings its terminal forward instead of starting a second copy.
- In fullscreen with more than one terminal open, a tab strip appears across the top. Each tab shows the agent icon, the title and `agent:<short id>`; click to switch.
- When a minimized session finishes a turn (a real busy → idle signal), a notice appears: **<title> is waiting for you**, with `Go to Terminal` and `Close`. Notices disappear when you switch to that terminal by any means, or when it closes.
- Switching between the Work and Personal pages keeps open terminals running.

### Keyboard

Escape and Ctrl-C go to the agent, not the page. That is how you interrupt a turn. Clicking the backdrop around the popup does nothing, so a stray click can't kill a running turn. The footer repeats this: *Escape and Ctrl-C go to the session. Minimize keeps it running; Close ✕ terminates it.*

### Ending a chore from the terminal

A chore terminal shows a permanent amber banner: `⚠ <scope> chore · <file> — running /end-chore here deletes this file and its index row.`

The first time you type `/end-chore` (or `/end-personal-chore`), a notice, **That command ends this chore**, explains what will happen. Click `Got it`. Your keystrokes are never blocked; the agent may still ask you to confirm or offer `/handoff` first.

devboard watches the chore file itself. When it actually disappears, the tables refresh and the popup shows `Chore ended and removed — closing in 10s.` with a `Stay open` button. If you do nothing, the terminal closes and a toast confirms the file was removed. If the file reappears during the countdown, the countdown stops.

### file:line links in the output

References like `server/lib/code.js:42`, `src/app.ts:10:5` or `plan.js:123@92ba3a7` in the agent's output become underlined links, but only after the server confirms the file exists. A reference that stays plain text points at a file that doesn't exist, or one outside the allowed roots. Paths are tried as absolute (with `~` expanded) or relative to the session's directory.

- **Click** opens VS Code at that line. If the file is inside the session's directory, the whole directory opens as the workspace (via the `code` CLI). If the CLI isn't available, it falls back to a `vscode://file/…` link.
- **Alt+click** opens a read-only code peek inside devboard, scrolled to the line. With an `@sha` suffix, the peek shows the file as it was at that commit (`git show`) and the header shows `@ <sha>`. Without one, it shows the current file and says `working tree (unpinned)`. `Open in VS Code` jumps to the editor. `Close`, Escape or a click outside closes the peek.

### Reload and unload protection

Reloading or closing the tab ends every terminal on the board, because the server kills a session when its connection drops. While any terminal is connecting or live, the browser asks you to confirm before leaving the page.

## Where the data lives

| What | Path |
| --- | --- |
| Terminals spawned by the current server (for orphan reaping) | `~/.devboard/terminals.json` |
| Busy/idle signal file (written by your notifier hooks) | `~/.claude/hooks/claude-signal` (`DEVBOARD_AGENT_SIGNAL_FILE`) |
| Claude transcripts used to resume and to find new session ids | `~/.claude/projects/<slug>/<session-id>.jsonl` |
| Codex transcripts | `~/.codex/sessions/**/*.jsonl` |
| Chore files created by `New Chore Session` | the work or personal chores directory, e.g. `~/.agents/data/chores/work/<date>-devboard-<slug>.md` |
| Draft learnings created by `New Learning Session` | the learnings directory, e.g. `~/.agents/data/learnings/work/<date>-devboard-<topic>.md` |

See [02-learnings.md](02-learnings.md) and [03-chores.md](03-chores.md) for the file and index formats.

## Good to know

**Security model.** The server can start an agent with your credentials, so:

- It listens on `127.0.0.1` only.
- The terminal websocket checks the `Origin` header against an allowlist (`DEVBOARD_ALLOWED_ORIGINS`; by default `localhost`/`127.0.0.1` on ports 5177 and the server port).
- Opening a terminal happens in two steps. An HTTP request validates everything and returns a single-use ticket that expires after 30 seconds. The websocket then redeems the ticket. Neither the session id nor a path ever appears in the websocket URL.
- The session id must be a UUID; it is the only value passed to the command. The agent is spawned with an argument list, never through a shell.
- The working directory must be under one of `DEVBOARD_TERMINAL_ROOTS` (default: your home directory). The same roots limit which files the code links and peek can read.

**One process per session.** Opening fails if the session already has a terminal on the board, or if another process on the machine was started to resume it (`… is already running in another terminal (pid …)`). Two agents writing one transcript would corrupt it. If another session merely seems to be running in the same directory, you get a warning instead of a block. A session you switched to with `/resume` inside a plain `claude` can't be detected at all.

**Transcript drift.** If the transcript changes while the board terminal has been quiet for 15 seconds, a warning tells you the session was probably used elsewhere. Close and reopen the terminal to pick up the newer state.

**Idle timeout.** A terminal is closed after `DEVBOARD_TERMINAL_IDLE_MS` (default 30 minutes) with no messages from the browser. The open popup sends a keepalive every 20 seconds and that counts as activity, so in practice this only catches a browser that stopped talking without closing the connection.

**Orphan reaping.** Stopping the server with Ctrl-C or SIGTERM ends all terminals. If the server is killed hard, on next start it reads `~/.devboard/terminals.json` and kills any listed process whose command line still contains its session id, so a recycled pid is never touched. Terminals for brand-new sessions are started without the id on the command line, so they are not reaped this way.

**Busy/idle never changes.** The dot depends on notifier hooks that devboard does not install. Without them, every terminal stays idle and you never get "is waiting for you" notices; everything else works. The server starts watching the signal file at startup, so if the file didn't exist yet, restart devboard after installing the hooks.

**`posix_spawnp failed`.** node-pty's helper binary lost its execute bit. Run `node scripts/fix-node-pty-perms.mjs` (it normally runs on install).

**Wrapped references.** A `file:line` reference split across two terminal rows is not linked. A wider terminal or fullscreen helps.

**Settings that matter here:**

| Env var | Default | Effect |
| --- | --- | --- |
| `DEVBOARD_CLAUDE_BIN` | `claude` | Claude binary to run |
| `DEVBOARD_CODEX_BIN` | `codex` | Codex binary to run |
| `DEVBOARD_TERMINAL_ROOTS` | `$HOME` | `:`-separated directories a terminal may start in |
| `DEVBOARD_MAX_TERMINALS` | `10` | Concurrent terminals |
| `DEVBOARD_TERMINAL_IDLE_MS` | `1800000` | Idle timeout in milliseconds |

The full list is in [08-reference.md](08-reference.md). Setup is in [01-setup.md](01-setup.md).
