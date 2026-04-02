# v5.0 Roadmap — Agent Controller

> Based on [V5-NORTHSTAR.md](./V5-NORTHSTAR.md) (full design doc with code examples, open questions, and external pattern sources) + v4.0.18 QA audit findings + 4 external repo evaluations.
>
> Last updated: 2026-04-01 — Ready for execution

## Status Key

- **Done** — Implemented, tested, shipped
- **Active** — Currently in progress
- **Planned** — Scoped and sequenced
- **Future** — Deferred to v6.0+

---

## Execution Tiers

| Tier             | Sessions         | Priority                   | Rationale                                                 |
| ---------------- | ---------------- | -------------------------- | --------------------------------------------------------- |
| 1 — Bedrock      | S1a, S1b, S2, S4 | Ship first                 | Every other session depends on solid guards + concurrency |
| 2 — Intelligence | S3, S5, S5c      | Build on stable foundation | Smarter routing, self-improvement, research quality       |
| 3 — Capabilities | S5b, S5d, S6–S8  | New features on solid base | Knowledge maps, video production, Intelligence Depot      |

---

## Pre-v5.0 (resolved during v4.0.18–v4.0.19)

| Item                                                      | Resolution                                        |
| --------------------------------------------------------- | ------------------------------------------------- |
| WRITE_TOOLS phantom names (11 wrong Google tool names)    | v4.0.18 — replaced with 9 correct names           |
| fullCount diagnostic missing SPECIALTY + RESEARCH         | v4.0.18 — added to sum                            |
| Meta scope missing commit_journal                         | v4.0.18 — added                                   |
| case-miner missing research group                         | v4.0.18 — added RESEARCH_TOOLS                    |
| detectActiveGroups diverges from scopeToolsForMessage     | Documented — S3 (embeddings) replaces both        |
| No compile-time WRITE_TOOLS sync test                     | Documented — S1a exit criteria                    |
| web_read 10K truncation causes hallucination on long docs | v4.0.19 — file eviction with TOC + file_read path |
| Tool result double-eviction (adapter + web_read)          | v4.0.19 — hasEvictedPath() skip                   |

---

## v5.0 S1a — Guard Upgrades (Theme 0) (~2d)

> **Priority: CRITICAL.** Guard stack was the primary failure mode in v4 — 5 sessions of hallucination fixes, guard stack inversion incident, 3-strike rule. Every other v5 session runs on top of these guards.

| Item                                                                                                                                                                                                   | Source               | Effort | Status   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------ | -------- |
| S1.1 Multi-layer doom-loop detection — canonical JSON fingerprinting, outcome-aware tracking, ping-pong cycle detector (period 2-3), content-chanting (sliding window hash), n-gram Jaccard similarity | hive + PraisonAI     | 0.5d   | **Done** |
| S1.4 Graduated escalation ladder — 4-level enum (RETRY_DIFFERENT → ESCALATE_MODEL → FORCE_WRAPUP + quality gate → ABORT), phantom action detection (action verb + channel, no tool call)               | PraisonAI + OpenFang | 0.5d   | **Done** |
| S1.5 Circuit breaker registry — CLOSED/OPEN/HALF_OPEN per service, 5 failures/60s trips, 30s cooldown, /health integration                                                                             | PraisonAI            | 0.5d   | **Done** |
| S1.6 Session repair before inference — remove orphaned ToolResults, synthetic errors for unmatched ToolUse, dedup, merge same-role                                                                     | OpenFang             | 0.5d   | **Done** |
| WRITE_TOOLS compile-time sync test (from v4.0.18 QA audit)                                                                                                                                             | QA audit             | 1h     | **Done** |

**Exit criteria:** Existing guard tests pass + new tests for: reordered JSON keys, ping-pong A-B-A-B, content chanting, n-gram edge cases, escalation state machine, quality gate, phantom detection, circuit breaker lifecycle, session repair (4 edge cases), WRITE_TOOLS sync.

---

## v5.0 S1b — Memory Upgrades (Theme 3) (~1.5d)

