#!/usr/bin/env bash
# One-shot setup for devboard: agent skills, shared contract, data directories, npm deps, build.
#
#   ./scripts/install.sh            # install everything (safe to re-run)
#   ./scripts/install.sh --link     # symlink skills/specs into this checkout, so `git pull` updates them
#   ./scripts/install.sh --force    # overwrite locally modified skills/specs (old copy kept as *.bak.<ts>)
#   ./scripts/install.sh --no-npm   # skip npm install + build (agent-side setup only)
#
# Never deletes or moves existing learnings/chores. Existing files that differ from the packaged
# version are left alone unless --force is passed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$REPO/agent-kit"
MODE=copy FORCE=0 NPM=1
for arg in "$@"; do
  case "$arg" in
    --link) MODE=link ;;
    --force) FORCE=1 ;;
    --no-npm) NPM=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

TS="$(date +%Y%m%d%H%M%S)"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- 1. prerequisites -------------------------------------------------------------------------
step "Prerequisites"
command -v node >/dev/null || { echo "node is required (>= 20.19). Install it first." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "node >= 20.19 required, found $(node -v)" >&2; exit 1; }
ok "node $(node -v)"
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
for bin in claude codex lsof ps; do
  case "$bin" in
    claude) why="running/resuming Claude Code sessions from the dashboard" ;;
    codex)  why="Codex sessions (optional)" ;;
    *)      why="green 'Active' dots (live-session detection)" ;;
  esac
  if command -v "$bin" >/dev/null; then ok "$bin found"; else warn "$bin not on PATH — needed for $why"; fi
done

# --- 2. data directories ----------------------------------------------------------------------
# Canonical paths live under ~/.agents/data; the skills also write via the legacy ~/.claude paths.
# Both must resolve to the same directory, so one of each pair is a symlink to the other.
step "Data directories"
link_pair() { # $1 = canonical (~/.agents/data/...), $2 = legacy (~/.claude/...)
  local canon="$1" legacy="$2"
  mkdir -p "$(dirname "$canon")" "$(dirname "$legacy")"
  if [ -e "$canon" ] && [ -e "$legacy" ]; then
    if [ "$(cd "$canon" && pwd -P)" = "$(cd "$legacy" && pwd -P)" ]; then ok "$canon ⇄ $legacy"
    else warn "$canon and $legacy are two separate directories — merge them by hand, then symlink one to the other"; fi
  elif [ -e "$legacy" ]; then ln -s "$legacy" "$canon"; ok "$canon → $legacy"
  elif [ -e "$canon" ]; then ln -s "$canon" "$legacy"; ok "$legacy → $canon"
  else mkdir -p "$legacy"; ln -s "$legacy" "$canon"; ok "created $legacy (+ $canon link)"; fi
}
link_pair "$HOME/.agents/data/learnings/work"     "$HOME/.claude/learnings"
link_pair "$HOME/.agents/data/learnings/personal" "$HOME/.claude/personal/learnings"
link_pair "$HOME/.agents/data/chores/work"        "$HOME/.claude/chores"
link_pair "$HOME/.agents/data/chores/personal"    "$HOME/.claude/personal/chores"
mkdir -p "$HOME/.agents/data/sessions"

seed_index() { # $1 = file, $2 = header
  if [ ! -f "$1" ]; then printf '%s\n' "$2" > "$1"; ok "seeded $1"; fi
}
seed_index "$HOME/.agents/data/learnings/work/index.txt"     'Learning | Filename | Session ID(s) | Directory | Last Updated'
seed_index "$HOME/.agents/data/learnings/personal/index.txt" 'date | track | subtype | topic | outcome | confidence | mode | hints_used'
seed_index "$HOME/.agents/data/chores/work/index.txt"        'Chore | Filename | Session ID | Directory | Started'
seed_index "$HOME/.agents/data/chores/personal/index.txt"    'Chore | Filename | Session ID | Directory | Started'

# --- 3. shared contract + skills --------------------------------------------------------------
place() { # $1 = source file in the kit, $2 = destination
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ "$MODE" = link ]; then
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then ok "${dst/#$HOME/~} (linked)"; return; fi
  elif [ -f "$dst" ] && [ ! -L "$dst" ] && cmp -s "$src" "$dst"; then ok "${dst/#$HOME/~} (up to date)"; return; fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    if [ "$FORCE" -ne 1 ]; then warn "${dst/#$HOME/~} exists and differs — kept yours (re-run with --force to replace)"; return; fi
    mv "$dst" "$dst.bak.$TS"; warn "backed up ${dst/#$HOME/~} → .bak.$TS"
  fi
  if [ "$MODE" = link ]; then ln -s "$src" "$dst"; else cp "$src" "$dst"; fi
  ok "${dst/#$HOME/~}"
}

step "Shared agent contract (~/.agents)"
place "$KIT/agents/AGENTS.md" "$HOME/.agents/AGENTS.md"
for f in "$KIT"/agents/specs/*.md; do place "$f" "$HOME/.agents/specs/$(basename "$f")"; done

step "Claude Code skills (~/.claude/skills)"
for d in "$KIT"/claude/skills/*/; do
  name="$(basename "$d")"; place "${d%/}/SKILL.md" "$HOME/.claude/skills/$name/SKILL.md"
done

step "Codex skills (~/.codex/skills)"
if command -v codex >/dev/null || [ -d "$HOME/.codex" ]; then
  for d in "$KIT"/codex/skills/*/; do
    name="$(basename "$d")"; place "${d%/}/SKILL.md" "$HOME/.codex/skills/$name/SKILL.md"
  done
else
  warn "codex not installed — skipped (re-run this script after installing it)"
fi

# --- 4. app dependencies + build --------------------------------------------------------------
if [ "$NPM" -eq 1 ]; then
  step "npm install + build"
  (cd "$REPO" && npm run install:all && npm run build)
  ok "built web/dist"
fi

step "Done"
echo "  Start the dashboard:   cd $REPO && npm start      → http://localhost:5178"
echo "  Restart any running Claude/Codex sessions so they pick up the new skills."
