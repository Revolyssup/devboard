#!/usr/bin/env bash
# Shared helpers for recipe setup.sh / teardown.sh scripts. Sourced, never run directly.
#
# Unlike probes, these mutate. Rules (see ~/.agents/specs/environments.md):
#   - log what you are about to do: the run log is streamed to a human
#   - exit non-zero on failure; the executor marks the step failed and stops the plan
#   - be idempotent: setup may be re-run after a partial failure, or as a REPAIR
#   - exiting 0 is a claim, not proof: the executor re-probes afterwards and only the probe decides
#     (healthy after setup, absent after teardown)
#   - teardown must exit non-zero if anything it owns is still there
#
# The executor runs scripts with /bin/bash (3.2 on macOS) from the recipe's own directory.
# No mapfile/readarray, no `declare -A`, no ${var^^}: use `collect` below for arrays.

set -uo pipefail

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die()  { printf '[fail] %s\n' "$*" >&2; exit 1; }

# Echo a command before running it, so the log shows exactly what happened.
run() {
  printf '  $ %s\n' "$*"
  "$@"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool '$1' not on PATH"
}

# Same mapping as the probe side: ENV_PARAM_<NAME upper-cased, '-' -> '_'>.
#   param <name> [default]
param() {
  local name="$1" def="${2:-}" var
  var="ENV_PARAM_$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')"
  printf '%s' "${!var:-$def}"
}

# Portable replacement for `mapfile -t ARR < <(cmd)`, which does not exist in bash 3.2.
# Its absence is a runtime "command not found" that does NOT abort the script, so the array
# silently stays empty and a delete loop quietly does nothing. Use this instead.
#   collect ARRNAME cmd args...
collect() {
  local __arr="$1"; shift
  local __line
  eval "$__arr=()"
  while IFS= read -r __line || [[ -n "$__line" ]]; do
    [[ -n "$__line" ]] || continue
    eval "$__arr+=(\"\$__line\")"
  done < <("$@" 2>/dev/null)
}

# wait_for <seconds> <description> <command...>   -> 0 once the command succeeds
wait_for() {
  local secs="$1" what="$2"; shift 2
  local deadline=$((SECONDS + secs))
  log "waiting for ${what} (up to ${secs}s)"
  while true; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    (( SECONDS >= deadline )) && { warn "timed out waiting for ${what}"; return 1; }
    sleep 3
  done
}

# --- conventions shared by the example recipes (keep in sync with probe-lib.sh) -----------------

KIND_PREFIX="${ENV_KIND_PREFIX:-devboard}"

kubeconfig_for() { printf '%s/.kube/%s-%s' "$HOME" "$KIND_PREFIX" "$1"; }

kc() {
  local idx="$1"; shift
  KUBECONFIG="$(kubeconfig_for "$idx")" kubectl "$@"
}

cluster_live() {
  [[ -f "$(kubeconfig_for "$1")" ]] || return 1
  kc "$1" get --raw='/readyz' >/dev/null 2>&1
}

# Names of the kind clusters this catalog owns (<prefix>-N), one per line.
owned_kind_clusters() {
  kind get clusters 2>/dev/null | grep -E "^${KIND_PREFIX}-[0-9]+$" || true
}

# Delete a namespace and wait until it is really gone. A namespace stuck in Terminating is the
# usual reason a "clean" teardown leaves the next setup broken, so report it instead of hiding it.
#   delete_ns <idx> <ns> [seconds]
delete_ns() {
  local idx="$1" ns="$2" secs="${3:-180}"
  kc "$idx" get ns "$ns" >/dev/null 2>&1 || return 0
  run kc "$idx" delete ns "$ns" --wait=false --ignore-not-found >/dev/null 2>&1 || true
  local deadline=$((SECONDS + secs))
  while kc "$idx" get ns "$ns" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      warn "namespace ${ns} still present after ${secs}s (probably a stuck finalizer)"
      return 1
    fi
    sleep 3
  done
  return 0
}
