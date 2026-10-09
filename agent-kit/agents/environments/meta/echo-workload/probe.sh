#!/usr/bin/env bash
# Is the echo Deployment/Service in <namespace> on cluster 0 (present), and does it actually answer
# through the API server's service proxy (healthy)? Read-only: only GETs.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/probe-lib.sh"

require_tool kubectl

ns="$(param namespace echo)"
cluster="${KIND_PREFIX}-0"

# Probes run in parallel and are not skipped when the parent is absent, so answer "no cluster"
# definitively when we can: a namespace cannot exist in a cluster that does not exist.
if command -v kind >/dev/null 2>&1; then
  known="$(probe_timeout 20 kind get clusters 2>/dev/null)" || known=""
  if ! printf '%s\n' "$known" | grep -qx "$cluster" && [[ ! -f "$(kubeconfig_for 0)" ]]; then
    err "cluster ${cluster} does not exist"
    emit
  fi
elif [[ ! -f "$(kubeconfig_for 0)" ]]; then
  err "no kubeconfig for ${cluster}"
  emit
fi

# The cluster exists but does not answer: whatever is in it is invisible, not absent.
cluster_live 0 || cannot_tell "${cluster} exists but its API server does not answer"

if ! kc 0 get ns "$ns" >/dev/null 2>&1; then
  err "no namespace ${ns} on ${cluster}"
  emit
fi

dep="$(kc 0 -n "$ns" get deployment echo -o json)" || dep=""
if [[ -z "$dep" ]]; then
  err "namespace ${ns} exists on ${cluster} but has no deployment/echo"
  emit
fi

present true
identS namespace "$ns"
identS image "$(jq -r '.spec.template.spec.containers[0].image // ""' <<<"$dep")"
identS text "$(jq -r '(.spec.template.spec.containers[0].args // []) | map(select(startswith("-text="))) | (.[0] // "") | sub("^-text="; "")' <<<"$dep")"

want_r="$(jq -r '.spec.replicas // 1' <<<"$dep")"
have_r="$(jq -r '.status.availableReplicas // 0' <<<"$dep")"
detail "${cluster}/${ns}: deployment/echo ${have_r}/${want_r} available"

if (( have_r < want_r )); then
  reason="$(kc 0 -n "$ns" get pods -l app=echo -o json \
    | jq -r '[.items[].status.containerStatuses[]?.state.waiting.reason // empty] | unique | join(", ")')"
  err "deployment/echo not available${reason:+ (${reason})}"
  emit
fi

reply="$(kc 0 get --raw "/api/v1/namespaces/${ns}/services/echo:80/proxy/")" || reply=""
if [[ -z "$reply" ]]; then
  err "service ${ns}/echo did not answer through the API server proxy"
  emit
fi
detail "service ${ns}/echo answered: $(printf '%s' "$reply" | head -c 80)"

healthy true
emit
