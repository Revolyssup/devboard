#!/usr/bin/env bash
# Create (or restart) the local registry container. Idempotent: safe to re-run, and it is also
# what a REPAIR runs.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

require_tool docker
require_tool curl

name="$(param registryName kind-registry)"
port="$(param registryPort 5000)"
image="${ENV_REGISTRY_IMAGE:-registry:2}"

# REBUILD runs this same script (there is no separate teardown first), so converge from any state:
# a container bound to a different port than declared is replaced.
if [[ -n "$(docker ps -aq -f "name=^${name}$" 2>/dev/null)" ]]; then
  bound="$(docker inspect "$name" \
    --format '{{range $p, $b := .HostConfig.PortBindings}}{{if eq $p "5000/tcp"}}{{range $b}}{{.HostPort}}{{end}}{{end}}{{end}}' 2>/dev/null || true)"
  if [[ "$bound" != "$port" ]]; then
    log "${name} is bound to port '${bound}', want ${port}: replacing the container (volume kept)"
    run docker rm -f "$name" >/dev/null || die "could not remove ${name}"
  fi
fi

if [[ -n "$(docker ps -q -f "name=^${name}$" 2>/dev/null)" ]]; then
  log "${name} already running"
elif [[ -n "$(docker ps -aq -f "name=^${name}$" 2>/dev/null)" ]]; then
  # Restart rather than recreate: the container's volume holds every image pushed so far.
  log "${name} exists but is stopped: starting it"
  run docker start "$name" >/dev/null || die "could not start ${name}"
else
  log "creating registry ${name} on 127.0.0.1:${port}"
  run docker run -d --restart=always -p "127.0.0.1:${port}:5000" --name "$name" "$image" >/dev/null \
    || die "could not create ${name} (is port ${port} already in use?)"
fi

wait_for 60 "registry API on 127.0.0.1:${port}" curl -sf "http://127.0.0.1:${port}/v2/" \
  || die "registry did not answer on 127.0.0.1:${port}"

# Attach to the kind network if it exists already; kind-clusters/setup.sh re-asserts this after
# creating the first cluster (which is what creates the network).
if docker network inspect kind >/dev/null 2>&1; then
  if docker network inspect kind --format '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | grep -qx "$name"; then
    log "already attached to the kind network"
  else
    run docker network connect kind "$name" || die "could not attach ${name} to the kind network"
  fi
else
  log "kind network does not exist yet; kind-clusters attaches the registry when it creates it"
fi

log "done: registry ${name} live on 127.0.0.1:${port}"
