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
RUN npm ci --omit=dev

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
