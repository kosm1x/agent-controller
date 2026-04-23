# Agent Controller

A unified orchestrator that receives tasks and routes them to the right kind of AI agent — from fast in-process tool loops to heavy planning agents to coordinated swarms — all through a single API.

---

## What is this?

Agent Controller is a single backend service that sits between you and your AI agents. You submit a task through the API. It classifies by complexity, picks the right execution strategy, runs it, and streams results back in real time.

Five runner types, one dispatcher:

- **Fast** runs in-process. LLM + tools, loop until done, return. Seconds, not minutes. Good for: running a command, fetching data, quick file edits.

- **NanoClaw** spawns an isolated Docker container with the full NanoClaw agent runtime — persistent sessions, container-scoped filesystem, rich tool ecosystem. Good for: tasks needing isolation, longer tool sessions, CRM-type workloads.

- **Heavy** runs in-process Plan-Execute-Reflect. Decomposes tasks into a goal graph (DAG), executes with structured error recovery, then reflects on outcomes. Good for: multi-step reasoning, research, architecture work.

- **Swarm** combines planning with parallel execution. Decomposes a large task into a goal graph, then fans out independent goals as sub-tasks — each routed back through the dispatcher to fast or NanoClaw agents running in parallel. Good for: audits across multiple modules, comprehensive analysis, any task with parallelizable sub-work.

- **A2A** delegates to external A2A-compatible agents. Discovers the remote agent via its agent card, sends the task via JSON-RPC, polls until complete. Good for: interop with LangGraph, CrewAI, AutoGen, or other MC instances.

You don't have to choose. Set `agent_type: "auto"` and the classifier picks. Or override explicitly. (A2A is explicit-only — the classifier never auto-selects it.)

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

2. **Multi-provider inference.** Claude Agent SDK (primary, Max Plan billing) + raw HTTP to any OpenAI-compatible endpoint (fallback). Groq, DashScope, Anthropic API, OpenAI, Together, DeepInfra. 3-provider cascade with circuit breaker + automatic failover. One env var to switch primary provider.

3. **Simplicity first.** One process. SQLite. No Redis, no Postgres, no message queues. Runs on a single VPS. Per Anthropic: "Find the simplest solution possible, and only increase complexity when needed."

4. **Ephemeral execution.** NanoClaw containers start, work, exit. No idle agents consuming resources. Heavy/Swarm run in-process with try/catch isolation.

5. **Observable by default.** Every state change emits an event to a crash-safe SQLite-backed bus. SSE endpoint for real-time monitoring. Token usage tracked per run.

6. **Protocol-aware.** REST API for task management. MCP for external tool servers. A2A for agent-to-agent interoperability. All protocol endpoints coexist on a single Hono server.

7. **Dashboard included.** Real-time web UI at `/dashboard/` — task management, agent fleet monitoring, live event stream, goal graph visualization. No build pipeline, no extra dependencies.

---

## How it works

### Task lifecycle

```
POST /api/tasks           POST /a2a (JSON-RPC)
      |                        |
      |   ┌────────────────────┘
      |   |     sendMessage → mapper → submitTask()
      v   v
  Classifier ── score 0-2:  fast
      |         score 3-5:  nanoclaw
      |         score 6-8:  heavy
      |         score 9+:   swarm
      |         explicit:   a2a (delegate to remote)
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
      |                                              |
      |                     sub-tasks dispatched ←───┘
      |                     in parallel to fast/
      |                     nanoclaw runners
      |                           |
      |                     results aggregated
      |                     reflector evaluates
      |                           |
      |                         result
      |
      +──── A2A Runner ─────── delegate to remote ──── poll ──── result
                                A2A agent via
                                JSON-RPC
```

### Fast runner

Calls an LLM with tools, loops until text-only response. Parallel tool execution. Up to 35 rounds (coding) / 10 default. Multi-layer guards: doom-loop detection, escalation ladder, circuit breakers, session repair.

246 tools across builtin (154), MCP (65), Google (21), memory (4), skills (2). Tool deferral: 147 builtin + 30 MCP tools send name+description only — full schema on demand (52% prompt token reduction).

### NanoClaw runner

Spawns a Docker container with the NanoClaw agent runtime. Full tool ecosystem (Bash, file ops, web search, browser). Persistent sessions. Container-scoped filesystem. Communication via stdin/stdout sentinel protocol.

### Heavy runner

Runs the Prometheus Plan-Execute-Reflect loop in-process:

1. **Plan** — decompose into goal graph (DAG with dependencies)
2. **Execute** — work through goals with error recovery (retry, alternative, decompose, escalate)
3. **Self-assess** — each goal checks its output against completion criteria; if not met, injects reflection and re-runs (up to 2 rounds)
4. **Reflect** — evaluate results, extract learnings

