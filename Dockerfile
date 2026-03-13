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
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ ./dist/
COPY src/db/schema.sql ./dist/db/schema.sql
COPY public/ ./public/

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/index.js"]
