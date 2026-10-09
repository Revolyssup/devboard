#!/usr/bin/env bash
# Optional resources contract: lets the Environment overlay list what this recipe manages.
#   resources.sh list        -> JSON array of {id, kind, name, namespace, cluster, state}
#   resources.sh show <id>   -> YAML of that object on stdout
# Read-only. `state` is one of: applied | modified | missing | live-only | unknown.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/probe-lib.sh"

require_tool kubectl
ns="$(param namespace echo)"
cluster="${KIND_PREFIX}-0"

case "${1:-list}" in
  list)
    out='[]'
    for kind in deployment service; do
      if cluster_live 0 && kc 0 -n "$ns" get "$kind" echo >/dev/null 2>&1; then state=applied; else state=missing; fi
      out="$(jq -c --arg k "$kind" --arg ns "$ns" --arg c "$cluster" --arg s "$state" \
        '. + [{id: ($k + "/echo"), kind: $k, name: "echo", namespace: $ns, cluster: $c, state: $s}]' <<<"$out")"
    done
    printf '%s\n' "$out"
    ;;
  show)
    id="${2:-}"
    case "$id" in
      deployment/echo|service/echo) ;;
      *) echo "unknown resource id: ${id}" >&2; exit 2 ;;
    esac
    kc 0 -n "$ns" get "$id" -o yaml || echo "# ${id} not found in ${ns} on ${cluster}"
    ;;
  *)
    echo "usage: resources.sh list | show <id>" >&2
    exit 2
    ;;
esac
