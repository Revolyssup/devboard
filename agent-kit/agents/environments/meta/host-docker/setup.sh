#!/usr/bin/env bash
# host-docker is `teardown: manual`, so the planner turns any create/rebuild of it into a MANUAL
# step and the executor never runs this script. It exists so the recipe is complete and so a human
# can run it to get a precise diagnosis. It never starts, stops or reconfigures Docker.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

want_cpu="$(param minCpu 2)"
want_mem="$(param minMemGi 4)"

require_tool docker
docker info >/dev/null 2>&1 || die "the Docker daemon is not responding: start it, then plan again"

ncpu="$(docker info --format '{{.NCPU}}')"
mem_gi=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 / 1024 ))
log "docker: ${ncpu} cpu, ${mem_gi}Gi"

if (( ncpu < want_cpu || mem_gi < want_mem )); then
  die "Docker has ${ncpu} cpu / ${mem_gi}Gi; this environment wants >= ${want_cpu} cpu / ${want_mem}Gi. Raise it in your Docker runtime's settings."
fi
log "done: docker host is ready"
