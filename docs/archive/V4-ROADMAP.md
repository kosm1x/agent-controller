# v4.0 Roadmap — Agent Controller

> Based on [CRITICAL-ASSESSMENT.md](./CRITICAL-ASSESSMENT.md) (v2.28 audit) + user vision for swarm orchestration, structured output, observability, long-term memory, and multi-user scaling.
>
> Last updated: 2026-03-31 — v4.0 S1-S9 COMPLETE + audited

## Status Key

- **Done** — Implemented, tested, shipped
- **Active** — Currently in progress
- **Planned** — Scoped and sequenced
- **Future** — Deferred to v5.0+

---

## Pre-v4.0 (already resolved)

| CRIT # | Item                           | Resolution                                                            |
| ------ | ------------------------------ | --------------------------------------------------------------------- |
| 1.2    | Systemd crash recovery         | v3.2 — systemd unit, auto-restart, journald                           |
| 2.4    | SSE streaming responses        | v2.30 — Telegram streaming via editMessageText                        |
| 7.2    | Confirmation gates enforcement | v3.1 — 3-layer: registry gate + confirmation detection + prompt rules |
| 9.2    | Log rotation                   | v3.2 — journald via systemd                                           |

---

## v4.0 S1 — Operational Foundation (~3h)

| CRIT # | Item                                                    | Effort | Status                  |
| ------ | ------------------------------------------------------- | ------ | ----------------------- |
| 3.4    | Missing DB indexes (conversations, task_outcomes)       | 15min  | **Done**                |
| 7.1    | Shell command substitution bypass (`$(...)`, backticks) | 1h     | **Done**                |
| 9.3    | Budget persistence to SQLite (survives restart)         | —      | **Done** (pre-existing) |
| 9.4    | Database backup cron (7-day rotation)                   | 30min  | **Done**                |
| 9.1    | External healthcheck → Telegram alert on failure        | 1h     | **Done**                |

---

## v4.0 S2 — Structured Output + Zod Validation (~1d)

| CRIT # | Item                                                                     | Effort | Status                                   |
| ------ | ------------------------------------------------------------------------ | ------ | ---------------------------------------- |
| NEW    | Zod schema validation on tool call arguments before execution            | 0.5d   | **Done**                                 |
| NEW    | Retry with error on validation failure (1 retry, then fail with details) | 0.5d   | **Done**                                 |
| NEW    | Response validation for external API calls (HF, Google, WordPress)       | Incl.  | Deferred (tool-level, not adapter-level) |

---

## v4.0 S3 — Long-Term Memory (~1.5d)

| CRIT # | Item                                                    | Effort | Status                                                   |
| ------ | ------------------------------------------------------- | ------ | -------------------------------------------------------- |
| 3.1    | SQLite FTS5 for conversation recall                     | 0.5d   | **Done**                                                 |
| NEW    | Local embedding storage + cosine similarity search      | 0.5d   | **Done**                                                 |
| NEW    | Hybrid recall: FTS5 keyword + embedding semantic        | 0.5d   | **Done**                                                 |
| 3.2    | Hindsight circuit breaker improvements (or replacement) | Incl.  | Deferred (Hindsight stays as-is, SQLite recall upgraded) |
| 1.3    | Thread map TTL eviction                                 | 1h     | **Done**                                                 |

---

## v4.0 S4 — Observability Dashboard (~1.5d)

| CRIT # | Item                                                       | Effort | Status                                                 |
| ------ | ---------------------------------------------------------- | ------ | ------------------------------------------------------ |
| 9.5    | Prometheus `/metrics` endpoint (prom-client)               | 0.5d   | **Done**                                               |
| NEW    | Grafana dashboards (latency, tasks, tools, budget, errors) | 0.5d   | **Done** (v4.0.5 — :3001, 15 panels, auto-provisioned) |
| NEW    | Per-task token tracking (total tokens across all rounds)   | 0.5d   | **Done** (mc*tokens*\*\_total by model)                |
| 2.3    | Configurable degradation thresholds via env vars           | 2h     | Deferred (current hardcoded values work)               |

---

## v4.0 S5–S6 — Integration Tests + Constants (~2d)

