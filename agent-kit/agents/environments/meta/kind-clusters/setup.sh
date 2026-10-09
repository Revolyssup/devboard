#!/usr/bin/env bash
# Create devboard-0..N-1 kind clusters wired to the local registry. Idempotent, and converges from
# any state, because CREATE and REBUILD both run this script (there is no teardown in between):
#   - a healthy cluster at an acceptable version is kept
#   - a registered-but-unreachable cluster, or one older than a declared k8sVersion, is recreated
#   - extra clusters beyond N are left alone (match: gte)
#
# Registry wiring follows kind's documented local-registry setup: containerd reads per-registry
# hosts.toml files, each node maps localhost:<port> to the registry container over the kind
# network, and a ConfigMap advertises the registry to tooling (KEP-1755).
source "$(dirname "${BASH_SOURCE[0]}")/../lib/setup-lib.sh"

require_tool docker
require_tool kind
require_tool kubectl
require_tool jq

want="$(param clusters 2)"
want_ver="$(param k8sVersion "")"
reg_name="$(param registryName kind-registry)"
reg_port="$(param registryPort 5000)"

image_args=()
if [[ -n "$want_ver" ]]; then
  # kindest/node publishes one image per Kubernetes patch release. A bare major.minor is not a tag.
  [[ "$want_ver" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "k8sVersion '${want_ver}' must be a full x.y.z release to pick a kindest/node image"
  image_args=(--image "kindest/node:v${want_ver#v}")
fi

# version_lt a b  -> 0 if a < b (numeric x.y.z compare)
version_lt() {
  [[ "$1" != "$2" ]] && [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "$1" ]]
}

cfg_file="$(mktemp -t kind-config.XXXXXX)"
trap 'rm -f "$cfg_file"' EXIT
cat >"$cfg_file" <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry]
    config_path = "/etc/containerd/certs.d"
YAML

mkdir -p "$HOME/.kube"
collect existing owned_kind_clusters

i=0
while (( i < want )); do
  name="${KIND_PREFIX}-${i}"
  cfg="$(kubeconfig_for "$i")"
  exists=false
  for e in "${existing[@]+"${existing[@]}"}"; do [[ "$e" == "$name" ]] && exists=true; done

  if [[ "$exists" == true ]]; then
    recreate=""
    if ! cluster_live "$i"; then
      # Try to recover a deleted kubeconfig before deciding the cluster is broken.
      kind export kubeconfig --name "$name" --kubeconfig "$cfg" >/dev/null 2>&1 || true
      cluster_live "$i" || recreate="API server unreachable"
    fi
    if [[ -z "$recreate" && -n "$want_ver" ]]; then
      have="$(kc "$i" version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion // empty' | sed 's/^v//; s/[-+].*//')"
      if [[ -z "$have" ]] || version_lt "$have" "${want_ver#v}"; then
        recreate="k8s ${have:-unknown} < ${want_ver#v}"
      fi
    fi
    if [[ -n "$recreate" ]]; then
      log "${name}: ${recreate}, recreating"
      run kind delete cluster --name "$name" || die "could not delete ${name}"
      rm -f "$cfg"
      exists=false
    else
      log "${name}: already live, keeping it"
    fi
  fi

  if [[ "$exists" == false ]]; then
    log "creating kind cluster ${name}"
    run kind create cluster --name "$name" --config "$cfg_file" --kubeconfig "$cfg" --wait 180s \
      ${image_args[@]+"${image_args[@]}"} || die "kind create cluster ${name} failed"
  fi
  i=$((i + 1))
done

# The kind network exists now; make sure the registry is on it so nodes can reach it by name.
if ! docker network inspect kind --format '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | grep -qx "$reg_name"; then
  run docker network connect kind "$reg_name" || die "could not attach ${reg_name} to the kind network"
fi

i=0
while (( i < want )); do
  name="${KIND_PREFIX}-${i}"
  log "${name}: wiring localhost:${reg_port} -> ${reg_name}:5000"
  collect nodes kind get nodes --name "$name"
  for node in "${nodes[@]+"${nodes[@]}"}"; do
    dir="/etc/containerd/certs.d/localhost:${reg_port}"
    docker exec "$node" mkdir -p "$dir" || die "${node}: could not create ${dir}"
    printf '[host."http://%s:5000"]\n' "$reg_name" | docker exec -i "$node" cp /dev/stdin "${dir}/hosts.toml" \
      || die "${node}: could not write hosts.toml"
  done
  cat <<YAML | kc "$i" apply -f - >/dev/null || die "${name}: could not apply local-registry-hosting"
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${reg_port}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
YAML
  i=$((i + 1))
done

# Exit 0 is only a claim; the probe re-checks after this. Fail fast here anyway for a clear log.
ok=0
i=0
while (( i < want )); do
  if cluster_live "$i"; then ok=$((ok + 1)); else warn "${KIND_PREFIX}-${i}: API server not answering"; fi
  i=$((i + 1))
done
(( ok >= want )) || die "only ${ok}/${want} clusters are live"
log "done: ${ok} kind cluster(s) live, kubeconfigs at ~/.kube/${KIND_PREFIX}-N"
