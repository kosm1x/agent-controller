#!/bin/bash
# Build the NanoClaw coding sandbox Docker image.
set -e
cd "$(dirname "$0")/.."
docker build -f Dockerfile.nanoclaw -t nanoclaw-coding:latest .
echo "Built nanoclaw-coding:latest"
docker images nanoclaw-coding:latest --format "Size: {{.Size}}"
