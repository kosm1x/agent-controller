# Agent Controller

A unified orchestrator that receives tasks and routes them to the right kind of AI agent — from fast in-process tool loops to heavy planning agents to coordinated swarms — all through a single API.

---

## What is this?

Agent Controller is a single backend service that sits between you and your AI agents. You submit a task through the API. It classifies by complexity, picks the right execution strategy, runs it, and streams results back in real time.

Four runner types, one dispatcher:

- **Fast** runs in-process. LLM + tools, loop until done, return. Seconds, not minutes. Good for: running a command, fetching data, quick file edits.

- **NanoClaw** spawns an isolated Docker container with the full NanoClaw agent runtime — persistent sessions, container-scoped filesystem, rich tool ecosystem. Good for: tasks needing isolation, longer tool sessions, CRM-type workloads.

- **Heavy** runs in-process Plan-Execute-Reflect. Decomposes tasks into a goal graph (DAG), executes with structured error recovery, then reflects on outcomes. Good for: multi-step reasoning, research, architecture work.

- **Swarm** combines planning with parallel execution. Decomposes a large task into a goal graph, then fans out independent goals as sub-tasks — each routed back through the dispatcher to fast or NanoClaw agents running in parallel. Good for: audits across multiple modules, comprehensive analysis, any task with parallelizable sub-work.

You don't have to choose. Set `agent_type: "auto"` and the classifier picks. Or override explicitly.

---

## Why does this exist?

Most agent frameworks force a choice: fast but shallow, or smart but slow.

This project combines both — and adds coordination:

- **NanoClaw** (the engine behind crm-azteca) proved that container-per-task tool loops handle 90% of real-world agent work. Fast, reliable, production-tested with 1100+ passing tests.

- **Prometheus** (the Plan-Execute-Reflect core, now rewritten in TypeScript) showed that the remaining 10% — complex multi-step tasks — needs planning, error recovery, and reflection.

- **Research validation** (March 2026): The orchestrator-worker pattern is the most deployed multi-agent architecture in production. Difficulty-aware routing drops cost 30-70% while maintaining quality. Anthropic's own guidance endorses this exact tiered approach.

Agent Controller doesn't replace either pattern. It routes to the right one — and can coordinate swarms of them.

### Design principles

1. **100% TypeScript.** One language, one build, one test suite. The Prometheus core was rewritten from Python to TypeScript to eliminate cross-language friction. Shared inference adapter, shared types, no mirroring.

2. **Vendor-agnostic inference.** Raw HTTP to any OpenAI-compatible endpoint. Qwen, MiniMax, vLLM, Together, Groq, Anthropic, OpenAI. Primary + fallback with automatic failover. Zero vendor SDK.

3. **Simplicity first.** One process. SQLite. No Redis, no Postgres, no message queues. Runs on a single VPS. Per Anthropic: "Find the simplest solution possible, and only increase complexity when needed."

4. **Ephemeral execution.** NanoClaw containers start, work, exit. No idle agents consuming resources. Heavy/Swarm run in-process with try/catch isolation.

5. **Observable by default.** Every state change emits an event to a crash-safe SQLite-backed bus. SSE endpoint for real-time monitoring. Token usage tracked per run.

6. **Protocol-aware.** Internal REST for v1. Architecture designed for A2A (agent discovery) and MCP (tool integration) in v2 without rewrite.

---

## How it works

### Task lifecycle

```
POST /api/tasks
      |
  Classifier ── score 0-2:  fast
      |         score 3-5:  nanoclaw
      |         score 6-8:  heavy
      |         score 9+:   swarm
      |         (or explicit override)
      v
  Dispatcher ── idempotency check
      |         concurrency guard (max 5 containers)
      |         create task + run rows
      |
      +──── Fast Runner ──────── in-process tool loop ──── result
      |
      +──── NanoClaw Runner ──── Docker container ──────── result
      |                          (NanoClaw runtime)
      +──── Heavy Runner ─────── in-process ──────────── result
      |                          (Plan-Execute-Reflect)
      +──── Swarm Runner ─────── Heavy planner ──────┐
                                                     |
                            sub-tasks dispatched ←───┘
                            in parallel to fast/
                            nanoclaw runners
                                  |
                            results aggregated
                            reflector evaluates
                                  |
                                result
```

### Fast runner

Calls an LLM with tools, loops until text-only response. Parallel tool execution. Max 10 rounds. 60-second timeout.

