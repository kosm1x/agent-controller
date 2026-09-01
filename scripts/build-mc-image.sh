#!/bin/bash
# Build mission-control:latest — the canonical Docker image used by
# nanoclaw-runner and (when HEAVY_RUNNER_CONTAINERIZED=true) heavy-runner.
#
# The image bakes `LABEL keep=true` so /etc/cron.d/docker-image-prune skips
# it via --filter "label!=keep=true". Without that label, the daily prune
# removes it after 24h of no container references (mc API runs in-process,
# not containerized), silently breaking every nanoclaw task until rebuild.
#
# Recurrence root-cause + fix documented in
# feedback_nanoclaw_image_recurrence_2026_05_23.md.
#
# Run when:
#   - package-lock.json changed — scripts/deploy.sh does this AUTOMATICALLY
#     (it compares the image's mc.lock-sha256 label to the host lockfile).
#     Since 2026-09-01 the sandbox executes the HOST dist/ (read-only mount,
#     container.ts RUNTIME_CODE_MOUNTS) on the IMAGE's node_modules, so dist/
#     edits never need a rebuild — only dependency changes do.
#   - Any incident where `docker images` shows mission-control:latest absent
#   - A runner logs `built from a different package-lock.json` (lock drift)
#
# This script is the canonical replacement for the ad-hoc 2026-05-13 rebuild
# command and the unrelated scripts/build-nanoclaw.sh (which builds the
# legacy nanoclaw-coding:latest from Dockerfile.nanoclaw, currently unused).

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_TAG="mission-control:latest"

echo "[build-mc-image] Building $IMAGE_TAG from Dockerfile..."
LOCK_SHA256=$(sha256sum package-lock.json | cut -d' ' -f1)
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
docker build -f Dockerfile \
  --build-arg "LOCK_SHA256=$LOCK_SHA256" \
  --build-arg "GIT_SHA=$GIT_SHA" \
  -t "$IMAGE_TAG" .

echo "[build-mc-image] Verifying LABEL keep=true is baked in..."
LABEL_VALUE=$(docker image inspect "$IMAGE_TAG" --format '{{ index .Config.Labels "keep" }}')
if [ "$LABEL_VALUE" != "true" ]; then
  echo "[build-mc-image] FATAL: LABEL keep=true missing on $IMAGE_TAG (got: '$LABEL_VALUE')"
  echo "[build-mc-image] Check Dockerfile — the production stage must include 'LABEL keep=true'."
  exit 1
fi

SIZE=$(docker images "$IMAGE_TAG" --format "{{.Size}}")
echo "[build-mc-image] Verifying mc.lock-sha256 label matches package-lock.json..."
LOCK_LABEL=$(docker image inspect "$IMAGE_TAG" --format '{{ index .Config.Labels "mc.lock-sha256" }}')
if [ "$LOCK_LABEL" != "$LOCK_SHA256" ]; then
  echo "[build-mc-image] FATAL: mc.lock-sha256 label mismatch on $IMAGE_TAG (label='$LOCK_LABEL' expected='$LOCK_SHA256')"
  echo "[build-mc-image] Check Dockerfile — the provenance LABEL block must be present and receive --build-arg LOCK_SHA256."
  exit 1
fi
echo "[build-mc-image] Built $IMAGE_TAG (size: $SIZE, keep=true verified, lock-sha256 ${LOCK_SHA256:0:12}… git $GIT_SHA)"

# The build we just superseded is now an untagged <none> image that STILL
# carries LABEL keep=true, so the nightly prune (--filter "label!=keep=true")
# skips it forever — ~3 GB per rebuild (qa R1 W5, 2026-09-01). Remove it here.
# A running container pins its image and makes rmi fail; that one is swept by
# the next rebuild.
for id in $(docker images -q --filter dangling=true --filter label=keep=true); do
  if docker rmi "$id" >/dev/null 2>&1; then
    echo "[build-mc-image] Removed superseded keep=true image $id"
  else
    echo "[build-mc-image] Superseded image $id still in use (running container) — next rebuild sweeps it"
  fi
done
