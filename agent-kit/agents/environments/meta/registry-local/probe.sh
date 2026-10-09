#!/usr/bin/env bash
# Does the registry container exist (present), and does its API answer (healthy)? Read-only.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/probe-lib.sh"

name="$(param registryName kind-registry)"
port="$(param registryPort 5000)"

# Without a docker CLI or daemon there is no container to find. Probes run in parallel and are not
# skipped when the parent is absent, so this layer must answer sensibly on its own.
if ! command -v docker >/dev/null 2>&1; then
  err "docker CLI not on PATH"
  emit
fi
if ! probe_timeout 10 docker info >/dev/null 2>&1; then
  # The container may well exist inside a stopped daemon; we cannot see it. That is `unknown`,
  # not `absent` - but only matters if someone wants to tear it down, so say so plainly.
  cannot_tell "docker daemon not responding; cannot see container ${name}"
fi

row="$(probe_timeout 10 docker ps -a --filter "name=^${name}$" --format '{{json .}}' 2>/dev/null | head -1)" \
  || cannot_tell "docker ps failed"

if [[ -z "$row" ]]; then
  err "no container named ${name}"
  emit
fi

present true
identS registryName "$name"

state="$(jq -r '.State // "unknown"' <<<"$row")"
image="$(jq -r '.Image // ""' <<<"$row")"
detail "${name}: ${state} (${image})"

# The port is read from the container's configuration, not from whether it answers, so a stopped
# registry still reports its identity and is REPAIRed (restarted) rather than REBUILT.
bound="$(probe_timeout 8 docker inspect "$name" \
  --format '{{range $p, $b := .HostConfig.PortBindings}}{{if eq $p "5000/tcp"}}{{range $b}}{{.HostPort}}{{end}}{{end}}{{end}}' 2>/dev/null)" || bound=""
if [[ "$bound" =~ ^[0-9]+$ ]]; then identJ registryPort "$bound"; else identJ registryPort null; fi

if [[ "$state" != "running" ]]; then
  err "container ${name} is ${state}, not running"
  emit
fi

# Running is not the same as answering: the process may be wedged, or the port may be bound by
# something else entirely.
if probe_timeout 8 curl -sf "http://127.0.0.1:${port}/v2/" >/dev/null 2>&1; then
  detail "registry API answering on 127.0.0.1:${port}"
else
  err "container is running but the registry API does not answer on 127.0.0.1:${port}"
  emit
fi

# kind nodes reach the registry by container name over the `kind` network. That network only
# exists once a kind cluster has been created, so a missing network is fine; a network that
# exists without the registry attached is not.
if probe_timeout 8 docker network inspect kind >/dev/null 2>&1; then
  if probe_timeout 8 docker network inspect kind --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null \
      | tr ' ' '\n' | grep -qx "$name"; then
    detail "attached to the kind network"
    healthy true
  else
    err "kind network exists but ${name} is not attached: pulls from inside clusters will fail"
  fi
else
  detail "kind network does not exist yet (created with the first kind cluster)"
  healthy true
fi

emit
