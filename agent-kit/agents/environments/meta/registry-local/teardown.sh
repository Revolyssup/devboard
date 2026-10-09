#!/usr/bin/env bash
# Remove the registry container.
#
# Deliberately NOT `docker rm -v`: the anonymous volume holds every image pushed so far. The
# container is disposable; re-pushing everything is not. Remove the volume by hand if you mean it.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

require_tool docker
name="$(param registryName kind-registry)"

if [[ -z "$(docker ps -aq -f "name=^${name}$" 2>/dev/null)" ]]; then
  log "no container named ${name}: nothing to do"
  exit 0
fi

log "removing container ${name} (its volume is kept)"
run docker rm -f "$name" >/dev/null || die "could not remove ${name}"

[[ -z "$(docker ps -aq -f "name=^${name}$" 2>/dev/null)" ]] || die "${name} is still present"
log "done"
