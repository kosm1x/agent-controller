.PHONY: dev build start test typecheck lint clean docker-build docker-up docker-down

# Development
dev:
	npx tsx watch src/index.ts

# Build
build:
	npx tsc

# Start production
start: build
	node dist/index.js

# Testing
test:
	npx vitest run

test-watch:
	npx vitest

# Type checking
typecheck:
	npx tsc --noEmit

# Clean build artifacts
clean:
	rm -rf dist

# Docker
docker-build:
	docker compose build

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f mission-control
