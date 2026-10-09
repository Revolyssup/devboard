#!/usr/bin/env bash
# Is there a Docker daemon that answers, with at least the declared CPU/memory? Read-only.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/probe-lib.sh"

# No docker CLI at all is a definite answer for a host layer: nothing can be running.
if ! command -v docker >/dev/null 2>&1; then
  err "docker CLI not on PATH"
  emit
fi

info="$(probe_timeout 15 docker info --format '{{json .}}' 2>/dev/null)" || info=""
if [[ -z "$info" ]] || ! jq -e '.ServerVersion' >/dev/null 2>&1 <<<"$info"; then
  err "docker daemon is not responding"
  emit
fi

present true

ver="$(jq -r '.ServerVersion // "unknown"' <<<"$info")"
ncpu="$(jq -r '.NCPU // 0' <<<"$info")"
mem_bytes="$(jq -r '.MemTotal // 0' <<<"$info")"
mem_gi=$(( mem_bytes / 1024 / 1024 / 1024 ))

identS dockerVersion "$ver"
identJ minCpu "$ncpu"
identJ minMemGi "$mem_gi"
detail "docker ${ver}: ${ncpu} cpu, ${mem_gi}Gi"

# The planner compares minCpu/minMemGi itself (match: gte). Also reporting it as unhealthy lets
# the plan say WHY rather than just "mismatch".
want_cpu="$(param minCpu 2)"
want_mem="$(param minMemGi 4)"
ok=true
if (( ncpu < want_cpu )); then err "only ${ncpu} cpu available to Docker, want >= ${want_cpu}"; ok=false; fi
if (( mem_gi < want_mem )); then err "only ${mem_gi}Gi available to Docker, want >= ${want_mem}Gi"; ok=false; fi

healthy "$ok"
emit
