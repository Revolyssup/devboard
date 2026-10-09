#!/usr/bin/env bash
# Which devboard-N kind clusters exist (present), and do they all answer with Ready nodes (healthy)?
# Read-only.
#
# Existence and reachability are different questions. `kind get clusters` is the authority on
# EXISTENCE; the API server answering only decides HEALTH. Deriving `present` from kubectl would
# make a cluster whose kubeconfig was deleted report `absent` - and `absent` is exactly what tells
# the executor a teardown succeeded.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/probe-lib.sh"

require_tool kind
require_tool kubectl

want="$(param clusters 2)"
want_ver="$(param k8sVersion "")"

known="$(probe_timeout 20 kind get clusters 2>/dev/null)" \
  || cannot_tell "'kind get clusters' failed (is the Docker daemon up?)"
registered="$(printf '%s\n' "$known" | grep -E "^${KIND_PREFIX}-[0-9]+$" | sort -t- -k2 -n || true)"

live=()
unreachable=()
not_ready=()
no_registry=()
min_ver=""

for name in $registered; do
  idx="${name##*-}"
  if ! cluster_live "$idx"; then
    unreachable+=("$name")
    if [[ -f "$(kubeconfig_for "$idx")" ]]; then
      detail "${name}: registered with kind but the API server does not answer"
    else
      detail "${name}: registered with kind but $(kubeconfig_for "$idx") is missing"
    fi
    continue
  fi

  ver="$(kc "$idx" version -o json | jq -r '.serverVersion.gitVersion // empty' | sed 's/^v//; s/[-+].*//')"
  nodes="$(kc "$idx" get nodes -o json || echo '{}')"
  total="$(jq '.items | length' <<<"$nodes" 2>/dev/null || echo 0)"
  ready="$(jq '[.items[]? | select(any(.status.conditions[]?; .type=="Ready" and .status=="True"))] | length' <<<"$nodes" 2>/dev/null || echo 0)"
  detail "${name}: ${ready}/${total} nodes Ready, k8s ${ver:-unknown}"

  if (( total == 0 || ready < total )); then
    not_ready+=("$name")
    continue
  fi
  live+=("$name")

  # Lowest version across clusters is what a semverGte request must be compared against.
  if [[ -n "$ver" ]]; then
    if [[ -z "$min_ver" ]] || [[ "$(printf '%s\n%s\n' "$ver" "$min_ver" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "$ver" ]]; then
      min_ver="$ver"
    fi
  fi

  # Registry wiring that setup.sh installs: the KEP-1755 ConfigMap advertising the local registry.
  if ! kc "$idx" -n kube-public get configmap local-registry-hosting >/dev/null 2>&1; then
    no_registry+=("$name")
  fi
done

n_registered=0
for _ in $registered; do n_registered=$((n_registered + 1)); done

identJ clusters "${#live[@]}"
if [[ -n "$min_ver" ]]; then identS k8sVersion "$min_ver"; else identJ k8sVersion null; fi
identJ names "$(printf '%s\n' "${live[@]+"${live[@]}"}" | jq -R . | jq -sc 'map(select(length > 0))')"
identJ registered "$n_registered"

if (( n_registered == 0 )); then
  stale=""
  for f in "$HOME/.kube/${KIND_PREFIX}-"*; do [[ -e "$f" ]] && stale="${stale} $(basename "$f")"; done
  if [[ -n "$stale" ]]; then
    err "no ${KIND_PREFIX}-N kind clusters (stale kubeconfigs with no cluster behind them:${stale})"
  else
    err "no ${KIND_PREFIX}-N kind clusters"
  fi
  emit
fi

present true
ok=true
if (( ${#unreachable[@]} > 0 )); then
  err "registered with kind but unreachable: ${unreachable[*]} (they still exist and hold resources)"
  ok=false
fi
if (( ${#not_ready[@]} > 0 )); then
  err "nodes not Ready in: ${not_ready[*]}"
  ok=false
fi
if (( ${#live[@]} < want )); then
  err "${#live[@]} healthy cluster(s), want >= ${want}"
  ok=false
fi
if (( ${#no_registry[@]} > 0 )); then
  err "local registry not wired into: ${no_registry[*]} (re-run setup)"
  ok=false
fi
[[ -n "$want_ver" && -n "$min_ver" ]] && detail "declared k8sVersion >= ${want_ver}, lowest observed ${min_ver}"

healthy "$ok"
emit
