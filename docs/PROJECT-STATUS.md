# Project Status — Agent Controller (Mission Control)

> Last updated: 2026-03-13

## Overview

Unified AI agent orchestrator. Routes tasks by complexity to the right runner type. Single TypeScript process, SQLite, Hono HTTP server.

**Repo**: `/root/claude/mission-control/` | GitHub: `kosm1x/agent-controller`

## Metrics

| Metric | Value |
|--------|-------|
| Source files | 58 (+5 in commit-bridge) |
| Test files | 18 |
| Tests passing | 159 |
| Type errors | 0 |
| Dependencies | 5 (hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk, node-cron) |

## Phase Status

| Phase | Description | Status | Commit |
|-------|------------|--------|--------|
| v1.1 | Foundation — Hono server, SQLite/WAL, X-Api-Key auth, persistent event bus | Done | `33c598f` |
| v1.2 | Core API + Dispatch — 5-way classifier, dispatcher, task/agent REST routes | Done | `4ce2a16` |
| v1.3 | Inference + Fast Runner — vendor-agnostic LLM adapter, tool registry, built-in tools | Done | `c2b7159` |
| v1.4 | Prometheus Core — goal graph DAG, planner, executor, reflector, orchestrator | Done | `b9ade45` |
| v1.5-6 | NanoClaw + Swarm + SSE + Docker — container runner, swarm fan-out, SSE stream | Done | `ae71bda` |
| v2.1 | MCP Integration — external tool servers, bridge, namespaced tools, graceful degradation | Done | `60688d8` |
| v2.2 | A2A Protocol — agent discovery, JSON-RPC server/client, streaming, a2a-runner | Done | `c3239d3` |
| v2.3 | Frontend Dashboard — real-time web UI for tasks/agents/events | Done | — |
| v2.3.1 | Prometheus Core Improvements — token tracking, budgets, compression, repair, learnings, abort | Done | — |
| v2.4 | LiteLLM Backend — sidecar proxy, configurable retries, inference health probe | Done | — |
| v2.5 | Container Heavy Runner — optional Docker isolation for heavy tasks | Done | — |
| v2.6 | JARVIS Integration — commit-bridge MCP server (11 tools), ritual scheduler (morning/nightly) | Done | — |
| v2.7 | Classifier Evolution — ML-based classification from task history | Planned | — |
| v2.8 | gVisor/Firecracker — kernel-level sandbox for containers | Planned | — |

## Runners

| Runner | Type | Status | How it works |
|--------|------|--------|--------------|
| Fast | In-process | Live | LLM + tool loop, max 10 rounds |
| NanoClaw | Docker container | Live | Sentinel stdin/stdout protocol, 5-min timeout |
| Heavy | In-process or Docker | Live | Prometheus PER, optional container isolation via `HEAVY_RUNNER_CONTAINERIZED` |
| Swarm | In-process + sub-tasks | Live | Goal decomposition, parallel fan-out, depth guard (3) |
| A2A | Remote delegation | Live | JSON-RPC to external agents, exponential backoff polling |

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | No | Health check (db + inference reachability) |
| GET | `/dashboard/` | No | Web dashboard |
| GET | `/.well-known/agent.json` | No | A2A agent card |
| POST | `/api/tasks` | Yes | Submit task |
| GET | `/api/tasks` | Yes | List tasks |
| GET | `/api/tasks/:id` | Yes | Task detail + runs + subtasks |
| POST | `/api/tasks/:id/cancel` | Yes | Cancel (cascades) |
| POST | `/api/agents/register` | Yes | Agent self-registration |
| POST | `/api/agents/heartbeat` | Yes | Agent heartbeat |
| GET | `/api/agents` | Yes | List agents |
| GET | `/api/events/stream` | Yes | SSE event stream |
| POST | `/a2a` | Yes | A2A JSON-RPC (sendMessage, getTask, cancelTask, sendStreamingMessage) |

## Recent Changes

| Date | Commit | Description |
|------|--------|-------------|
| 2026-03-13 | — | v2.6: JARVIS integration — commit-bridge MCP server (11 Supabase tools), ritual scheduler (morning briefing + nightly close), validated with live data |
| 2026-03-13 | — | v2.5: Container heavy runner — optional Docker isolation for heavy tasks, worker entrypoint, container slot sharing |
| 2026-03-13 | — | v2.4: LiteLLM sidecar — Docker Compose profile, configurable retries, inference health probe, env.example |
| 2026-03-13 | — | v2.3.1: Prometheus core improvements — token tracking, budget/timeouts, context compression, tool repair, learnings persistence, abort signals |
| 2026-03-13 | — | v2.3: Frontend dashboard — real-time web UI, SSE events, goal graph visualization |
| 2026-03-12 | `c3239d3` | v2.2: A2A protocol — agent discovery, JSON-RPC interop, bidirectional delegation |
| 2026-03-12 | `60688d8` | v2.1: MCP integration — external tool servers via Model Context Protocol |
| 2026-03-12 | `ae71bda` | Phases 5-6: Complete v1 — NanoClaw, Swarm, SSE, Docker, tests |
| 2026-03-12 | `b9ade45` | Phase 4: Prometheus core — Plan-Execute-Reflect in TypeScript |
| 2026-03-12 | `c2b7159` | Phase 3: Inference adapter + tool system + fast runner |
| 2026-03-12 | `4ce2a16` | Phase 2: Core API + Dispatch — classifier, dispatcher, task/agent routes |
| 2026-03-12 | `33c598f` | Phase 1: Foundation — Hono server, SQLite, auth, event bus |

## Available Now

- Full task lifecycle: submit → classify → dispatch → execute → stream results
- 5 runner types with automatic complexity-based routing
- 4 built-in tools (shell_exec, http_fetch, file_read, file_write) + 11 MCP tools (commit-bridge: Supabase read/write for COMMIT-AI)
- A2A interop: MC acts as both A2A server (receives tasks) and client (delegates tasks)
- SSE real-time event stream with replay and filtering
- Prometheus Plan-Execute-Reflect with auto-replan, token tracking, iteration budgets, context compression, and abort propagation
- Swarm parallel decomposition with sub-task fan-out
- Real-time web dashboard at `/dashboard/` with task management, agent fleet view, event log, goal graph SVG
- LiteLLM sidecar proxy for 100+ LLM providers (`docker compose --profile litellm up -d`)
- Optional Docker isolation for heavy tasks (`HEAVY_RUNNER_CONTAINERIZED=true`) — same MC image, container slot sharing
- JARVIS daily rituals: morning briefing (7 AM) and nightly close (10 PM) via node-cron scheduler with idempotency guard
- commit-bridge MCP server: 11 Supabase tools for COMMIT-AI (visions, goals, objectives, tasks, journal, ideas)

## Blocked / Dependencies

| Item | Blocked by | Notes |
|------|-----------|-------|
| v2.3 Frontend Dashboard | — | Done |
| v2.4 LiteLLM | — | Done |
| v2.5 Container Heavy Runner | — | Done |
| v2.6 JARVIS Integration | — | Done |
| v2.7 Classifier Evolution | ~100+ tasks with outcomes | Needs training data from production usage |
| v2.8 gVisor/Firecracker | NanoClaw using Docker | Kernel-level sandbox, low priority |

## Known Issues

- SQLite CHECK constraints can't be altered in-place — schema changes require `rm ./data/mc.db`
- SSH keys not configured on VPS — git push uses HTTPS via `gh` CLI
- No push notifications in A2A (polling and SSE streaming only)