Auto-replans if tool failure rate exceeds threshold or goals get blocked.

### Swarm runner

The planner decomposes the task into a goal graph. Each independent goal becomes a sub-task routed back through the dispatcher. Sub-tasks run in parallel (fast or NanoClaw, based on classification). As sub-tasks complete, newly unblocked goals dispatch. Results aggregate. Reflector evaluates the whole.

Parent-child relationship tracked in the database. Cancelling a swarm cancels all sub-tasks.

### A2A runner

Delegates tasks to external A2A-compatible agents. The runner:

1. Fetches the remote agent's card from `/.well-known/agent.json` (cached 5 min)
2. Sends the task via `sendMessage` JSON-RPC
3. Polls `getTask` with exponential backoff (1s → 15s, 10 min timeout)

Requires explicit `agent_type: "a2a"` and `input: { a2a_target: "http://remote:8080", a2a_key: "optional" }`.

### A2A server

MC also acts as an A2A server — external agents can discover MC and submit tasks:

- `GET /.well-known/agent.json` — Agent card (no auth, per A2A spec)
- `POST /a2a` — JSON-RPC endpoint (requires `X-Api-Key`)
  - `sendMessage` — submit a task
  - `getTask` — get task status + artifacts
  - `cancelTask` — cancel a task
  - `sendStreamingMessage` — submit + receive SSE updates

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

### MCP tool servers (v2)