| Item                                                                                                                                                                                    | Source          | Effort | Status   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------ | -------- |
| S1.2 Multi-level compaction pipeline — L0 prune old results, L1 paired pruning (pair-aware drain), L2 LLM summary (delegates to existing compress), L3 emergency deterministic (no LLM) | hive + OpenFang | 0.5d   | **Done** |
| S1.3 Mechanical auto-persist — post-task: length >2K + tools >3, Playwright → always, explanatory Q + >1K. Compact summary with tags                                                    | hive            | 0.5d   | **Done** |
| S1.7 Three-window spending quotas — hourly/daily/monthly budgets, fixed-boundary SQL, pre-call gating (wouldExceedBudget), /health + /metrics integration                               | OpenFang        | 0.5d   | **Done** |

**Exit criteria:** Compaction tests at all 4 levels, counter increments verified. Auto-persist fires on qualifying responses, not on short acks. Spending quotas block when exhausted, reset at window boundaries.

---

## v5.0 S2 — Concurrent Task Isolation (Theme 1) (~1d)

> **Pivot from worker_threads:** Analysis showed the system is already async-concurrent (fetch yields event loop). The real problem was shared mutable state (destructive locks, memory rate limits) corrupting across concurrent tasks. Per-task execution context is simpler, uses zero extra RAM, and directly solves the actual bug. Worker threads deferred to v6.0 (only if CPU-bound bottlenecks measured).

