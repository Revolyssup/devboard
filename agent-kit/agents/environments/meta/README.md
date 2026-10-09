# Example recipe catalog

This directory is an **example** of a devboard recipe catalog. `scripts/install.sh` copies it to
`~/.agents/environments/meta/` only when that directory does not exist yet, and never overwrites
it afterwards. From then on the copy in `~/.agents` is yours: edit it, extend it, or replace it
with recipes for the environments you actually work with. devboard's engine has no built-in
knowledge of Docker, kind or Kubernetes. Everything domain-specific lives in recipes like these.

The contract these files follow is `~/.agents/specs/environments.md`.

## What is in it

```
host-docker              Docker daemon answering, with >= minCpu / minMemGi      (root, manual)
└── registry-local       registry:2 container "kind-registry" on 127.0.0.1:5000
    └── kind-clusters    kind clusters devboard-0..N-1, kubeconfigs ~/.kube/devboard-N
        └── echo-workload   hashicorp/http-echo Deployment + Service "echo" in <namespace> on devboard-0
```

| Recipe | Params (default, match) | Notes |
| --- | --- | --- |
| `host-docker` | `minCpu` (2, gte), `minMemGi` (4, gte) | `teardown: manual`: the engine never starts, stops or resizes Docker. If the host doesn't qualify, the plan shows a MANUAL step with the recipe's `manualHint`. |
| `registry-local` | `registryName` (kind-registry, exact), `registryPort` (5000, exact) | Claims `host:port:${registryPort}` exclusively, so anything else wanting that port conflicts automatically. Teardown keeps the image volume. |
| `kind-clusters` | `clusters` (2, gte, material), `k8sVersion` (null, semverGte), `registryName`/`registryPort` (passthrough) | Uses kind's default node image unless `k8sVersion=x.y.z` is given. Wires each node to pull `localhost:<port>/...` from the registry. |
| `echo-workload` | `namespace` (echo), `image` (hashicorp/http-echo:1.0), `text` | Healthy only when the Service answers through the API server proxy. Ships an optional `resources.sh` so the Environment overlay can list what it manages. |

`lib/probe-lib.sh` and `lib/setup-lib.sh` are shared helpers (the `lib` directory is not a recipe).

## Prerequisites

`docker`, `kind`, `kubectl`, `jq` and `curl` on `PATH`. A probe that needs a missing tool exits
non-zero, which the engine reports as `unknown` and refuses to plan on. That is deliberate: the
error tells you which tool to install.

## Try it (dry run, changes nothing)

From the devboard checkout:

```bash
npm run env -- layers
npm run env -- probe
npm run env -- plan echo-workload
npm run env -- plan echo-workload clusters=1 namespace=demo
```

`plan` probes your machine and prints what it would reuse, create, rebuild or tear down.
Nothing runs until something calls `POST /api/env/run` (which `/start-env` does after you agree).

## Extending it

1. Copy a recipe directory and rename it. The directory name must equal `id:` in `recipe.yaml`.
2. Set `parent` (containment: dies with its parent) and `requires` (must exist first, but rebuilding
   it does not destroy this one).
3. Declare `params`. Every param whose `match` is not `any` must be reported by `probe.sh` as
   `identS <name> ...` or `identJ <name> ...`, or the layer reads as permanently mismatched and is
   rebuilt on every plan.
4. Declare `claims`. If two recipes can't be live together, give them an overlapping `exclusive`
   claim. Don't list conflicts pairwise.
5. Write `probe.sh` (read-only, one JSON object, exit non-zero only when it can't tell),
   `setup.sh` (idempotent: CREATE, REPAIR and REBUILD all run it), and `teardown.sh` if and
   only if `teardown: allowed`.
6. Write for macOS `/bin/bash` 3.2: no `mapfile`, `readarray`, `declare -A` or `${var^^}`. Use
   `collect` from `lib/setup-lib.sh` for arrays.
7. Run `npm run env -- layers` and `npm run env -- plan <your-recipe>` to check that the engine
   accepts it.

The cluster name prefix (`devboard`) can be changed for all recipes with `ENV_KIND_PREFIX` in the
environment devboard runs in. If you do, also change the `host:kind:devboard-*` and
`cluster:devboard-0/...` claims.
