# v4.0 Roadmap — Agent Controller

> Based on [CRITICAL-ASSESSMENT.md](./CRITICAL-ASSESSMENT.md) (v2.28 audit) + user vision for swarm orchestration, structured output, observability, long-term memory, and multi-user scaling.
>
> Last updated: 2026-03-29

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

| CRIT # | Item                                                                     | Effort | Status  |
| ------ | ------------------------------------------------------------------------ | ------ | ------- |
| NEW    | Zod schema validation on tool call arguments before execution            | 0.5d   | Planned |
| NEW    | Retry with error on validation failure (1 retry, then fail with details) | 0.5d   | Planned |
| NEW    | Response validation for external API calls (HF, Google, WordPress)       | Incl.  | Planned |

---

## v4.0 S3 — Long-Term Memory (~1.5d)

| CRIT # | Item                                                    | Effort | Status  |
| ------ | ------------------------------------------------------- | ------ | ------- |
| 3.1    | SQLite FTS5 for conversation recall                     | 0.5d   | Planned |
| NEW    | Local embedding storage + cosine similarity search      | 0.5d   | Planned |
| NEW    | Hybrid recall: FTS5 keyword + embedding semantic        | 0.5d   | Planned |
| 3.2    | Hindsight circuit breaker improvements (or replacement) | Incl.  | Planned |
| 1.3    | Thread map TTL eviction                                 | 1h     | Planned |

---

## v4.0 S4 — Observability Dashboard (~1.5d)

| CRIT # | Item                                                       | Effort | Status  |
| ------ | ---------------------------------------------------------- | ------ | ------- |
| 9.5    | Prometheus `/metrics` endpoint (prom-client)               | 0.5d   | Planned |
| NEW    | Grafana dashboards (latency, tasks, tools, budget, errors) | 0.5d   | Planned |
| NEW    | Per-task token tracking (total tokens across all rounds)   | 0.5d   | Planned |
| 2.3    | Configurable degradation thresholds via env vars           | 2h     | Planned |

---

## v4.0 S5 — Inference Refactor (~2d)

| CRIT # | Item                                                      | Effort | Status  |
| ------ | --------------------------------------------------------- | ------ | ------- |
| 2.1    | Extract `inferWithTools` into composable units            | 1-1.5d | Planned |
| 2.2    | Paired message pruning (tool_call + tool_result as unit)  | 0.5d   | Planned |
| 4.3    | Honest failure messages (replace mechanical substitution) | 2h     | Planned |
| 2.5    | Consolidate hardcoded constants into config/constants.ts  | 0.5d   | Planned |
| 10.2   | Per-experiment timeout in overnight tuning                | 1h     | Planned |
| 10.1   | Transaction-safe overnight tuning                         | 2h     | Planned |

---

## v4.0 S6 — Test Infrastructure (~2d)

| CRIT # | Item                                        | Effort | Status  |
| ------ | ------------------------------------------- | ------ | ------- |
| 6.1    | Integration test suite with mock LLM server | 1.5d   | Planned |
| 6.2    | Hallucination detection end-to-end tests    | 0.5d   | Planned |
| 10.3   | Expand tuning seed data (49 → 200+)         | Incl.  | Planned |

---

## v4.0 S7 — Hallucination Prevention (~1.5d)

| CRIT # | Item                                                   | Effort | Status  |
| ------ | ------------------------------------------------------ | ------ | ------- |
| 4.1    | Prompt decomposition into composable modules           | 1d     | Planned |
| 4.2    | Execution-verification-first defense (invert approach) | 0.5d   | Planned |
| 3.3    | Relevance-scored user facts (inject top-N, not all)    | Incl.  | Planned |

---

## v4.0 S8 — Scope & Classification (~1d)

| CRIT # | Item                                                | Effort | Status  |
| ------ | --------------------------------------------------- | ------ | ------- |
| 5.1    | Scope stickiness in multi-turn conversations        | 2h     | Planned |
| 5.2    | Scope feedback loop (log misses → feed into tuning) | 0.5d   | Planned |
| 8.1    | Classifier weight calibration from task_outcomes    | 0.5d   | Planned |
| 8.2    | Lower adaptive adjustment thresholds                | 1h     | Planned |
| 7.3    | Credential detection source check (user msgs only)  | 1h     | Planned |

---

## v4.0 S9 — Task-Type Routing (~1.5d)

| CRIT # | Item                                                              | Effort | Status  |
| ------ | ----------------------------------------------------------------- | ------ | ------- |
| NEW    | Per-task-type system prompts (creative/coding/research/logistics) | 1d     | Planned |
| NEW    | Classifier routes to persona, not just runner                     | 0.5d   | Planned |
| 1.4    | Task queue with backpressure                                      | Incl.  | Planned |

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

## Metrics at v4.0 start

| Metric               | Value                                           |
| -------------------- | ----------------------------------------------- |
| Tools                | 111                                             |
| Test files           | 62                                              |
| Tests                | 666                                             |
| Hallucination layers | 7                                               |
| Inference providers  | 3 (qwen3.5-plus / qwen3-coder-plus / kimi-k2.5) |
| Rituals              | 8                                               |
| Source files         | ~160                                            |
| DB size              | ~30MB                                           |
