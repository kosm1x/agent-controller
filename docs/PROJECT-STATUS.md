# Project Status — Agent Controller (Mission Control)

> Last updated: 2026-03-21

## Overview

Unified AI agent orchestrator. Routes tasks by complexity to the right runner type. Single TypeScript process, SQLite, Hono HTTP server. Jarvis — a general-purpose strategic AI assistant with internet access, Google Workspace integration, adaptive intelligence, and long-term memory.

**Repo**: `/root/claude/mission-control/` | GitHub: `kosm1x/agent-controller`

## Metrics

| Metric | Value |
|--------|-------|
| Source files | ~120 |
| Test files | 50 |
| Tests passing | 479 |
| Type errors | 0 |
| Total tools | 96 (20 commit-bridge + 28 builtin + 3 memory + 2 skill + 14 Google + 10 browser + 19 other MCP) |
| Dependencies | 6 core + 2 messaging (hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk, node-cron, @opendataloader/pdf + @whiskeysockets/baileys, grammy) |

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
| v2.13 | Web Read — Jina Reader integration, Telegram PDF/file extraction | Done | `cbe1a4c` |
| v2.14 | Production Guards — tertiary LLM fallback, port conflict check, destructive tool confirmation | Done | — |
| v2.15 | Local PDF — OpenDataLoader PDF replaces Jina for PDFs (local Java extraction, no rate limits) | Done | — |
| v2.16 | Agent-Orchestrator Integration — ToolSource plugin system, reaction engine, swarm sibling context | Done | — |
| v2.17 | Admin CLI — mc-ctl bash tool (22 commands: service lifecycle, tasks, outcomes, schedules, tools, memory, hindsight, raw DB) | Done | — |
| v2.17.1 | Dynamic Scheduled Tasks — cron-based task scheduling via LLM tools, timezone-aware | Done | — |
| v2.18 | Context Retention — user_facts table, keyword recall, larger thread buffer | Done | `7c26dd1` |
| v2.18.1 | Inference Resilience — max-rounds wrap-up, mid-loop recovery, tool result truncation, lean wrap-up context | Done | `f58869c` |
| v2.19 | Browser Integration — Lightpanda headless browser via MCP (10 tools: goto, markdown, links, evaluate, semantic_tree, interactiveElements, structuredData, click, fill, scroll) | Done | — |
| v2.20 | Jarvis Chat Enhancements — sandboxed shell_exec, expanded chat tool whitelist (+5 utility +10 browser), tools_used tracking fix, system prompt behavioral directives (verification, proactive memory, skill auto-save), skill-discovery auto-save, tool-first guard against cognitive laziness | Done | — |
| v2.21 | Coding Toolkit — file_edit, grep, glob, list_dir tools (open-swe inspired) | Done | — |
| v2.22 | WordPress + Anti-Hallucination — wp_list_posts/wp_read_post/wp_publish/wp_media_upload/wp_categories (5 tools, multi-site), content destruction safeguard, hallucination detector in fast-runner (EN+ES patterns), HTML Telegram formatter, scope pattern inflection fix | Done | — |
| v2.22.1 | WordPress Content Protection — file-based read/write pipeline (bypasses 12K tool result truncation), 3-layer destruction safeguard (80% text + 70% HTML + 30% structure), read-before-write enforcement, status-only vs content-edit protocol split | Done | — |
| v2.23 | Telegram Vision — Jarvis can see images sent via Telegram (base64 download → multimodal content array → LLM) | Done | — |
| v3.0 | Production Hardening — systemd, log rotation, monitoring, LLM quality | Planned | — |

## Tools (87 total, managed by 5 ToolSource plugins)

