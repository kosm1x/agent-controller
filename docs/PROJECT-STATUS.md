# Project Status — Agent Controller (Mission Control)

> Last updated: 2026-03-17

## Overview

Unified AI agent orchestrator. Routes tasks by complexity to the right runner type. Single TypeScript process, SQLite, Hono HTTP server. Jarvis — a general-purpose strategic AI assistant with internet access, Google Workspace integration, adaptive intelligence, and long-term memory.

**Repo**: `/root/claude/mission-control/` | GitHub: `kosm1x/agent-controller`

## Metrics

| Metric | Value |
|--------|-------|
| Source files | ~90 (+5 in commit-bridge) |
| Test files | 29 |
| Tests passing | 250 |
| Type errors | 0 |
| Total tools | 43 (20 commit-bridge + 6 builtin + 3 memory + 2 skill + 14 Google + web_search) |
| Dependencies | 5 core + 2 messaging (hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk, node-cron + @whiskeysockets/baileys, grammy) |

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
| v2.6 | JARVIS Integration — commit-bridge MCP server (20 tools), ritual scheduler | Done | — |
| v2.7 | Messaging Layer — WhatsApp + Telegram bidirectional messaging, ritual broadcast | Done | — |
| v2.8 | Hindsight Memory — semantic long-term memory, SQLite fallback, conversation memory | Done | — |
| v2.9 | Adaptive Intelligence — learning, adaptation, prediction, skills | Done | — |
| v2.11 | Google Workspace — 14 tools across 7 APIs (Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks) | Done | `9e621da` |
| v2.12 | Web Search — Brave Search API integration | Done | `6f5dcfc` |
| v2.10 | gVisor/Firecracker — kernel-level sandbox for containers | Planned | — |

## Tools (43 total)

| Category | Tools | Count |
|----------|-------|-------|
| Builtin | shell_exec, http_fetch, file_read, file_write, web_search | 5 |
| Memory | memory_search, memory_store, memory_reflect | 3 |
| Skills | skill_save, skill_list | 2 |
| COMMIT (read) | get_daily_snapshot, get_hierarchy, list_tasks, list_goals, list_objectives, search_journal, list_ideas | 7 |
| COMMIT (write) | update_status, complete_recurring, create_task, create_goal, create_objective, create_vision, update_task, update_objective, update_goal, update_vision, delete_item, bulk_reprioritize | 12 |
| COMMIT (journal) | search_journal (read-only — journal write is user-only) | 1 |
| Gmail | gmail_send, gmail_search | 2 |
| Drive | gdrive_list, gdrive_create, gdrive_share | 3 |
| Calendar | calendar_list, calendar_create, calendar_update | 3 |
| Sheets | gsheets_read, gsheets_write | 2 |
| Docs | gdocs_read, gdocs_write | 2 |
| Slides | gslides_create | 1 |
| Tasks | gtasks_create | 1 |

## Rituals

| Ritual | Time | Delivery |
|--------|------|----------|
| Morning briefing | 7:00 AM Mexico City | Email (fede@eureka.md) + Telegram |
| Nightly close | 10:00 PM Mexico City | Email (fede@eureka.md) + Telegram |
| Evolution log | 11:59 PM Mexico City | Appends to docs/EVOLUTION-LOG.md |
| Proactive scanner | 8AM, noon, 4PM, 8PM | Telegram (max 2 nudges/day) |

## Recent Changes

| Date | Commit | Description |
|------|--------|-------------|
| 2026-03-17 | `95a3aa9` | Journal is user-only — rituals email reports via gmail_send instead of writing journal entries |
| 2026-03-17 | `9e621da` | Google Workspace integration — 14 tools across 7 APIs (Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks) |
| 2026-03-17 | `9a5e0a3` | ACI workflow guidance for create_task, create_goal, create_objective — explicit parent UUID lookup steps |
| 2026-03-17 | `fc097cf` | Performance: parallelized memory recall + enrichment (65% faster pre-submission) |
| 2026-03-17 | `8b6ef28` | Enrichment: switched from broken mental models to direct Hindsight recall |
| 2026-03-17 | `da988cc` | Inject Mexico City date/time into every Jarvis prompt |
| 2026-03-16 | `6f5dcfc` | Web search tool (Brave Search API) + expanded Jarvis persona to general-purpose |
| 2026-03-16 | `959bfc1` | v2.9.5: Skill Memory — skills table, skill_save/skill_list tools, skill discovery |
| 2026-03-16 | `29cb6bb` | v2.9.4: Proactive scheduler (4x/day during waking hours) |
| 2026-03-16 | `0d64b39` | v2.9.3: Adaptive classifier + feedback loop |
| 2026-03-16 | `deaef56` | v2.9.2: Enrichment — adaptive prompts with context injection |
| 2026-03-16 | `d2fced5` | v2.9.1: Outcome tracking + mental model seeds |
| 2026-03-16 | `8efb6b0` | SQLite conversation memory, classifier fix, ack, full CRUD, delete_item |
| 2026-03-16 | `61b3ee7` | Hindsight API v2 alignment |

## Known Issues

- SQLite CHECK constraints can't be altered in-place — schema changes require `rm ./data/mc.db`
- SSH keys not configured on VPS — git push uses HTTPS via `gh` CLI
- Hindsight mental model refresh slow with Qwen backend (~2min/model) — using direct recall instead
- Multiple MC restarts can cause Telegram 409 polling conflicts — always kill all instances before restart
