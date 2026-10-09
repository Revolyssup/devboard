#!/usr/bin/env bash
# Remove the echo namespace from cluster 0 and wait until it is really gone.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

require_tool kubectl
ns="$(param namespace echo)"

if ! cluster_live 0; then
  # Teardowns run deepest-first, so this only happens if the cluster vanished some other way.
  # Nothing to delete - and the probe, not this script, decides whether that is true.
  warn "${KIND_PREFIX}-0 is not reachable; nothing to delete here"
  exit 0
fi

delete_ns 0 "$ns" 180 || die "namespace ${ns} was not removed"
log "done: namespace ${ns} removed from ${KIND_PREFIX}-0"