| Category | Tools | Count |
|----------|-------|-------|
| Builtin | shell_exec, http_fetch, file_read, file_write, file_edit, grep, glob, list_dir, web_search, web_read, weather_forecast, currency_convert, geocode_address, chart_generate, rss_read, schedule_task, list_schedules, delete_schedule, user_fact_set, user_fact_list, user_fact_delete, evolution_get_data, evolution_deactivate_skill | 23 |
| WordPress | wp_list_posts, wp_read_post, wp_publish, wp_media_upload, wp_categories | 5 |
| Browser (Lightpanda) | browser__goto, browser__markdown, browser__links, browser__evaluate, browser__semantic_tree, browser__interactiveElements, browser__structuredData, browser__click, browser__fill, browser__scroll | 10 |
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
| 2026-03-21 | — | fix: prevent infinite retry loops on max-rounds chat tasks. 3-layer fix: wrap-up instructions include STATUS: DONE_WITH_CONCERNS guidance, fast-runner promotes BLOCKED/NEEDS_CONTEXT with >100 chars to success, reaction engine skips messaging tasks entirely. Root cause: LLM exhausted rounds on failing browser tools → wrap-up STATUS: BLOCKED → task failed → reaction engine spawned new task (fresh previousAttempts=0) → unbounded chain |
| 2026-03-21 | — | feat: v2.23 Telegram vision — Jarvis can see images. Pipeline: Telegram photo → base64 download → imageUrl on IncomingMessage/ConversationTurn → multimodal content array in fast-runner → LLM vision. qwen3.5-plus on DashScope coding-intl natively supports vision (discovered via API probing). New file: src/inference/vision.ts (unused but retained for future dedicated VL model calls) |
| 2026-03-21 | — | fix: WordPress content protection v2 — file-based content pipeline (wp_read_post saves to /tmp, wp_publish reads via content_file param), 3-layer destruction safeguard (80% text/70% HTML/30% structure), read-before-write enforcement (module-level tracking), status-only protocol for republish (prevents prompt bloat), 19 new tests |
| 2026-03-20 | — | v2.22: WordPress multi-site tools (wp_publish, wp_media_upload, wp_categories), hallucination detector (narrated execution → retry with correction), HTML Telegram formatter (replaces broken MarkdownV2), scope pattern inflection fix (Spanish plural/conjugation), list_schedules promoted to always-available, anti-hallucination system prompt directive |
| 2026-03-20 | — | v2.21: Coding toolkit — file_edit, grep, glob, list_dir (open-swe inspired) |
| 2026-03-20 | — | v2.20: Jarvis chat enhancements — sandboxed shell, expanded tool whitelist (29→44 tools), tools_used tracking fix, behavioral directives (auto-verify, proactive memory, skill auto-save), tool-first guard (enrichment-level pattern matching against cognitive laziness) |
| 2026-03-19 | — | fix: timezone — TZ=America/Mexico_City in systemd service, proactive.ts daily counter uses MX time not UTC |
| 2026-03-18 | `f58869c` | v2.18.1: Tool result truncation (6K cap), lean wrap-up context, web_read 30K→10K |
| 2026-03-18 | `b400ed5` | v2.18.1: Mid-loop inference failure wrap-up, MAX_ROUNDS 10→7, timeout 30s→60s |
| 2026-03-18 | `9075e2a` | v2.18.1: Max-rounds wrap-up call + health check resilience for DashScope |
| 2026-03-18 | `7c26dd1` | v2.18: Context retention — user_facts table, keyword recall, thread buffer 5→15 |
| 2026-03-18 | `6b3fc43` | v2.17: mc-ctl admin CLI — 22 commands, bash script, same pattern as crm-ctl |
| 2026-03-18 | — | v2.16: ToolSource plugin system (5 adapters), reaction engine (auto-retry/escalate on task failures), swarm sibling context injection. Inspired by ComposioHQ/agent-orchestrator patterns |
| 2026-03-18 | — | v2.15: Local PDF extraction via OpenDataLoader (replaces Jina for PDFs, Java 17 headless, unlimited local parsing) |
| 2026-03-17 | — | Switch fallback model from MiniMax-M2.5 to qwen3.5-flash (same provider, no cross-vendor quirks) |
| 2026-03-17 | `c7ed74d` | v2.14: Tertiary LLM fallback, port conflict check, destructive tool confirmation guard |
| 2026-03-17 | `e908be6` | Prune v2.10 (gVisor), add v3.0 Production Hardening roadmap |
| 2026-03-17 | `cbe1a4c` | Web read tool (Jina Reader) + Telegram document/photo extraction |
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
- deepseek-v3.2 never voluntarily stops calling tools on research tasks — mitigated by MAX_ROUNDS=7 + wrap-up call
- Primary model (glm-5) intermittently slow on DashScope coding-intl — falls back to qwen3.5-plus
- DashScope coding-intl endpoint has no `/models` listing and no dedicated VL models — but qwen3.5-plus natively supports vision via multimodal content arrays
- ~~Proactive daily counter reset used UTC instead of Mexico City time~~ (fixed 2026-03-19)
- ~~tools_used always empty in task_outcomes (fast-runner returned plain string instead of structured output)~~ (fixed 2026-03-20)
- ~~WordPress content destruction: wp_publish with post_id + partial content replaced entire articles; root cause was 12K tool result truncation in inference adapter stripping article middles~~ (fixed 2026-03-21, file-based pipeline)
- ~~Max-rounds chat tasks triggered infinite retry loops: wrap-up STATUS: BLOCKED → task failed → reaction engine spawned new task with fresh previousAttempts → unbounded chain~~ (fixed 2026-03-21, 3-layer: wrap-up STATUS guidance + BLOCKED→success promotion + messaging retry skip)
