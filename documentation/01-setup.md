# Setup

devboard is a local web dashboard over the files your coding agents write: learnings, chores,
environments, code ontologies and design documents. It has two halves. The **dashboard** (this
repo: a Node server and a React UI) shows those files and runs agent sessions in the browser. The
**agent kit** (skills and shared specs under `agent-kit/`) is what makes Claude Code and Codex write
them. You need both, and one script installs both.

## Prerequisites

| Need | Why |
| --- | --- |
| macOS or Linux | the server spawns real terminals (`node-pty`) |
| Node.js **≥ 20.19** (`node -v`) and npm | server and UI build |
| git | cloning, and reading code at pinned commits (Design, code peek, ontology) |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) and/or [Codex CLI](https://github.com/openai/codex) (`codex`) on `PATH` | the agents devboard runs and resumes |
| `ps` and `lsof` (preinstalled on macOS) | the green "Active" dots, i.e. detecting live sessions |

## Install

```bash
git clone git@github.com:Revolyssup/devboard.git ~/dev/devboard
cd ~/dev/devboard
./scripts/install.sh
```

`install.sh` is idempotent, so re-run it after every `git pull`. It does five things:

| Step | Result |
| --- | --- |
| Prerequisites | Checks `node`/`npm`; warns (doesn't fail) if `claude`, `codex`, `lsof` or `ps` is missing. |
| Data directories | Creates `~/.agents/data/{learnings,chores}/{work,personal}` and `~/.agents/data/sessions`. Each one is paired with its legacy `~/.claude/...` path by a symlink, so skills that write either path land in the same place. Seeds empty `index.txt` files. Never moves or deletes existing data. |
| Shared contract | `agent-kit/agents/AGENTS.md` → `~/.agents/AGENTS.md`, and `agent-kit/agents/specs/*.md` → `~/.agents/specs/`. |
| Skills | `agent-kit/claude/skills/*` → `~/.claude/skills/`; `agent-kit/codex/skills/*` → `~/.codex/skills/` (skipped if Codex isn't installed). |
| App | `npm run install:all && npm run build`. |

Flags:

| Flag | Effect |
| --- | --- |
| `--link` | Symlink skills/specs into this checkout instead of copying, so `git pull` alone updates them. Don't move the repo afterwards. |
| `--force` | Replace skill/spec files you've edited locally. The old copy is kept as `*.bak.<timestamp>`. Without it, they're left alone with a warning. |
| `--no-npm` | Agent-side setup only; skip `npm install` and the build. |

**After installing, restart any open Claude/Codex sessions** so they load the new skills.

## Run it

Single port (the server also serves the built UI):

```bash
npm start            # → http://localhost:5178
```

While developing devboard itself (API on :5178, Vite with hot reload on :5177):

```bash
npm run dev          # → http://localhost:5177
```

The server binds to `127.0.0.1` only. It can start agent sessions with your credentials, so it must
never be reachable from the network.

### Keep it running in the background (macOS)

A `launchd` agent starts devboard at login and restarts it if it dies. Save this as
`~/Library/LaunchAgents/devboard.plist`, replacing the two paths with yours (`which node`, and
where you cloned the repo):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>devboard</string>
  <key>WorkingDirectory</key><string>/Users/you/dev/devboard</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>server/index.js</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/devboard.log</string>
  <key>StandardErrorPath</key><string>/tmp/devboard.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/devboard.plist
```

`PATH` must include where `claude`, `codex`, `git` and `lsof` live; launchd doesn't read your shell
profile. To restart after pulling new server code, kill the process (`kill $(lsof -ti:5178 -sTCP:LISTEN)`)
and launchd starts it again. UI-only changes need just `npm run build` and a page reload.

## Check that it works

1. Open http://localhost:5178. You see **Work** and **Personal** in the sidebar.
2. In any repo, run `claude` and type `/start-chore fix the flaky test in foo`
   (in Codex: `run /start-chore fix the flaky test in foo`).
3. Within about 10 seconds it appears under **Work → Active chores**.
4. Click **❯ Run** on that row: the same session opens in a terminal inside the browser.

## Updating

```bash
git pull
./scripts/install.sh       # new/changed skills and specs, deps, rebuild
```

Then restart the server if server code changed, reload the page, and restart open agent sessions
if skills changed.

## What's included, and what isn't

Everything in the table below works after `install.sh`:

| Feature | Doc |
| --- | --- |
| Work / Personal learnings tables, search, read/edit/delete | [02-learnings.md](02-learnings.md) |
| Active chores | [03-chores.md](03-chores.md) |
| Agent sessions in the browser | [04-agent-sessions.md](04-agent-sessions.md) |
| ✎ Design: prose → facts, flags, targets, verified at runtime | [07-design.md](07-design.md) |

Two features need skills that are **not** shipped in `agent-kit/`. The dashboard side is there, but
you have to install those skills separately:

| Feature | Needs | Doc |
| --- | --- | --- |
| Environments | `/start-env`, `/end-env`, and a recipe catalog under `~/.agents/environments/meta/` | [05-environments.md](05-environments.md) |
| Code Ontology | `/codont` | [06-code-ontology.md](06-code-ontology.md) |

The **busy / idle dot** on a session terminal is driven by notifier hooks (`~/.claude/hooks/claude-notifier-on-*.js`,
writing `~/.claude/hooks/claude-signal`) that aren't shipped either. Without them every terminal
shows idle; everything else works. See [04-agent-sessions.md](04-agent-sessions.md).

The **Learning Progress Report** button and the richer columns of the Personal learnings table read
files from a separate personal-practice workflow that isn't part of this kit. Without it they show
their empty state; Personal *chores* work fully. See [02-learnings.md](02-learnings.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `posix_spawnp failed` when opening a terminal | `node scripts/fix-node-pty-perms.mjs` (normally runs on `postinstall`). |
| A skill doesn't show up in `/` autocomplete | Restart the agent session. Check `ls ~/.claude/skills/<name>/SKILL.md`. |
| Install warns "exists and differs" | You already have a skill by that name. Diff it against `agent-kit/` and re-run with `--force` if you want the packaged one. |
| Active dots never go green | `lsof` must be on the server process's `PATH` (watch out for launchd). |
| A button gives `404` after `git pull` | The UI was rebuilt but the server is still the old process. Restart the server. |
| Two `~/.agents/data/...` and `~/.claude/...` directories that aren't linked | `install.sh` warns and won't touch them. Merge them by hand, then symlink one to the other. |

All configuration (ports, paths, binaries) is by environment variable. See
[08-reference.md](08-reference.md#configuration).