Any MCP-compatible tool server can be connected via `mcp-servers.json`:

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}
```

MCP tools are automatically discovered at startup and registered alongside built-in tools. Tool names are namespaced as `{serverId}__{toolName}` (e.g., `filesystem__read_file`). All existing runners (fast, heavy, swarm) can use MCP tools with zero configuration — just include the namespaced tool name in the `tools` array when submitting a task, or omit `tools` to make all tools available.

Set `MC_MCP_CONFIG` to point to a custom config path, or place `mcp-servers.json` in the project root. If the config file doesn't exist, the system works exactly as before with only built-in tools.

---

## API

All endpoints require `X-Api-Key` header except health check.

| Method | Path                      | What it does                                |
| ------ | ------------------------- | ------------------------------------------- |
| `POST` | `/api/tasks`              | Submit a task                               |
| `GET`  | `/api/tasks`              | List tasks (filter by status, type, parent) |
| `GET`  | `/api/tasks/:id`          | Task detail with runs and sub-tasks         |
| `POST` | `/api/tasks/:id/cancel`   | Cancel (cascades to sub-tasks)              |
| `POST` | `/api/agents/register`    | Agent self-registration                     |
| `POST` | `/api/agents/heartbeat`   | Agent heartbeat                             |
| `GET`  | `/api/agents`             | List agents                                 |
| `GET`  | `/api/events/stream`      | SSE real-time event stream                  |
| `GET`  | `/health`                 | Health check (no auth)                      |
| `GET`  | `/dashboard/`             | Web dashboard (no auth, JS handles API key) |
| `GET`  | `/.well-known/agent.json` | A2A agent card (no auth)                    |
| `POST` | `/a2a`                    | A2A JSON-RPC endpoint                       |

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

# A2A: Discover agent capabilities (no auth)
curl http://localhost:8080/.well-known/agent.json

# A2A: Send a task via JSON-RPC
curl -X POST http://localhost:8080/a2a \
  -H "X-Api-Key: $MC_API_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"sendMessage","id":1,"params":{"message":{"role":"user","parts":[{"type":"text","text":"What is 2+2?"}]}}}'

# A2A: Delegate to a remote agent
curl -X POST http://localhost:8080/api/tasks \
  -H "X-Api-Key: $MC_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Remote task","description":"Delegate this","agent_type":"a2a","input":{"a2a_target":"http://other-agent:8080","a2a_key":"their-key"}}'
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
      classifier.ts          # 5-way heuristic classification
      dispatcher.ts          # Task lifecycle + runner routing + concurrency

    runners/
      types.ts               # RunnerInput/Output interfaces
      fast-runner.ts         # In-process tool loop
      nanoclaw-runner.ts     # NanoClaw Docker container spawn
      heavy-runner.ts        # In-process Plan-Execute-Reflect
      swarm-runner.ts        # Plan decomposition + sub-task fan-out
      a2a-runner.ts          # Delegate to external A2A agents
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

    mcp/                     # MCP tool server integration (v2)
      types.ts               # Config schema, namespace separator
      config.ts              # Load mcp-servers.json
      bridge.ts              # MCP tool → MC Tool adapter
      manager.ts             # Connect servers, discover tools, register
      index.ts               # initMcp(), shutdownMcp()

    a2a/                     # A2A agent interoperability (v2)
      types.ts               # A2A protocol types, JSON-RPC, status mapping
      agent-card.ts          # Dynamic agent card builder
      mapper.ts              # Bidirectional MC ↔ A2A conversion
      server.ts              # JSON-RPC handler (sendMessage, getTask, etc.)
      client.ts              # RPC client + agent card cache
      index.ts               # Barrel exports

    prometheus/              # Plan-Execute-Reflect core (TypeScript)
      goal-graph.ts          # DAG: goals, dependencies, status, validation
      orchestrator.ts        # Plan-Execute-Reflect loop with replan triggers
      planner.ts             # LLM-driven task decomposition into goal graph
      executor.ts            # Goal execution with error recovery + self-assessment
      reflector.ts           # Post-task evaluation + learning extraction

    lib/                     # Reused infrastructure
      event-bus.ts           # Event bus singleton
      db.ts                  # Database accessor
      adapters/              # Plugin adapter system (base, registry, prometheus)
      events/                # Persistent event bus (SQLite-backed)
      dispatch/
        idempotency.ts       # Content-hash deduplication

  public/
    dashboard/
      index.html             # SPA shell, CSS, layout
      app.js                 # State management, SSE, init flow
      api.js                 # REST + SSE client (fetch-based)
      components.js          # All UI rendering components
      graph.js               # Goal graph SVG renderer
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

| Variable                    | Required | Default                   | Description                 |
| --------------------------- | -------- | ------------------------- | --------------------------- |
| `MC_API_KEY`                | Yes      | —                         | API key for authentication  |
| `MC_PORT`                   | No       | `8080`                    | Server port                 |
| `MC_DB_PATH`                | No       | `./data/mc.db`            | SQLite database path        |
| `INFERENCE_PRIMARY_URL`     | Yes      | —                         | LLM provider base URL       |
| `INFERENCE_PRIMARY_KEY`     | Yes      | —                         | LLM provider API key        |
| `INFERENCE_PRIMARY_MODEL`   | Yes      | —                         | Model name                  |
| `INFERENCE_FALLBACK_URL`    | No       | —                         | Fallback provider URL       |
| `INFERENCE_FALLBACK_KEY`    | No       | —                         | Fallback provider key       |
| `INFERENCE_FALLBACK_MODEL`  | No       | —                         | Fallback model name         |
| `INFERENCE_TIMEOUT_MS`      | No       | `30000`                   | LLM call timeout            |
| `INFERENCE_MAX_TOKENS`      | No       | `4096`                    | Max tokens per response     |
| `NANOCLAW_IMAGE`            | No       | `nanoclaw-agent:latest`   | NanoClaw container image    |
| `MAX_CONCURRENT_CONTAINERS` | No       | `5`                       | Max simultaneous containers |
| `MC_MCP_CONFIG`             | No       | `./mcp-servers.json`      | Path to MCP servers config  |
| `A2A_AGENT_NAME`            | No       | `Mission Control`         | A2A agent card display name |
| `A2A_AGENT_URL`             | No       | `http://localhost:{port}` | A2A agent card base URL     |

---

## Current status

