#!/usr/bin/env bash
# Shared helpers for recipe probe.sh scripts. Sourced, never run directly.
#
# Probe contract (see ~/.agents/specs/environments.md):
#   - read-only: no side effects, ever
#   - fast: a probe runs on every plan, so aim for a few seconds
#   - prints exactly ONE JSON object on stdout:
#       {"present":bool,"healthy":bool,"identity":{},"details":[],"errors":[]}
#   - exit 0 if the probe RAN, whatever it found
#   - exit non-zero only if the probe itself could not tell (missing tool, timeout, ...).
#     The engine reads that as `unknown`, which blocks the plan. Never report `present: false`
#     when the truth is "I could not look": a broken probe must not green-light a rebuild of
#     something that is actually alive.
#
# Must run under macOS /bin/bash 3.2: no mapfile/readarray, no `declare -A`, no ${var^^}.

set -uo pipefail

PRESENT=false
HEALTHY=false
_IDENTITY='{}'
_DETAILS='[]'
_ERRORS='[]'

# Abort with `unknown` semantics: the probe could not determine the truth.
cannot_tell() {
  printf 'probe could not determine state: %s\n' "$1" >&2
  exit 3
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || cannot_tell "required tool '$1' not on PATH"
}

# jq is how every probe builds its JSON, so it is checked up front for all of them.
require_tool jq

# Bound every external call: a probe that hangs is a broken probe.
probe_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@"
  fi
}

# Declared params arrive as ENV_PARAM_<NAME>: the param name upper-cased, '-' -> '_'
# (so `registryPort` arrives as ENV_PARAM_REGISTRYPORT).
#   param <name> [default]
param() {
  local name="$1" def="${2:-}" var
  var="ENV_PARAM_$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')"
  printf '%s' "${!var:-$def}"
}

detail() { _DETAILS="$(jq -c --arg v "$1" '. + [$v]' <<<"$_DETAILS")"; }
err()    { _ERRORS="$(jq -c --arg v "$1" '. + [$v]' <<<"$_ERRORS")"; }

# Observed identity. Keys should be the recipe's declared param names: the planner compares each
# declared param against identity[<name>] using the param's `match` mode.
#   identS key "string value"
#   identJ key '<raw json>'   (numbers, booleans, arrays, null)
identS() { _IDENTITY="$(jq -c --arg k "$1" --arg v "$2" '.[$k] = $v' <<<"$_IDENTITY")"; }
identJ() { _IDENTITY="$(jq -c --arg k "$1" --argjson v "$2" '.[$k] = $v' <<<"$_IDENTITY")"; }

present() { PRESENT="$1"; }
healthy() { HEALTHY="$1"; }

# Print the result and exit 0. Every probe ends here.
emit() {
  # healthy implies present; enforce it so no probe can emit an incoherent state.
  [[ "$HEALTHY" == "true" ]] && PRESENT=true
  jq -nc \
    --argjson present "$PRESENT" \
    --argjson healthy "$HEALTHY" \
    --argjson identity "$_IDENTITY" \
    --argjson details "$_DETAILS" \
    --argjson errors "$_ERRORS" \
    '{present:$present, healthy:$healthy, identity:$identity, details:$details, errors:$errors}'
  exit 0
}

# --- conventions shared by the example recipes ---------------------------------------------------

# kind clusters created by the kind-clusters recipe are named <prefix>-0, <prefix>-1, ...
# and each gets its own kubeconfig at ~/.kube/<prefix>-N.
KIND_PREFIX="${ENV_KIND_PREFIX:-devboard}"

kubeconfig_for() { printf '%s/.kube/%s-%s' "$HOME" "$KIND_PREFIX" "$1"; }

# kubectl against cluster N, bounded. Non-zero if the API server does not answer.
kc() {
  local idx="$1"; shift
  KUBECONFIG="$(kubeconfig_for "$idx")" probe_timeout 10 kubectl "$@" 2>/dev/null
}

# True iff cluster N's API server actually answers. A kubeconfig file existing proves nothing.
cluster_live() {
  [[ -f "$(kubeconfig_for "$1")" ]] || return 1
  kc "$1" get --raw='/readyz' >/dev/null 2>&1
}

# deployment_ready <idx> <ns> <name> -> 0 iff available replicas >= desired replicas
deployment_ready() {
  local idx="$1" ns="$2" name="$3" want have
  want="$(kc "$idx" -n "$ns" get deployment "$name" -o jsonpath='{.spec.replicas}' || true)"
  [[ -n "$want" ]] || return 1
  have="$(kc "$idx" -n "$ns" get deployment "$name" -o jsonpath='{.status.availableReplicas}' || true)"
  [[ -n "$have" && "$have" -ge "$want" ]]
}
