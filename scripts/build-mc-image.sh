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
# Run after:
#   - Source edits to anything the runner image bakes (rare — usually only
#     when the container worker entrypoint or its deps change)
#   - Any incident where `docker images` shows mission-control:latest absent
#
# This script is the canonical replacement for the ad-hoc 2026-05-13 rebuild
# command and the unrelated scripts/build-nanoclaw.sh (which builds the
# legacy nanoclaw-coding:latest from Dockerfile.nanoclaw, currently unused).

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_TAG="mission-control:latest"

echo "[build-mc-image] Building $IMAGE_TAG from Dockerfile..."
docker build -f Dockerfile -t "$IMAGE_TAG" .

echo "[build-mc-image] Verifying LABEL keep=true is baked in..."
LABEL_VALUE=$(docker image inspect "$IMAGE_TAG" --format '{{ index .Config.Labels "keep" }}')
if [ "$LABEL_VALUE" != "true" ]; then
  echo "[build-mc-image] FATAL: LABEL keep=true missing on $IMAGE_TAG (got: '$LABEL_VALUE')"
  echo "[build-mc-image] Check Dockerfile — the production stage must include 'LABEL keep=true'."
  exit 1
fi

SIZE=$(docker images "$IMAGE_TAG" --format "{{.Size}}")
echo "[build-mc-image] Built $IMAGE_TAG (size: $SIZE, keep=true verified)"