**Phase β complete (F1→F9 + β-addendum 1a/1b/1c) + Phase γ 13/13 original scope + v7.5 extended scope Done. Session 101 (2026-04-22 → 2026-04-23): 30-day hardening audit COMPLETE — ALL 5 DIMENSIONS CLOSED.** Dim-1 Efficiency (4 observability bugs + Anthropic prompt cache broken by `${mxTime}` in identitySection — live-verified 0% → 56% cache hit, 52% cost reduction per turn); Dim-2 Speed (Hindsight recall 5000ms → 1500ms, 70% wall-clock reduction per recall); Dim-3 Security (double-audit discipline closed 9 Critical + 7 Major — SSRF on 3 fetch tools + path-exfil on 6 tools including `wp_publish`/`google_docs`/`google_drive` contentFile, `sanitizeToolResult` never wired on claude-sdk path, shell_exec cat-bypass of denylist, symlink escape, XFF rate-limit bypass); Dim-4 Resilience (double-audit closed 5 Critical + 2 Major — claude-sdk had zero circuit-breaker integration since Sonnet flip, no startup reconciliation of orphaned tasks after SIGKILL/OOM, static ritual failures invisible to `events` table, Prometheus fan-out spuriously escalated breaker-OPEN errors during recovery, `recordRitualFailure` bare `catch {}` swallowed programming bugs, silent reconcile-flip with no `task.failed` event → no retry / no user notification, `providerOutcome` null default inverted); Dim-5 Tool Scoping (1 Critical + 2 Major — NFC normalization gap on background-agent path where `taskText` flowed raw into scope regex bypassing the main-path normalize at router.ts:1450 — fixed via defense-in-depth inside `scopeToolsForMessage` + `detectActiveGroups`, idempotent; `intel_query.source` enum miss; `http_fetch` description expanded from 87-char stub to full WHEN/NOT/BOUNDARIES spec). **30-day hardening window**: measurement portion complete day-1; only day-30 re-benchmark (2026-05-22) + any in-flight P0 hardening items remain. **Session 100 (2026-04-22)**: Sonnet 4.6 now primary across ALL runners — fast, heavy-in-process, Prometheus, nanoclaw, and heavy-containerized — via `INFERENCE_PRIMARY_PROVIDER=claude-sdk`. Rollback to qwen with `INFERENCE_PRIMARY_PROVIDER=openai`. **3733 tests passing** (239 test files), zero type errors, **246 tools** (builtin 154 + MCP 65 + Google 21 + memory 4 + skills 2), 15 core + 2 messaging deps. β delivered: Financial Signal Detection Stack — data layer (F1), indicator engine + watchlist tools (F2/F4), macro regime + signal detector (F5/F3), prediction-markets & whale tracking (F6/F6.5), alpha combination engine (F7), strategy backtester with CPCV+PBO+DSR firewall (F7.5), paper-trading executor (F8/F8.1a-c), morning/EOD rituals (F9). Phase γ shipped: v7.12 diagram_generate, v7.14 infographic_generate, v7.2 weekly autoseed, v7.10, v7.1 chart rendering + patterns, v7.11 Jarvis Teaching Module, v7.3 P1/P2/P3/P5 SEO+GEO suite, v7.3 P4a Digital Marketing Buyer, v7.4 S1+S2a Video Production, v7.4.3 HTML-as-Composition DSL, **v7.5 Skill Evolution Engine (GEPA confidence proxy + SkillClaw failure classifier + trajectory mining + HyperAgents `score_child_prop` parent selection + Memoria-pattern cooldown + Superpowers inline self-review — 6-item surgical extension to existing `src/tuning/` module)**, plus NorthStar↔COMMIT 2-way LWW sync. Remaining from extended scope: credential-gated P4b/P4c/S2b; v7.5.1 + v7.6 deferrals per roadmap. See `docs/V7-ROADMAP.md` and PROJECT-STATUS.md.

| Phase        | Status | What                                                                                                                                                                 |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1           | Done   | Foundation — Hono server, SQLite, 5-way classifier, dispatcher, fast/nanoclaw/heavy/swarm/a2a runners, Prometheus core, MCP integration, A2A protocol, web dashboard |
| v2.1–v2.13   | Done   | Tool plugin system, browser (Lightpanda), web search/read, local PDF, Google Workspace (19 tools), Hindsight memory, adaptive intelligence                           |
| v2.14–v2.22  | Done   | Production guards, coding toolkit, WordPress (10 tools), hallucination detector, dynamic tool scoping, Telegram vision, sandboxed shell                              |
| v2.23–v2.26  | Done   | Jarvis unification, project entity, strategic autonomy, HyperAgents, self-tuning overnight loop                                                                      |
| v2.27–v2.30  | Done   | Self-tuning eval harness, 7-layer hallucination defense, 3 new tools (pdf_read, hf_generate, hf_spaces), fast-path (~2s), Telegram streaming, scope isolation        |
| v3.0         | Done   | Production hardening — systemd, Pino logging, 3-layer guardrails, model benchmark, provider rotation                                                                 |
| v4.0 S1–S9   | Done   | DB indexes, shell security, Gemini research, observability, hallucination protocol, Playwright, scope telemetry, decomposition (894 tests)                           |
| v5.0 S1a–S1b | Done   | Guard upgrades (4-layer doom-loop, escalation ladder, circuit breakers, session repair) + Memory (compaction pipeline, auto-persist, spending quotas)                |
| v5.0 S2      | Done   | Concurrent task isolation (per-task context, task_history tool)                                                                                                      |
| v5.0 S4      | Done   | CRM integration (bidirectional REST, jarvis-pull)                                                                                                                    |
| v5.0 S5b     | Done   | Knowledge maps (2 tools, 2 tables, Prometheus integrated)                                                                                                            |
| v5.0 S5c     | Done   | Research verification (provenance tracking, source anchoring, condensation)                                                                                          |
| v5.0 S5      | Done   | Classifier calibration (dynamic messaging tier, rephrase fix, feedback quality loop, weighted eval scoring)                                                          |
| v5.0 S6–S8   | Done   | Intelligence Depot (8 sources, delta engine, alert router, baselines, z-scores, 4 Jarvis tools, ritual integration)                                                  |
| Coding       | Done   | 6 git/GitHub tools, coding directive, NanoClaw Docker sandbox (nanoclaw-coding:latest), volume mount support, sandbox E2E verified                                   |
| NorthStar    | Done   | Visions/goals/objectives/tasks as plain markdown files in Jarvis file system (replaced 22-tool database system)                                                      |