| CRIT # | Item                                                     | Effort | Status   |
| ------ | -------------------------------------------------------- | ------ | -------- |
| 6.1    | Integration test suite with mock LLM server              | 1.5d   | **Done** |
| 2.5    | Consolidate hardcoded constants into config/constants.ts | 0.5d   | **Done** |
| 10.2   | Per-experiment timeout in overnight tuning               | 1h     | **Done** |
| 10.1   | Transaction-safe overnight tuning                        | 2h     | **Done** |

---

## v4.0 S7 — Test Coverage (~1d)

| Item                                                              | Status   |
| ----------------------------------------------------------------- | -------- |
| scope.test.ts — 15 tests for patterns + two-phase isolation       | **Done** |
| dispatcher.test.ts — 13 tests for task lifecycle                  | **Done** |
| adapter.test.ts — +7 tests for COMMIT READ_ONLY_TOOLS             | **Done** |
| guards.test.ts — 20 tests for extracted guard functions           | **Done** |
| prompt-sections.test.ts — 20 tests for detectToolFlags + sections | **Done** |
| feedback.test.ts — 6 tests for detectImplicitFeedback             | **Done** |
| QA audit: mock correctness, pattern coverage, conventions         | **Done** |

---

## v4.0 S8 — Decomposition (~1d)

| Item                                                               | Status   |
| ------------------------------------------------------------------ | -------- |
| guards.ts — 6 guard functions extracted from inferWithTools        | **Done** |
| prompt-sections.ts — 13 sections from buildJarvisSystemPrompt      | **Done** |
| InferOptions — infer() refactored from 4 positional to options obj | **Done** |
| QA audit: behavioral equivalence confirmed                         | **Done** |

---

## v4.0 S9 — Scope Telemetry + Outcome Attribution (~0.5d)

| Item                                                              | Status   |
| ----------------------------------------------------------------- | -------- |
| tool_chain column in scope_telemetry (deduplicated ordered tools) | **Done** |
| detectImplicitFeedback (topic change → positive, rephrase → neg)  | **Done** |
| mc-ctl tool-chains command (top chains by success rate)           | **Done** |
| QA audit: feedback window fix, query alignment, types             | **Done** |

---

## v5.0 — Multi-User Architecture (future)

| CRIT # | Item                                                 | Effort | Status |
| ------ | ---------------------------------------------------- | ------ | ------ |
| NEW    | PostgreSQL migration (replace SQLite)                | 3-5d   | Future |
| NEW    | Redis for shared state (threads, sessions)           | 2d     | Future |
| NEW    | Docker Compose with auto-scaling workers             | 2-3d   | Future |
| 1.1    | Worker threads for inference concurrency             | 2-3d   | Future |
| NEW    | Full swarm orchestration + agent market with bidding | 5-7d   | Future |
| 5.3    | Embedding-based tool scoping (replace keyword regex) | 2-3d   | Future |

---

## Metrics

| Metric               | v4.0 start   | Final (v4.0 S9)                                                       |
| -------------------- | ------------ | --------------------------------------------------------------------- |
| Tools                | 111          | 137 (+26: gmail_read, .docx, Playwright 21, Lightpanda scope-gated)   |
| Test files           | 62           | 73 (+11)                                                              |
| Tests                | 666          | 848 (+182)                                                            |
| Hallucination layers | 7            | 7 + success-aware + verification bypass + think-block + status-narr   |
| Inference providers  | 3            | 3 (qwen3.5-plus / qwen3-coder-plus / kimi-k2.5)                       |
| Rituals              | 8            | 8                                                                     |
| Source files         | ~160         | 174                                                                   |
| Dependencies         | 8+2          | 11+2 (added prom-client, mammoth, @playwright/mcp)                    |
| Memory               | LIKE search  | FTS5 + embeddings hybrid + tool_chain attribution + implicit feedback |
| Tool validation      | None         | Zod schema on all tools                                               |
| Observability        | /health only | /health + /metrics + Grafana (15 panels) + mc-ctl tool-chains         |
| Integration tests    | 0            | 8 (mock LLM server)                                                   |
| QA audits            | 0            | 6 (S7, S8, S9, v4.0.6, v4.0.7, amnesia fix — all passed)              |
| Production runtime   | tsx (cached) | node dist/index.js (compiled, scripts/deploy.sh)                      |
| Browsers             | Lightpanda   | Lightpanda (static) + Playwright/Chromium (SPAs)                      |
