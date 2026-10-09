# Reference

This page lists what the other pages assume: every environment variable the server and scripts
read, every HTTP route, every file devboard reads or writes, what `agent-kit/` ships, and how the
repo is laid out for development. Everything here was checked against the code on `master`. For a
guided introduction, start with [Setup](01-setup.md).

## Configuration

All configuration is through environment variables. None are required; the defaults suit a single
user on macOS. Set them in the shell that runs `npm start` / `npm run dev`.

### Server

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `5178` | Port the API (and, after `npm run build`, the UI) listens on. Also feeds the default `DEVBOARD_ALLOWED_ORIGINS`. |
| `DEVBOARD_DATA_ROOT` | `~/.agents/data` | Root for the canonical learnings, chores and `sessions/index.jsonl` paths below. |
| `DEVBOARD_WORK_DIR` | `<data root>/learnings/work` if it exists, else `~/.claude/learnings` | Work learnings directory. |
| `DEVBOARD_PERSONAL_DIR` | `<data root>/learnings/personal` if it exists, else `~/.claude/personal/learnings` | Personal learnings directory. |
| `DEVBOARD_CHORES_DIR` | `<data root>/chores/work` if it exists, else `~/.claude/chores` | Work chores directory. |
| `DEVBOARD_PERSONAL_CHORES_DIR` | `<data root>/chores/personal` if it exists, else `~/.claude/personal/chores` | Personal chores directory. |
| `DEVBOARD_REPORTS_DIR` | `~/dev/learning-shit/reports` | Where the Learning Progress Report button looks for the newest `*.html`. |
| `DEVBOARD_ACTIVE_WINDOW_MS` | `900000` (15 min) | A session counts as active only if its transcript changed within this window (and a matching agent process is running in its directory). |
| `DEVBOARD_CLAUDE_BIN` | `claude` | Binary a terminal runs for Claude (`<bin> --resume <id>`, or no args for a new session). |
| `DEVBOARD_CODEX_BIN` | `codex` | Binary a terminal runs for Codex (`<bin> resume <id>`, or no args). |
| `DEVBOARD_TERMINAL_ROOTS` | `$HOME` | `:`-separated list. A terminal's working directory must resolve under one of these. Code links (resolve, peek, open) use the same allowlist. |
| `DEVBOARD_MAX_TERMINALS` | `10` | Maximum concurrent browser terminals. |
| `DEVBOARD_TERMINAL_IDLE_MS` | `1800000` (30 min) | Idle timeout for a terminal. |
| `DEVBOARD_AGENT_SIGNAL_FILE` | `~/.claude/hooks/claude-signal` | File watched for agent hook events (busy / waiting state of a terminal). See [Data layout](#data-layout). |
| `DEVBOARD_ALLOWED_ORIGINS` | `http://localhost:<PORT>,http://127.0.0.1:<PORT>,http://localhost:5177,http://127.0.0.1:5177` | Comma-separated `Origin` allowlist for websocket upgrades (terminal and environment run log). |
| `DEVBOARD_CODE_BIN` | first of `/opt/homebrew/bin/code`, `/usr/local/bin/code`, else `code` | Editor CLI used by "open in editor" on a code link (`code <folder> --goto file:line:col`). |
| `DEVBOARD_ENV_ROOT` | `~/.agents/environments` | Environment state: instances, session bindings, runs, probe cache. |
| `DEVBOARD_ENV_META` | `<env root>/meta` | Environment recipe catalog (`<id>/recipe.yaml`). |
| `DEVBOARD_CODONT_ROOT` | `~/.agents/codont` | Code Ontology store. |
| `DEVBOARD_DESIGN_RUN_TIMEOUT_MS` | `1800000` (30 min) | Time limit for one Design `verify.sh` run. |

Fixed values that are not configurable: the terminal ticket lives 30 seconds; the live-process scan
is cached for 5 seconds; the server always binds to `127.0.0.1`.

### UI dev server and scripts

| Variable | Read by | Default | What it does |
| --- | --- | --- | --- |
| `DEVBOARD_API` | `web/vite.config.ts` | `http://localhost:5178` | Where the Vite dev server (port 5177) proxies `/api` (including websockets) and `/reports`. |
| `DEVBOARD_BROWSER` | `verify-ui`, `verify-extras`, `verify-personal-chores`, `verify-mutations`, `verify-terminal` | Brave at `/Applications/Brave Browser.app/...` | Chromium-based browser binary for puppeteer. |
| `SHOTS` | `verify-ui`, `verify-extras`, `verify-personal-chores`, `verify-mutations` | `/tmp/devboard-shots` | Screenshot output directory. |
| `DEVBOARD_VERIFY_PORT` | `verify-terminal`, `verify-code`, `verify-codont` | `5179`, `5187`, `5189` | Port for the suite's own server. |
| `DEVBOARD_TEST_SESSION` | `verify-mutations` | `-` | A live session id; when set, the suite also asserts the green Active dot. |
| `DEVBOARD_SHOT` | `verify-terminal` | unset | Optional screenshot path for one terminal check. |
| `DEVBOARD_FAKE_*` | `scripts/fake-claude.sh` | unset | Knobs for the stand-in agent used by `verify-terminal` (`NEW_TRANSCRIPT`, `NEW_SESSION_ID`, `CLEAR_SCREEN`, `CHORE_FILE`, `CHORE_INDEX`). |

## HTTP API

The server listens on **127.0.0.1 only** (port `PORT`, default 5178). It can start agent sessions
with your credentials, so it is never reachable from the network. Websocket upgrades are also
checked against `DEVBOARD_ALLOWED_ORIGINS`.

Errors come back as a normal HTTP status with JSON `{ "error": "...", "code"?: "..." }`. When
`web/dist` exists, the server also serves the built UI and falls back to `index.html` for any path
not under `/api` or `/reports`.

In the tables, `:scope` is `work` or `personal`, and a "design key" is either `ref`
(`<scope>/<learning|chore>/<file>.md`) or the three fields `scope`, `kind`, `filename`.

### Server (`server/index.js`)

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/api/health` | Resolved data paths and a live-session snapshot. Not used by the UI. | — |
| GET (Upgrade) | `/api/terminal` | Terminal websocket. Binary frames are raw PTY bytes; text frames are control messages. | `ticket` (from `POST /api/terminal`) |
| GET (Upgrade) | `/api/env/stream` | Read-only websocket that streams an environment run's events. Messages from the client are ignored. | `run` (run id) |

### Learnings (`server/routes/learnings.js`, mounted at `/api/learnings`)

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/:scope` | Paginated list, newest edit first. | `page`, `pageSize` (10), `sort` = `mtime` \| `title` \| `filename` |
| GET | `/:scope/search` | Fuzzy search, best match first. | `q`, `page`, `pageSize` |
| GET | `/:scope/file/:filename` | Full markdown of one learning. | — |
| PUT | `/:scope/file/:filename` | Save edited content to disk. | body `{ content }` |
| DELETE | `/:scope/file/:filename` | Delete the file, and for `work` also its `index.txt` row. | — |

### Chores (`server/routes/chores.js`, mounted at `/api/chores`)

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/:scope` | Active chores, latest update first, optionally filtered. | `page`, `pageSize`, `q` |
| GET | `/:scope/file/:filename` | Full markdown of one chore. | — |
| PUT | `/:scope/file/:filename` | Overwrite the chore file. | body `{ content }` |
| DELETE | `/:scope/file/:filename` | Delete the file and its `index.txt` row (same effect as `/end-chore`). | — |

### Reports (`server/routes/reports.js`)

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/api/reports/progress` | Returns `learning-report.md` from the personal learnings directory if it exists, else the newest HTML in `DEVBOARD_REPORTS_DIR`, else 404. | — |
| GET | `/reports/file/:name` | Serves one `.html` report from `DEVBOARD_REPORTS_DIR` (basename only). | — |

### Terminal (`server/routes/terminal.js`, mounted at `/api/terminal`)

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| POST | `/` | Preflight for resuming a row's session: validate, reserve the session, return a single-use ticket for the websocket. | body `scope`, `kind` (`learning` \| `chore`), `agent` (`claude` \| `codex`), `filename`, `sessionId`, `directory`, `cols`, `rows` |
| POST | `/new` | Preflight for a new session, optionally creating a draft learning or chore for it. | body `scope`, `agent`, `directory`, `newKind` (`learning` \| `chore`), `filename`, `title`, `learningTitle`, `choreTitle`, `choreDescription`, `cols`, `rows` |
| GET | `/directories` | Directory suggestions under `~/dev` for the new-session dialog. | `q` |
| GET | `/status` | Open terminals and the cap. Not used by the UI. | — |

### Code links (`server/routes/code.js`, mounted at `/api/code`)

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| POST | `/resolve` | Batch-check which `path[:line]` candidates in terminal output are real files. | body `cwd`, `candidates[]` (max 64) |
| GET | `/peek` | File content for the peek overlay, at a git ref or the working tree. | `cwd`, `path`, `ref` (optional) |
| POST | `/open` | Open the file in the editor, using `cwd` as the workspace when the file is inside it. | body `cwd`, `path`, `line`, `col` |

### Environments (`server/routes/env.js`, mounted at `/api/env`)

See [Environments](05-environments.md). Routes marked *agent* are called by the environment skills
or other tools, not by the UI.

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/layers` | The recipe catalog (id, kind, parents, claims, params, …). *agent* | — |
| GET | `/layers/:id/defaults` | Default params for one recipe. *agent* | — |
| GET | `/tree` | Probe and render one session's environment chain (all recipes if `session` is omitted). | `session`, `fresh=1` to skip the probe cache |
| POST | `/probe/:layer` | Probe one recipe and refresh its cache entry. | body `session` |
| POST | `/tree/refresh` | Drop cached probe results for a session's chain. | body `session` |
| GET | `/resources/:layer` | Configs a recipe manages, and whether the cluster has drifted. | `session` |
| GET | `/resources/:layer/show` | YAML for one config (live if present, else the rendered file). | `id`, `session` |
| POST | `/plan` | Build a plan to reach a target. Never executes. | body `target`, `params`, `via` |
| POST | `/run` | Execute a plan (re-derived on the server) and, unless `rebind: false`, bind it to the session. | body `target`, `params`, `via`, `session`, `agent`, `directory`, `confirmDestructive`, `rebind` |
| POST | `/teardown/plan` | Preview a teardown of a target and everything live on top of it. | body `target` |
| POST | `/teardown` | Execute a teardown; destructive steps need `confirmDestructive`. | body `target`, `session`, `agent`, `directory`, `confirmDestructive` |
| GET | `/runs` | Recent runs (in memory and on disk). *agent* | — |
| GET | `/runs/current` | The run in progress, if any. *agent* | — |
| GET | `/runs/:id` | One run's record. | — |
| POST | `/runs/:id/abort` | Abort a run. | — |
| GET | `/instances` | All recorded instances. *agent* | — |
| GET | `/sessions` | Which sessions have an environment (file reads only, no probing). Drives the Env button on rows. | — |
| POST | `/bind` | Bind an environment target to a session. *agent* (`/start-env`) | body `session`, `target`, `instructions`, `via`, `params`, `agent`, `directory` |
| DELETE | `/bind/:session` | Remove a session's binding. *agent* | — |
| POST | `/end` | End a session's environment: release its leases and remove its binding. Destroys nothing. *agent* (`/end-env`) | body `session` |
| POST | `/instances/:id/release` | Release one session's lease on an instance. *agent* | body `session` |

### Code Ontology (`server/routes/codont.js`, mounted at `/api/codont`)

See [Code Ontology](06-code-ontology.md). The session's own agent writes the diagram through
`/start` and `/update`; the UI only reads.

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/sessions` | Sessions that have an ontology. | — |
| POST | `/start` | Create the ontology and its working-tree tab, plus an env-version tab when the session's environment pins this repo to a different commit. *agent* | body `session`, `instruction`, `cwd` |
| GET | `/state` | Everything the view needs: binding, context, journal, tabs with their ontology and status. | `session` |
| POST | `/update` | Merge (default) or replace nodes and edges in a tab; returns anchors moved, edges dropped and verification failures. *agent* | body `session`, `tabId`, `mode` (`replace`), `nodes[]`, `edges[]`, `context`, `note` |
| POST | `/tab` | Create an empty tab pinned to a ref, for comparing versions. | body `session`, `ref` |
| GET | `/branches` | Branch and tag suggestions for the compare popup. | `session`, `q` |

### Design (`server/routes/design.js`, mounted at `/api/design`)

See [Design](07-design.md). Every route takes a design key; item routes also take `item` (`F-7`) or
`n` (`7`).

| Method | Path | Purpose | Key params |
| --- | --- | --- | --- |
| GET | `/list` | All designs across learnings and chores. | — |
| POST | `/open` | Create the design folder if missing; return its binding. | key, body `repo` |
| GET | `/state` | Prose, items, runs and request state (404 if no design yet). | key |
| PUT | `/doc` | Save the prose. Only the editor calls this. | key, body `content` |
| POST | `/items` | Create facts, flags or targets. *agent* | key, body `items[]`, `note` |
| POST | `/item/update` | Patch one item. *agent* | key, item, body `patch`, `note` |
| POST | `/item/remove` | Remove an item (moved to `removed/`). | key, item |
| POST | `/item/retire` | Retire an item the prose no longer supports (during re-derive). *agent* | key, item, body `reason` |
| POST | `/request` | Set or clear the spinner state for a design-wide or per-item request. | key, optional item, body `action` (null clears), `scope` |
| POST | `/run` | Start the item's `verify.sh`. | key, item, body `mode` (`normal` \| `control`), `unfreeze`, `reason`, `label` |
| GET | `/run` | Poll a run; `wait=<seconds>` long-polls (capped at 9 minutes). *agent* | key, item, `runId`, `wait` |
| GET | `/file` | Read a file inside an item's folder (for example a run log). | key, item, `path` |
| GET | `/diff` | The item's code diff (base vs head). | key, item |

## Data layout

devboard keeps no database. Everything it shows is a file that an agent skill or devboard itself
wrote. Paths below are defaults; see [Configuration](#configuration) to move them.

### `~/.agents`

| Path | Read / write | What it is |
| --- | --- | --- |
| `~/.agents/data/learnings/work/*.md` | read, edit, delete, create drafts | Work learnings. Optional `agent_sessions` front-matter. See [Learnings](02-learnings.md). |
| `~/.agents/data/learnings/work/index.txt` | read, append, remove rows | `Learning \| Filename \| Session ID(s) \| Directory \| Last Updated`. Supplies the summary, keywords and session ids. A delete removes the row. |
| `~/.agents/data/learnings/personal/*.md` | read, edit, delete, create drafts | Personal learnings. YAML front-matter: `date`, `track`, `subtype`, `topic`, `outcome`, `confidence`, `mode`, `hints_used`, `session_id`, `directory`, optional `struggled_with` / `comfortable_with` and `agent_sessions`. |
| `~/.agents/data/learnings/personal/index.txt` | read, append | `date \| track \| subtype \| topic \| outcome \| confidence \| mode \| hints_used`. It has no filename column, so rows are matched to files by `date` + `topic`. A delete does not touch it. |
| `~/.agents/data/learnings/personal/learning-report.md` | read | If present, the progress report button renders it instead of the newest HTML report. |
| `~/.agents/data/learnings/*/STEERING.md`, `MEMORY.md` | ignored | Never listed as learnings. |
| `~/.agents/data/chores/{work,personal}/*.md` | read, edit, delete, create drafts | Chore files with *What is done* / *What is happening* / *What is pending*. See [Chores](03-chores.md). |
| `~/.agents/data/chores/{work,personal}/index.txt` | read, append, remove rows | `Chore \| Filename \| Session ID \| Directory \| Started`. |
| `~/.agents/data/sessions/index.jsonl` | append | One JSON line per draft learning or chore created for a new browser session. |
| `~/.agents/environments/meta/<id>/recipe.yaml` | read | Environment recipes (`layer.yaml` also accepted; `meta/lib/` is shared helpers, skipped). Not shipped with devboard. See [Environments](05-environments.md). |
| `~/.agents/environments/instances/<id>.json` | read, write | What exists on this machine, with leases. |
| `~/.agents/environments/sessions/<session>.json` | read, write | A session's environment binding (target, params, via, agent, directory). |
| `~/.agents/environments/runs/<id>/run.json` | write | Record of each plan or teardown run. |
| `~/.agents/environments/.cache/probes.json` | read, write | Probe result cache. |
| `~/.agents/codont/<session>/` | read, write | One Code Ontology: `binding.json`, `context.md`, `journal.md`, `tabs.json`, `tabs/<id>/ontology.json`, `tabs/<id>/status.json`. See [Code Ontology](06-code-ontology.md). |
| `~/.agents/AGENTS.md`, `~/.agents/specs/*.md` | not read by the server | Shared contract and specs installed by `install.sh` for the agents. |

The legacy paths `~/.claude/learnings`, `~/.claude/personal/learnings`, `~/.claude/chores` and
`~/.claude/personal/chores` are the same directories: `install.sh` symlinks each pair. If a
canonical `~/.agents/data/...` directory does not exist, the server falls back to the legacy path.

### Design folders

Each learning or chore can have a design folder next to it, named after the file:
`<dir>/<file>.design/` (for `2026-01-01-foo.md`, the folder is `2026-01-01-foo.design/`).

| Path inside `<file>.design/` | What it is |
| --- | --- |
| `binding.json` | Which file and repo the design belongs to. |
| `design.md` | Your prose. Written only by the editor (`PUT /api/design/doc`). |
| `journal.md` | Log of agent changes. |
| `items/<n>/item.json` | One fact, flag or target. |
| `items/<n>/verify.sh` | The item's runtime check, run by the server with `bash` (plus `--control` in control mode). Env: `OUT`, `DESIGN_ITEM`, `DESIGN_REPO`, `DESIGN_SHA`, `DESIGN_MODE`. |
| `items/<n>/runs/<id>/` | `run.json`, `log.txt`, and `sentinel/` (the script's `$OUT`). |
| `removed/<n>-<timestamp>/` | Items removed or retired. |

### `~/.claude`, `~/.codex`, `~/.devboard`

| Path | Read / write | What it is |
| --- | --- | --- |
| `~/.claude/projects/<slug>/<session-id>.jsonl` | read | Claude transcripts. Used for Active dots and to detect the session a new terminal started. |
| `~/.codex/sessions/**/*.jsonl` | read | Codex rollouts, same purposes. |
| `~/.codex/session_index.jsonl` | read | Codex session index. |
| `~/.claude/hooks/claude-signal` | read (watched) | One line, overwritten on each agent hook event (`<reason> <ts> <sessionId> ...`). Gives a terminal its busy / waiting state. It is written by your own hook scripts (`~/.claude/hooks/claude-notifier-on-*.js`), which devboard does not ship; without them the file simply never changes. |
| `~/.claude/skills/<name>/SKILL.md`, `~/.codex/skills/<name>/SKILL.md` | not read by the server | Installed by `install.sh`. |
| `~/.devboard/terminals.json` | read, write | Terminals the server spawned. On startup it kills any left over from a previous server (only if the pid's command line still names that session), then resets the file. |
| `~/dev/learning-shit/reports/*.html` | read | Progress reports (`DEVBOARD_REPORTS_DIR`). |

## Agent skills and specs

`agent-kit/` is the source of truth. `scripts/install.sh` copies each file into place (or, with
`--link`, symlinks it). It leaves an existing file that differs alone unless you pass `--force`,
which first backs it up as `*.bak.<timestamp>`. `--no-npm` skips `npm run install:all` and
`npm run build`.

| In `agent-kit/` | Installed to | What it is |
| --- | --- | --- |
| `agents/AGENTS.md` | `~/.agents/AGENTS.md` | Shared data contract every skill reads first. |
| `agents/specs/handoff.md` | `~/.agents/specs/` | Learning file and index format. |
| `agents/specs/start-chore.md`, `end-chore.md` | `~/.agents/specs/` | Chore file and index format, create and close. |
| `agents/specs/design-facts.md` | `~/.agents/specs/` | Design window contract. |
| `agents/specs/design-agent.md` | `~/.agents/specs/` | The procedure any agent follows for `/design` and `/verify-fact`. |
| `claude/skills/start-chore`, `end-chore` | `~/.claude/skills/` | Work chores. |
| `claude/skills/start-personal-chore`, `end-personal-chore` | `~/.claude/skills/` | Personal chores. |
| `claude/skills/resume-chore` | `~/.claude/skills/` | Continue an existing chore file without creating a duplicate. |
| `claude/skills/handoff` | `~/.claude/skills/` | Write or update a work learning and its index row. |
| `claude/skills/learn-from-past` | `~/.claude/skills/` | Read relevant learnings back into a session via the index. |
| `claude/skills/design`, `verify-fact` | `~/.claude/skills/` | Thin pointers to `design-agent.md`; typed by the Design window's buttons. |
| `codex/skills/agent-memory` | `~/.codex/skills/` | Handoff and chore workflows for Codex. |
| `codex/skills/design`, `verify-fact` | `~/.codex/skills/` | Same Design pointers for Codex. |

Codex skills are installed only if `codex` is on `PATH` or `~/.codex` exists. `install.sh` also
creates the data directories, symlinks each canonical / legacy pair, creates
`~/.agents/data/sessions`, and seeds empty `index.txt` files with their headers.

### Used by devboard but not shipped

These skills appear in devboard's UI and messages but are not in `agent-kit/`. The features that
depend on them stay empty until you provide your own.

| Skill | Used for | Also missing |
| --- | --- | --- |
| `start-env` | Building or reusing a session's environment and binding it (`POST /api/env/bind`, `/api/env/run`). | The recipe catalog in `~/.agents/environments/meta/` and the spec `~/.agents/specs/environments.md`. |
| `end-env` | Ending a session's environment (`POST /api/env/end`). | — |
| `codont` | Building a Code Ontology (`POST /api/codont/start`, `/update`). | The spec `~/.agents/specs/codont.md`. |

The progress report also expects files from a personal practice framework (`/progress-in-learning-shit`)
that is not part of the kit.

## Development

### Repo layout

| Path | What it holds |
| --- | --- |
| `server/index.js` | Express app, route mounting, websocket upgrade handling, static UI, binding to 127.0.0.1. |
| `server/config.js` | All paths and server settings (see [Configuration](#configuration)). |
| `server/routes/` | One router per feature: `learnings`, `chores`, `reports`, `terminal`, `code`, `env`, `codont`, `design`. |
| `server/lib/` | Feature logic: `learnings`, `chores`, `indexes` (index.txt parsing), `markdown`, `search`, `sessions` (live-session detection via `ps`, `lsof`, transcript times), `terminals` (PTYs, tickets, reaper), `code`, `codont`, `design`, `env/` (catalog, plan, probe, executor, instances, claims, probe cache). |
| `web/` | Vite + React + TypeScript UI (`web/src`). Builds to `web/dist`. |
| `scripts/` | `install.sh`, `envctl.mjs`, `fix-node-pty-perms.mjs`, `fake-claude.sh`, and the `verify-*.mjs` suites. |
| `agent-kit/` | Skills and specs installed by `install.sh`. |
| `documentation/` | These pages. |

### npm scripts

| Command | What it does |
| --- | --- |
| `npm run install:all` | `npm install` at the root and in `web/`. |
| `npm run dev` | API with `node --watch` on :5178 and the Vite dev server on :5177 (open :5177). |
| `npm run build` | Builds the UI into `web/dist` (`tsc -b && vite build`). |
| `npm start` | `node server/index.js`; serves the API and, if built, the UI on :5178. |
| `npm run verify` | Runs all eight suites in order: ui, extras, personal-chores, mutations, terminal, env, code, codont. |
| `npm run env -- <cmd>` | `scripts/envctl.mjs`, a dry-run CLI for environments: `probe [layer]`, `plan <target> [k=v ...]`, `layers`, `teardown <target>` (plan only). Options `--json`, `--via <layer>`. Never executes anything. |
| `postinstall` | Runs `scripts/fix-node-pty-perms.mjs`, which restores the execute bit on node-pty's `spawn-helper` (without it every terminal fails with `posix_spawnp failed`). |

`web/package.json` also has `dev`, `build` and `preview` for the UI on its own.

### Verify suites

The browser suites use `puppeteer-core` with the browser in `DEVBOARD_BROWSER`. Some suites need a
devboard already running on :5178 with a fresh `npm run build`; others start their own server.

| Suite | Server | What it checks | Touches real data? |
| --- | --- | --- | --- |
| `verify-ui.mjs` | live :5178 | Every view renders, screenshots, no console errors. | Reads only. |
| `verify-extras.mjs` | live :5178 | Progress report, standalone search tab, pagination, chore search. | Reads only. |
| `verify-personal-chores.mjs` | live :5178 | Personal chores panel is independent of Work; delete removes file and index row. | Seeds and deletes its own scratch chore. |
| `verify-mutations.mjs` | live :5178 | Edit, save, on-disk change; delete removes file and index row; optional Active dot. | Seeds and deletes its own scratch learning. |
| `verify-terminal.mjs` | own server on :5179 (`fake-claude.sh` as both agent binaries) | Preflight rejections, PTY round trip, resize, teardown, browser terminal. | Writes fixtures under `~/.devboard-verify` and into the real `~/.claude/personal/chores` and `~/.claude/projects`, then restores them; asserts work chores are unchanged. Env and codont state go to `~/.devboard-verify`. |
| `verify-env.mjs` | none (imports `server/lib/env` directly) | Planner and claim-conflict engine against stubbed probes. | Reads the real recipe catalog (`~/.agents/environments/meta`), so it fails without one. Writes only to a temp dir. |
| `verify-code.mjs` | own server on :5187 | Code-link matcher (imports `web/src/lib/codeRefs.ts` directly) and the resolve / peek endpoints. | No; temp dir with a throwaway git repo. |
| `verify-codont.mjs` | own server on :5189 | Code Ontology over HTTP, including per-tab anchor verification. | No; temp dirs. |

Because `npm run verify` chains the suites with `&&`, the first failing suite stops the rest.
