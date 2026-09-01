FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Production image
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  docker.io \
  openjdk-17-jre-headless \
  git \
  curl \
  ca-certificates \
  python3 \
  make \
  g++ \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# The npm bundled with node:22-slim (10.9.8) vendors tar 7.5.11, which carries
# GHSA-23hp-3jrh-7fpw (critical, "node-tar: Decompression/parse DoS via
# unlimited input", fixed in tar 7.5.19). npm 10.9.9 depends on tar ^7.5.22 —
# patch-level bump only; drop once the base image ships npm >= 10.9.9.
# (nanoclaw upstream v2.2.0 #3207 did the same in its agent image.)
RUN npm install -g npm@10.9.9
# devDependencies INCLUDED (qa R2 W-D, 2026-09-01). This is a CODING sandbox:
# nanoclaw-worker symlinks /app/node_modules into its /workspace clone and the
# prompt tells the agent to run `npx vitest run <file>` / tsc there. With
# `--omit=dev` the image had no vitest/tsc/tsx at all — task 4c34b839 (08-27)
# reported "vitest not installed" for exactly that reason. Host and sandbox now
# install the same lockfile set (mc.lock-sha256 pins the coupling).
RUN npm ci

# Baked dist/ + prompt_modules/ are the FALLBACK for a bare `docker run`. The
# container runners mount the HOST's deployed dist/ and prompt_modules/ read-only
# over these at spawn (src/runners/container.ts RUNTIME_CODE_MOUNTS, 2026-09-01),
# so a host deploy never leaves the sandbox on stale code. node_modules IS the
# image's contribution — hence the lockfile label at the end of this file.
COPY --from=builder /app/dist/ ./dist/
COPY src/db/schema.sql ./dist/db/schema.sql
COPY public/ ./public/
# V8.2 §10: strategic-voice prompt module is a runtime asset (NOT compiled into
# dist/); the loader reads it cwd-relative (resolve("prompt_modules")). Without
# this, a containerized runner that exercises a V8.2 call path fails loud.
COPY prompt_modules/ ./prompt_modules/

ENV NODE_ENV=production

# Prune protection — /etc/cron.d/docker-image-prune skips images with this label.
# Without it, the daily 00:47 UTC prune removes mission-control:latest after 24h
# of no container references (mc API runs in-process via systemd, not a container),
# silently breaking nanoclaw-runner.ts which spawns containers from this image.
# Recurrence cause documented in feedback_nanoclaw_image_recurrence_2026_05_23.md.
LABEL keep=true

EXPOSE 8080

CMD ["node", "dist/index.js"]

# ---- Provenance labels — LAST on purpose: an ARG invalidates every layer
# below it, so declaring these earlier would redo `npm ci` on every rebuild
# for two pieces of metadata. mc.lock-sha256 = sha256(package-lock.json) the
# image's node_modules came from; the container runners refuse to spawn when
# it differs from the host lockfile (container.ts imageLockDrift) and
# scripts/deploy.sh rebuilds on drift. build-mc-image.sh passes both; a bare
# `docker build` leaves them empty, which the runners treat as drift.
ARG LOCK_SHA256=
ARG GIT_SHA=
LABEL mc.lock-sha256="${LOCK_SHA256}" mc.git-sha="${GIT_SHA}"