See `docs/V7-ROADMAP.md` for the active roadmap and `docs/PROJECT-STATUS.md` for detailed phase history. v6 roadmap archived at `docs/archive/V6-ROADMAP-session67-final.md`.

### Jarvis — the user-facing persona

Jarvis is a strategic AI assistant accessible via Telegram and WhatsApp. Built on top of the agent controller:

- **246 tools** across 5 source plugins (builtin 154, MCP 65, Google 21, memory 4, skills 2)
- **Tool deferral** — 147 builtin + 30 MCP tools deferred (name+desc only, full schema on first call). 52% prompt token reduction
- **Background agents** — "lanza un agente" spawns parallel workers with fork child boilerplate, structured output, 3 max concurrent
- **Coding capability** — write code, run tests, commit, push to GitHub, create PRs (6 git tools, NanoClaw Docker sandbox)
- **Video production** — 9 tools: script → per-scene TTS → overlay composition → FFmpeg → MP4 (324 voices, background library, HiDPI screenshots)
- **Content pipeline** — screenshot_element (HiDPI), humanize_text (AI writing filter), dashboard_generate (ECharts), social publishing scaffolding
- **NorthStar** — visions, goals, objectives, tasks as plain markdown files in unified file system
- **Unified file system** — 350 files, 8-folder hierarchy (NorthStar, projects, knowledge, logs, directives, workspace, inbox, VPS). Project README auto-injection
- **9 automated rituals** (morning briefing, nightly close, weekly review, skill evolution, overnight tuning, proactive scanner, signal intelligence, evolution log, diff digest)
- **Dynamic tool scoping** — 15-30 full-schema tools per message (down from 60-80), with KB omission for read-only tasks
- **7-layer hallucination defense** + verification discipline nudge + critical system reminder (re-injected every 3 rounds)
- **Path safety pipeline** — 6-check validatePathSafety + isDangerousRemovalPath + DANGEROUS_FILES/DIRECTORIES
- **Behavioral coherence** — 10 patterns from Claude Code architecture (tool deferral, structured compaction, never-delegate-understanding, continue-vs-spawn, memory drift verification)
- **Streaming responses** — progressive Telegram message updates
- **Fast-path** — 1-2 word greetings skip full pipeline (~2s). 3+ words always use enhancer + tools
- **Hybrid memory** — FTS5 full-text + pgvector semantic search (Supabase) + Ebbinghaus retention decay + background memory extraction
- **Intel Depot** — 8 signal sources, delta engine, z-score anomaly detection, 4 Jarvis tools
- **Document research** — Gemini-powered deep analysis, summaries, study guides, quizzes, podcast generation
- **Google Workspace** — Gmail, Calendar, Drive, Sheets, Docs, Slides, Tasks (21 tools)
- **WordPress multi-site** — content management with destruction safeguards (10 tools)
- **Autonomous improvement** — SG1-SG5 safeguards (diff digest, kill switch, immutable core, directive cooldown, pre-cycle git tags)
- **3-provider cascade** — Claude Sonnet (Agent SDK) → Groq/Llama 4 Scout → DashScope/qwen3.5-plus. Switchable via `INFERENCE_PRIMARY_PROVIDER` env var

---

## Origins

Built from analysis of two open-source frameworks and one production system:

- **hermes-agent** (nousresearch) — 814 files, 50+ tools, 85+ skills. Taught us agent architecture. Its gaps (no planning, no reflection) defined the Prometheus core.

- **mission-control** (builderz-labs) — 546 files, Next.js fleet dashboard. Taught us fleet orchestration. Its 136 issues shaped our infrastructure improvements.

- **NanoClaw** — Production engine for crm-azteca's WhatsApp AI agents. 1100+ tests. Proved that container-per-task tool loops handle most real agent work. Its inference adapter, container spawning, and concurrency patterns are directly reused.

Validated against industry research (March 2026): orchestrator-worker is the dominant production pattern, difficulty-aware routing saves 30-70% cost, and Anthropic endorses the tiered complexity approach.
