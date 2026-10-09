#!/usr/bin/env bash
# Delete every devboard-N kind cluster, and their kubeconfigs with them.
#
# Leaving ~/.kube/devboard-N behind recreates the trap the probe exists to catch: readable
# kubeconfigs pointing at clusters that no longer exist. Kubeconfigs are removed only for clusters
# that are confirmed gone, so a partial failure never orphans a live cluster's config.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

require_tool kind

collect known owned_kind_clusters
if (( ${#known[@]} == 0 )); then
  log "no ${KIND_PREFIX}-N kind clusters registered"
else
  for name in "${known[@]}"; do
    log "deleting kind cluster ${name}"
    run kind delete cluster --name "$name" || warn "failed to delete ${name}"
  done
fi

collect remaining owned_kind_clusters
for f in "$HOME/.kube/${KIND_PREFIX}-"*; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  still=false
  for r in "${remaining[@]+"${remaining[@]}"}"; do [[ "$r" == "$name" ]] && still=true; done
  if [[ "$still" == true ]]; then
    warn "keeping ${f}: cluster ${name} still exists"
    continue
  fi
  run rm -f "$f"
done

(( ${#remaining[@]} == 0 )) || die "kind clusters still present: ${remaining[*]}"
log "done: no ${KIND_PREFIX}-N clusters, no stale kubeconfigs"