Built-in tools: `shell_exec`, `http_fetch`, `file_read`, `file_write`.

### NanoClaw runner

Spawns a Docker container with the NanoClaw agent runtime. Full tool ecosystem (Bash, file ops, web search, browser). Persistent sessions. Container-scoped filesystem. Communication via stdin/stdout sentinel protocol.

### Heavy runner

Runs the Prometheus Plan-Execute-Reflect loop in-process:
1. **Plan** — decompose into goal graph (DAG with dependencies)
2. **Execute** — work through goals with error recovery (retry, alternative, decompose, escalate)
3. **Reflect** — evaluate results, extract learnings

Auto-replans if tool failure rate exceeds threshold or goals get blocked.

### Swarm runner

The planner decomposes the task into a goal graph. Each independent goal becomes a sub-task routed back through the dispatcher. Sub-tasks run in parallel (fast or NanoClaw, based on classification). As sub-tasks complete, newly unblocked goals dispatch. Results aggregate. Reflector evaluates the whole.

Parent-child relationship tracked in the database. Cancelling a swarm cancels all sub-tasks.

### Inference adapter

Vendor-agnostic — raw HTTP to any OpenAI-compatible `/v1/chat/completions` endpoint. Adapted from NanoClaw's production code.

Configure via environment:
```
INFERENCE_PRIMARY_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
INFERENCE_PRIMARY_KEY=sk-...
INFERENCE_PRIMARY_MODEL=qwen3-235b-a22b

INFERENCE_FALLBACK_URL=https://api.minimax.chat/v1   # optional
INFERENCE_FALLBACK_KEY=...                            # optional
INFERENCE_FALLBACK_MODEL=MiniMax-M1                   # optional
```

Automatic failover, exponential backoff on 429/5xx, SSE streaming, truncation detection, model-specific guards.

---

## API

All endpoints require `X-Api-Key` header except health check.

| Method | Path | What it does |
|--------|------|-------------|
| `POST` | `/api/tasks` | Submit a task |
| `GET` | `/api/tasks` | List tasks (filter by status, type, parent) |
| `GET` | `/api/tasks/:id` | Task detail with runs and sub-tasks |
| `POST` | `/api/tasks/:id/cancel` | Cancel (cascades to sub-tasks) |
| `POST` | `/api/agents/register` | Agent self-registration |
| `POST` | `/api/agents/heartbeat` | Agent heartbeat |
| `GET` | `/api/agents` | List agents |
| `GET` | `/api/events/stream` | SSE real-time event stream |
| `GET` | `/health` | Health check (no auth) |

### Examples

```bash
# Fast task
curl -X POST http://localhost:8080/api/tasks \
  -H "X-Api-Key: $MC_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Disk usage","description":"Show disk usage for all volumes","agent_type":"fast","tools":["shell"]}'

# Heavy task — Plan-Execute-Reflect
curl -X POST http://localhost:8080/api/tasks \
  -H "X-Api-Key: $MC_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Refactor auth","description":"Analyze auth module, identify issues, fix, verify with tests","agent_type":"heavy"}'

# Swarm task — fans out to parallel agents
curl -X POST http://localhost:8080/api/tasks \
  -H "X-Api-Key: $MC_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Full audit","description":"Audit all 12 service modules for security vulnerabilities, each module independently","agent_type":"swarm"}'

# Watch events in real time
curl -N http://localhost:8080/api/events/stream -H "X-Api-Key: $MC_API_KEY"
```

---

## Where things live

