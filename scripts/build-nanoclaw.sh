#!/bin/bash
# LEGACY — Build the standalone NanoClaw coding sandbox image (nanoclaw-coding:latest).
#
# Origin: session 58 (2026-04-10) NanoClaw fix — see feedback_nanoclaw_sandbox.md.
# That fix produced Dockerfile.nanoclaw + this script, but the runner was
# never updated to use the resulting image. Production nanoclaw-runner.ts
# spawns from mission-control:latest (config.heavyRunnerImage default), built
# via scripts/build-mc-image.sh from the top-level Dockerfile.
#
# Kept for archaeological reference. Do NOT use this script for the runner;
# use build-mc-image.sh instead. If you re-need this, audit Dockerfile.nanoclaw
# first — the worker entrypoint contract may have drifted.

set -e
cd "$(dirname "$0")/.."
docker build -f Dockerfile.nanoclaw -t nanoclaw-coding:latest .
echo "Built nanoclaw-coding:latest (NOTE: not used by production runner — see header)"
docker images nanoclaw-coding:latest --format "Size: {{.Size}}"
