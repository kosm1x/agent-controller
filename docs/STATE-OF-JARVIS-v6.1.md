# State of Jarvis — v6.1 Milestone

> April 6, 2026

## The System

Jarvis is a unified AI agent orchestrator running on a VPS in Boston. Single TypeScript process, SQLite, Hono HTTP. Routes tasks to 5 runner types (fast, nanoclaw, heavy, swarm, a2a). Talks to the user via Telegram, talks to CRM agents via WhatsApp, exposes an HTTP API.

**Scale**: 228 source files, 105 test files, 1319 tests, 163 tools across 19 Google Workspace + 36 builtin + 10 browser + 6 video + 6 git + 4 intel + 8 KB + 3 memory + rest.

## What's Done (v1.0 - v6.1)

| Layer                        | Status                      | What It Does                                                                                                                                                           |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Infrastructure**           | Stable                      | Hono server, SQLite/WAL, X-Api-Key auth, systemd, Prometheus+Grafana monitoring                                                                                        |
| **Dispatch**                 | Stable                      | 5-way classifier, dispatcher, fast/nanoclaw/heavy/swarm/a2a runners                                                                                                    |
| **Inference**                | Stable (provider-dependent) | Vendor-agnostic adapter, 3-provider cascade (qwen3.5-plus, kimi-k2.5, glm-5), circuit breakers                                                                         |
| **Messaging**                | Stable                      | Telegram bidirectional, WhatsApp (CRM), prompt enhancer, scope-based tool filtering, streaming                                                                         |
| **Knowledge Base**           | Stable                      | 142 files in jarvis_files, FTS5 search, NorthStar sync to Supabase, auto-persist, compaction                                                                           |
| **Memory**                   | Stable                      | User facts, conversation history, execution patterns, Hindsight/SQLite fallback                                                                                        |
| **Intelligence**             | Stable                      | 8 signal collectors (USGS, NWS, GDELT, Frankfurter, CISA, CoinGecko, Treasury, Google News), delta engine, alert router                                                |
| **Google Workspace**         | Stable                      | Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks — 19 tools                                                                                                         |
| **Browser**                  | Stable                      | Lightpanda (fast/static) + Playwright (SPAs), always-on                                                                                                                |
| **Video**                    | Stable                      | 6 tools, FFmpeg pipeline, Pexels images, edge-tts/Gemini TTS                                                                                                           |
| **WordPress**                | Stable                      | 10 tools, multi-site, content protection, media upload                                                                                                                 |
| **Coding**                   | Stable                      | jarvis_dev (branch/test/pr), git tools, code_search (4498 symbols), file_edit                                                                                          |
| **Self-Improvement (v6.0)**  | Ready                       | S1-S8: branch+PR, self-repair, directives, VPS mgmt, autonomous loop, structured results, code search, execution patterns                                              |
| **Background Agents (v6.1)** | Live                        | "lanza un agente" parallel tasks, max 3, 60-min timeout, completion notifications                                                                                      |
| **Safeguards (SG1-SG5)**     | Live                        | Diff digest, kill switch, immutable core (15 files), directive cooldown (48h), pre-cycle git tags                                                                      |
| **Rituals**                  | Live                        | 8 scheduled (morning briefing, nightly close, signal intel, evolution, weekly review, overnight tuning, KB backup, diff digest) + autonomous improvement (Tue/Thu/Sat) |

## Autonomous Improvement Safeguards

| ID  | Safeguard          | Enforcement                                                                                   |
| --- | ------------------ | --------------------------------------------------------------------------------------------- |
| SG1 | Weekly Diff Digest | Sunday 8 PM Telegram: aggregates all Jarvis-authored changes from past 7 days                 |
| SG2 | HTTP Kill Switch   | POST /api/admin/kill-autonomous — disables loop at runtime + cancels running tasks            |
| SG3 | Immutable Core     | 15 files + src/api/ blocked in file_write, file_edit, shell_exec — even on jarvis/\* branches |
| SG4 | Directive Cooldown | Max 1 proposal per 48h via safeguard_state DB table                                           |
| SG5 | Pre-Cycle Git Tag  | pre-auto-YYYY-MM-DD before each improvement cycle. Prune >30 days, keep min 10                |

## Safety Invariants

1. Jarvis CANNOT push to `main` — branches + PRs only
2. Jarvis CANNOT modify directives without user approval via Telegram
3. Jarvis CANNOT remove safety guards — immutable core (SG3) protects all guard files
4. Jarvis CANNOT restart without passing tests
5. Jarvis CANNOT modify his own core (router, runners, dispatcher, DB, API, scheduler, guards)
6. Jarvis CANNOT propose directives more than once per 48h (SG4)
7. Jarvis CANNOT bypass safeguard state via raw SQL — sqlite3 blocked in shell_exec
8. All actions audited — execution patterns, decision logs, tool telemetry

## What's Activated But Not Yet Tested

| Item                        | Status                                       | Blocker                                              |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| Autonomous improvement loop | Enabled, first cycle Tuesday 1:30 AM         | Needs monitoring                                     |
| CRM-to-Jarvis integration   | Code fixed (5 layers), timeout bumped to 90s | DashScope primary provider intermittently timing out |

## What's Remaining

### Near-term

1. **Provider stability** — DashScope (qwen3.5-plus) is the weakest link. Options: swap to kimi primary, add a 4th provider, or wait for stabilization
2. **Monitor first autonomous cycle** — Tuesday 1:30 AM. Verify: detection, NanoClaw container, branch, fix, tests, PR
3. **CRM-to-Jarvis live validation** — works when providers are healthy
4. **Deploy pipeline** — currently manual. The autonomous loop creates PRs but cannot deploy them

### Medium-term

5. **Unified filesystem** — one file system for user + Jarvis. Design agreed, not started
6. **Multi-model routing** — reduce single-vendor risk. Route by task type
7. **Reddit scraper cleanup** — partially done

### Natural next steps

8. **Autonomous deploy** — Jarvis merges PRs after tests pass + human approval window expires
9. **Cross-session learning** — richer execution patterns, recurring failure class detection
10. **Cost optimization** — per-improvement cost tracking
11. **Multi-user** — PostgreSQL, Redis, per-user isolation. Only if needed

## The Big Picture

Jarvis went from a chat assistant to a self-improving agent in ~10 days of development (v4.0 - v6.1). The core loop works: he talks, remembers, researches, writes code, manages files, sends emails, creates videos. The v6.0 self-improvement machinery lets Jarvis fix his own scope patterns, tool descriptions, and intelligence adapters without human intervention.

The safeguards ensure he cannot modify his own nervous system, cannot merge his own PRs, cannot rewrite directives faster than once per 48h, and can be killed from a phone in one HTTP call.

The remaining risk is provider reliability, not architecture. When DashScope is healthy, everything works. When it is not, the fallback cascade handles it — but adds latency that breaks the CRM integration path.