| Item                                                                         | Source         | Effort | Status   |
| ---------------------------------------------------------------------------- | -------------- | ------ | -------- |
| TaskExecutionContext class — per-task destructive locks + memory rate limits | S2 analysis    | 0.5d   | **Done** |
| createTaskExecutor wrapper — delegates to registry with context-aware gates  | S2 analysis    | 0.25d  | **Done** |
| Wire into fast-runner + orchestrator — context flows through inference loop  | —              | 0.25d  | **Done** |
| inferWithTools returns exitReason + roundsCompleted (5 return paths)         | prod diagnosis | Incl.  | **Done** |
| Provider failure → completed_with_concerns (not completed)                   | prod diagnosis | Incl.  | **Done** |
| task_history builtin tool (#138) — LLM queries own past executions           | prod diagnosis | 0.25d  | **Done** |
| Concurrency metrics — mc_tasks_active, mc_tasks_active_by_runner gauges      | —              | 0.25d  | **Done** |

---

## v5.0 S3 — Embedding-Based Scoping (Theme 2) (~2-3d)

| Item                                                                              | Source           | Effort | Status  |
| --------------------------------------------------------------------------------- | ---------------- | ------ | ------- |
| Replace keyword regex with vector similarity for scope groups                     | CRIT 5.3         | 2d     | Planned |
| Unify detectActiveGroups and scopeToolsForMessage                                 | v4.0.18 QA audit | Incl.  | Planned |
| Hybrid: keep simple keyword triggers for core groups, embeddings for finer groups | —                | Incl.  | Planned |
| Scope embedding cache (same conversation shares scope)                            | —                | 0.5d   | Planned |

**Exit criteria:** Regex-based scope patterns removed. Embedding similarity activates correct groups on Spanish/English inputs. eval harness scope_accuracy >= v4 baseline. Latency < 300ms per scope decision.

---

## v5.0 S4 — A2A Mesh (Theme 5) (~3.5h)

| Item                                                                    | Source   | Effort | Status  |
| ----------------------------------------------------------------------- | -------- | ------ | ------- |
| CRM `/a2a` endpoint (reuses existing inference adapter + tool executor) | v4 carry | 1.5h   | Planned |
| Jarvis `crm_query` tool                                                 | —        | 1h     | Planned |
| Scope patterns for CRM keywords                                         | —        | 0.5h   | Planned |
| API key authentication                                                  | —        | 0.5h   | Planned |

**Exit criteria:** User asks Jarvis about CRM pipeline → A2A delegation → CRM agent runs → result flows back → Telegram response. Cost: ~$0.004/query.

---

## v5.0 S5 — Classifier Calibration (Theme 5) (~1d)

| Item                                                                | Source   | Effort | Status  |
| ------------------------------------------------------------------- | -------- | ------ | ------- |
| Outcome-driven weight tuning from task_outcomes table               | CRIT 8.1 | 0.5d   | Planned |
| Lower adaptive adjustment thresholds                                | CRIT 8.2 | 2h     | Planned |
| Negative feedback loop (rephrase detection → classifier correction) | —        | 0.5d   | Planned |

**Exit criteria:** Classifier weights updated based on production outcomes. Mis-routing rate measurably reduced.

---

## v5.0 S5b — Knowledge Maps (Theme 7) (~1-2d)

> Source: [HyperGraph](https://github.com/hyperbrowserai/hyperbrowser-app-examples/tree/main/hypergraph) — breadth-first-then-expand pattern.

| Item                                                                                                  | Source     | Effort | Status  |
| ----------------------------------------------------------------------------------------------------- | ---------- | ------ | ------- |
| `knowledge_map` tool — breadth-first domain overview (8-12 nodes), expand-on-demand                   | HyperGraph | 1d     | Planned |
| SQLite `knowledge_nodes` table, reusable across tasks                                                 | —          | Incl.  | Planned |
| Prometheus integration: planner checks for maps, reflector scores against map, executor expands nodes | —          | 0.5d   | Planned |

**Exit criteria:** knowledge_map generates domain overview. Nodes persist in SQLite. Prometheus planner uses existing maps. Node expansion works on demand. Max 60 nodes/topic, depth 5.

---

## v5.0 S5c — Research Verification (Theme 8) (~1d)

> Source: [Feynman](https://github.com/getcompanion-ai/feynman) — 3-layer verification pipeline adapted to code-level enforcement.

| Item                                                                                               | Source  | Effort | Status  |
| -------------------------------------------------------------------------------------------------- | ------- | ------ | ------- |
| Provenance records — `task_provenance` SQLite table (sources consulted/accepted/rejected per task) | Feynman | 0.5d   | Planned |
| Mechanical source anchoring — URL-in-content check during reflect phase                            | Feynman | 0.5d   | Planned |
| Source status tagging — verified / inferred / unverified classification                            | Feynman | Incl.  | Planned |
| Search result condensation — LLM pass on multi-query results (>2 queries)                          | Feynman | 2h     | Planned |

**Exit criteria:** Provenance records written for Prometheus tasks. Source anchoring flags uncited URLs. Condensation reduces token count on multi-query results.

---

## v5.0 S5d — Video Production (Theme 9) (~3-5d)

> Source: [OpenMontage](https://github.com/calesthio/OpenMontage) — architecture and patterns. Clean-room TypeScript reimplementation (no AGPLv3 dependency).

| Item                                                                                                                                                                             | Source      | Effort | Status  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | ------- |
| VideoToolSource (~10 tools): video_create, video_status, video_script, video_tts, video_image, video_compose, video_stitch, video_audio_mix, video_subtitle, video_list_profiles | OpenMontage | 2d     | Planned |
| Remotion composer (React/TS) — image sequence + audio + subtitles + transitions                                                                                                  | OpenMontage | 1d     | Planned |
| Provider cascade: Tier 0 (Pexels+Piper, free) → Tier 1 (FLUX, ~$0.30) → Tier 2 (ElevenLabs, ~$1-3) → Tier 3 (AI video, ~$3-10)                                                   | OpenMontage | Incl.  | Planned |
| SQLite `video_jobs` table, CONFIRMATION_REQUIRED, 24h auto-cleanup                                                                                                               | —           | 0.5d   | Planned |
| `video` scope group with keyword gating                                                                                                                                          | —           | 1h     | Planned |

**Exit criteria:** "Hazme un video de 60s explicando X" → MP4 delivered via Telegram. Provider cascade selects based on available API keys. Budget governance blocks over-limit. Render completes in <20 min.

---

## v5.0 S6 — Intelligence Depot: Foundation (~3d)

> See [V5-INTELLIGENCE-DEPOT.md](./V5-INTELLIGENCE-DEPOT.md) for full design.

| Item                                                                   | Source | Effort | Status  |
| ---------------------------------------------------------------------- | ------ | ------ | ------- |
| 30-source collector adapters (12 no-auth, 9 free-key, 9 authenticated) | Crucix | 2d     | Planned |
| Signal store (SQLite `signals` table)                                  | —      | 0.5d   | Planned |
| Delta engine — change_ratio / threshold → severity classification      | Crucix | 0.5d   | Planned |

**Exit criteria:** 5+ sources polling, deltas computed, `mc-ctl intel` commands work.

---

## v5.0 S7 — Intelligence Depot: Streaming (~2d)

| Item                                                               | Source | Effort | Status  |
| ------------------------------------------------------------------ | ------ | ------ | ------- |
| WebSocket hub (Finnhub, Bluesky JetStream, HN Firebase)            | Crucix | 1d     | Planned |
| Alert router — FLASH / PRIORITY / ROUTINE tiers → Telegram / email | Crucix | 1d     | Planned |
| Remaining collector adapters                                       | —      | Incl.  | Planned |

**Exit criteria:** 3 WebSocket streams connected. Alert routing delivers to Telegram. FLASH alerts arrive <5 min from signal.

---

## v5.0 S8 — Intelligence Depot: Prediction (~2d)

| Item                                                                 | Source | Effort | Status  |
| -------------------------------------------------------------------- | ------ | ------ | ------- |
| Statistical baselines — z-score at 5 windows (1h, 6h, 24h, 7d, 30d)  | Crucix | 1d     | Planned |
| Anomaly detection — auto-escalation on z>3                           | —      | 0.5d   | Planned |
| Jarvis tools + ritual integration — intel_query, intel_alert_history | —      | 0.5d   | Planned |

**Exit criteria:** Baselines computed for active signals. Anomalies detected and routed. Jarvis can query intel via tools. Morning ritual includes intel summary.

---

## v5.0 S9+ — Multi-User (future)

| Item                                       | Effort | Status |
| ------------------------------------------ | ------ | ------ |
| PostgreSQL migration (replace SQLite)      | 3-5d   | Future |
| Redis for session state                    | 2d     | Future |
| Per-user isolation (user_id on all tables) | 2-3d   | Future |

**Dependencies:** Only worth building when there's a second user. Currently premature.

---

## Metrics

| Metric              | v4.0 Final                | v5.0 Target                            |
| ------------------- | ------------------------- | -------------------------------------- |
| Tests               | 903                       | ~1,100+                                |
| Test files          | 74                        | ~85+                                   |
| Tools               | 137                       | ~150 (+video, intel, CRM query)        |
| Doom-loop detection | String-match              | 4-layer (JSON, cycles, chant, n-gram)  |
| Escalation          | Binary (nudge→wrap)       | 4-level ladder                         |
| Circuit breakers    | None                      | Per-service CLOSED/OPEN/HALF_OPEN      |
| Compaction          | Single-level PRESERVE+ADD | 4-level (prune→pair→LLM→deterministic) |
| Spending controls   | Per-round only            | Three-window (hourly/daily/monthly)    |
| Scope method        | Keyword regex             | Embedding similarity                   |
| Concurrent tasks    | 1 (sequential)            | 3 (worker threads)                     |
| CRM integration     | None                      | A2A bidirectional                      |
| Knowledge maps      | None                      | SQLite, breadth-first + expand         |
| Research provenance | None                      | Per-task audit trail                   |
| Video production    | None                      | On-demand 15-120s via Telegram         |
| Signal sources      | 0 (manual)                | 25+ (automated + 3 WebSocket)          |
| Signal latency      | ~24h (daily ritual)       | <5 min (delta engine)                  |
| QA audits           | 6 (v4)                    | Continuing                             |
