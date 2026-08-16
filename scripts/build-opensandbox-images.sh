#!/usr/bin/env bash
# Build the keep-labelled OpenSandbox runtime images the lifecycle server
# references from /root/.opensandbox/sandbox.toml ([runtime].execd_image and
# [egress].image). Idempotent; re-run after bumping the upstream tags in
# container/opensandbox/Dockerfile.*.
# Note: only the DERIVED tags carry keep=true; the base `opensandbox/*` tags are
# pruned nightly, so a rebuild needs network to re-pull them (harmless for
# running sandboxes — their layers stay referenced by the derived images).
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q -f container/opensandbox/Dockerfile.execd  -t mc-opensandbox-execd:v1.0.22  container/opensandbox
docker build -q -f container/opensandbox/Dockerfile.egress -t mc-opensandbox-egress:v1.1.6 container/opensandbox
for img in mc-opensandbox-execd:v1.0.22 mc-opensandbox-egress:v1.1.6; do
  if [ "$(docker image inspect "$img" --format '{{index .Config.Labels "keep"}}')" != "true" ]; then
    echo "ERROR: $img missing LABEL keep=true — it will be pruned nightly" >&2; exit 1
  fi
  echo "ok: $img (keep=true)"
done
