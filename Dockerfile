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

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/index.js"]
