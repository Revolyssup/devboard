#!/usr/bin/env bash
# Apply the echo Deployment + Service on cluster 0. `kubectl apply` is idempotent, so this is also
# what REPAIR and REBUILD run (a changed image or text rolls the deployment).
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

require_tool kubectl
require_tool jq

ns="$(param namespace echo)"
image="$(param image hashicorp/http-echo:1.0)"
text="$(param text "hello from devboard")"

cluster_live 0 || die "${KIND_PREFIX}-0 is not reachable via $(kubeconfig_for 0)"

log "applying echo (${image}) in namespace ${ns} on ${KIND_PREFIX}-0"
# jq builds the JSON manifest so the free-form text param can never break the quoting.
jq -n --arg ns "$ns" --arg image "$image" --arg text "$text" '{
  apiVersion: "v1", kind: "List", items: [
    {apiVersion: "v1", kind: "Namespace", metadata: {name: $ns}},
    {apiVersion: "apps/v1", kind: "Deployment",
     metadata: {name: "echo", namespace: $ns, labels: {app: "echo"}},
     spec: {replicas: 1, selector: {matchLabels: {app: "echo"}},
       template: {metadata: {labels: {app: "echo"}},
         spec: {containers: [{name: "echo", image: $image,
           args: ["-listen=:5678", ("-text=" + $text)],
           ports: [{containerPort: 5678}],
           readinessProbe: {httpGet: {path: "/", port: 5678}}}]}}}},
    {apiVersion: "v1", kind: "Service",
     metadata: {name: "echo", namespace: $ns, labels: {app: "echo"}},
     spec: {selector: {app: "echo"}, ports: [{port: 80, targetPort: 5678}]}}
  ]}' | run kc 0 apply -f - || die "kubectl apply failed"

run kc 0 -n "$ns" rollout status deployment/echo --timeout=180s \
  || die "deployment/echo did not become available (check: kubectl -n ${ns} describe pods -l app=echo)"
log "done: echo is serving in ${ns} on ${KIND_PREFIX}-0"