```
agent-controller/
  src/
    index.ts                 # Server entry point (Hono + @hono/node-server)
    config.ts                # Environment configuration

    db/
      index.ts               # better-sqlite3 singleton, WAL, pragmas
      schema.sql             # Tasks, runs, agents tables

    api/
      index.ts               # Route registration
      auth.ts                # X-Api-Key middleware
      routes/
        tasks.ts             # CRUD + submit + cancel
        agents.ts            # Register, heartbeat, list
        events.ts            # SSE stream
        health.ts            # GET /health

    dispatch/
      classifier.ts          # 4-way heuristic classification
      dispatcher.ts          # Task lifecycle + runner routing + concurrency

    runners/
      types.ts               # RunnerInput/Output interfaces
      fast-runner.ts         # In-process tool loop
      nanoclaw-runner.ts     # NanoClaw Docker container spawn
      heavy-runner.ts        # In-process Plan-Execute-Reflect
      swarm-runner.ts        # Plan decomposition + sub-task fan-out
      container.ts           # Docker spawn/kill/timeout helpers

    inference/
      adapter.ts             # OpenAI-compatible multi-provider LLM client

    tools/
      types.ts               # Tool interface
      registry.ts            # Tool registry
      builtin/
        shell.ts             # Shell exec (timeout, max output)
        http.ts              # HTTP fetch
        file.ts              # File read/write

    prometheus/              # Plan-Execute-Reflect core (TypeScript)
      goal-graph.ts          # DAG: goals, dependencies, status, validation
      orchestrator.ts        # Plan-Execute-Reflect loop with replan triggers
      planner.ts             # LLM-driven task decomposition into goal graph
      executor.ts            # Goal execution with error recovery strategies
      reflector.ts           # Post-task evaluation + learning extraction

    lib/                     # Reused infrastructure
      event-bus.ts           # Event bus singleton
      db.ts                  # Database accessor
      adapters/              # Plugin adapter system (base, registry, prometheus)
      events/                # Persistent event bus (SQLite-backed)
      dispatch/
        idempotency.ts       # Content-hash deduplication
```

---

## Running it

### Local development

```bash
cp .env.example .env       # Edit with your inference provider credentials
npm install
npm run dev
```

Requires: Node 22+, Docker (for NanoClaw runner only), inference provider credentials.

### Docker

```bash
docker compose build
docker compose up
```

Agent Controller spawns NanoClaw containers on-demand via the Docker socket.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MC_API_KEY` | Yes | — | API key for authentication |
| `MC_PORT` | No | `8080` | Server port |
| `MC_DB_PATH` | No | `./data/mc.db` | SQLite database path |
| `INFERENCE_PRIMARY_URL` | Yes | — | LLM provider base URL |
| `INFERENCE_PRIMARY_KEY` | Yes | — | LLM provider API key |
| `INFERENCE_PRIMARY_MODEL` | Yes | — | Model name |
| `INFERENCE_FALLBACK_URL` | No | — | Fallback provider URL |
| `INFERENCE_FALLBACK_KEY` | No | — | Fallback provider key |
| `INFERENCE_FALLBACK_MODEL` | No | — | Fallback model name |
| `INFERENCE_TIMEOUT_MS` | No | `30000` | LLM call timeout |
| `INFERENCE_MAX_TOKENS` | No | `4096` | Max tokens per response |
| `NANOCLAW_IMAGE` | No | `nanoclaw-agent:latest` | NanoClaw container image |
| `MAX_CONCURRENT_CONTAINERS` | No | `5` | Max simultaneous containers |

---

## Current status

**v1 complete.** All 6 phases done. 39 source files, 71 tests passing, zero type errors.

| Phase | Status | What |
|-------|--------|------|
| 1. Foundation | Done | Hono server, SQLite/WAL, X-Api-Key auth, persistent event bus, adapter plugin system |
| 2. Core API + Dispatch | Done | 4-way heuristic classifier, task dispatcher with container queue, task/agent REST routes |
| 3. Inference + Fast Runner | Done | Vendor-agnostic LLM adapter (primary+fallback), tool registry, built-in tools, fast runner |
| 4. Prometheus Core | Done | Goal graph DAG, planner, executor, reflector, orchestrator, heavy runner |
| 5. NanoClaw + Swarm | Done | Docker container runner with sentinel protocol, swarm fan-out with depth guard (max 3) |
| 6. SSE + Docker + Polish | Done | SSE stream with replay/filtering, Dockerfile, docker-compose, Makefile, vitest config |

---

## Origins

Built from analysis of two open-source frameworks and one production system:

- **hermes-agent** (nousresearch) — 814 files, 50+ tools, 85+ skills. Taught us agent architecture. Its gaps (no planning, no reflection) defined the Prometheus core.

- **mission-control** (builderz-labs) — 546 files, Next.js fleet dashboard. Taught us fleet orchestration. Its 136 issues shaped our infrastructure improvements.

- **NanoClaw** — Production engine for crm-azteca's WhatsApp AI agents. 1100+ tests. Proved that container-per-task tool loops handle most real agent work. Its inference adapter, container spawning, and concurrency patterns are directly reused.

Validated against industry research (March 2026): orchestrator-worker is the dominant production pattern, difficulty-aware routing saves 30-70% cost, and Anthropic endorses the tiered complexity approach.
