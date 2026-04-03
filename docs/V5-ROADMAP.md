# v5.0 Roadmap — Agent Controller

> Based on [V5-NORTHSTAR.md](./V5-NORTHSTAR.md) (full design doc with code examples, open questions, and external pattern sources) + v4.0.18 QA audit findings + 4 external repo evaluations.
>
> Last updated: 2026-04-03 — S1a, S1b, S2, S4, S5b, S5c complete. Scope fixes shipped. Jarvis file system + CRM bidirectional + context pressure + knowledge maps + research verification done.

## Status Key

- **Done** — Implemented, tested, shipped
- **Active** — Currently in progress
- **Planned** — Scoped and sequenced
- **Deferred** — Moved to v6.0+

---

## Execution Tiers

| Tier             | Sessions       | Priority             | Rationale                                       |
| ---------------- | -------------- | -------------------- | ----------------------------------------------- |
| 1 — Bedrock      | S1a, S1b, S2   | Ship first           | Guards + memory + concurrency isolation         |
| 2 — Capabilities | S4, S5b, S5c   | User-visible value   | A2A mesh, knowledge maps, research verification |
| 3 — Intelligence | S5, S5d, S6–S8 | Build on stable base | Classifier tuning, video, Intelligence Depot    |

**Changes from original plan:**

- S3 (embedding-based scoping) **deferred to v6.0** — regex accuracy at 92%+ after targeted fixes, embedding complexity not justified yet
- S2 **pivoted** from worker_threads to per-task execution context — system already async, real problem was shared mutable state
- S4 promoted to Tier 2 (quick win, high user value)

---

## Pre-v5.0 (resolved during v4.0.18–v4.0.19)

| Item                                                      | Resolution                                             |
| --------------------------------------------------------- | ------------------------------------------------------ |
| WRITE_TOOLS phantom names (11 wrong Google tool names)    | v4.0.18 — replaced with 9 correct names                |
| fullCount diagnostic missing SPECIALTY + RESEARCH         | v4.0.18 — added to sum                                 |
| Meta scope missing commit_journal                         | v4.0.18 — added                                        |
| case-miner missing research group                         | v4.0.18 — added RESEARCH_TOOLS                         |
| detectActiveGroups diverges from scopeToolsForMessage     | Documented — revisit if scope accuracy drops below 90% |
| No compile-time WRITE_TOOLS sync test                     | v5.0 S1a — sync test added                             |
| web_read 10K truncation causes hallucination on long docs | v4.0.19 — file eviction with TOC + file_read path      |
| Tool result double-eviction (adapter + web_read)          | v4.0.19 — hasEvictedPath() skip                        |

---

## v5.0 S1a — Guard Upgrades (Theme 0) (~2d)

> Guard stack was the primary failure mode in v4 — 5 sessions of hallucination fixes, guard stack inversion incident, 3-strike rule.

| Item                                                                                                                                                                                                   | Source               | Effort | Status   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------ | -------- |
| S1.1 Multi-layer doom-loop detection — canonical JSON fingerprinting, outcome-aware tracking, ping-pong cycle detector (period 2-3), content-chanting (sliding window hash), n-gram Jaccard similarity | hive + PraisonAI     | 0.5d   | **Done** |
| S1.4 Graduated escalation ladder — 4-level (RETRY_DIFFERENT → ESCALATE_MODEL → FORCE_WRAPUP → ABORT), phantom action detection (ES+EN)                                                                 | PraisonAI + OpenFang | 0.5d   | **Done** |
| S1.5 Circuit breaker registry — CLOSED/OPEN/HALF_OPEN per service, 5 failures/60s trips, 30s cooldown, /health integration                                                                             | PraisonAI            | 0.5d   | **Done** |
| S1.6 Session repair before inference — remove orphaned ToolResults, synthetic errors for unmatched ToolUse, dedup, merge same-role                                                                     | OpenFang             | 0.5d   | **Done** |
| WRITE_TOOLS compile-time sync test                                                                                                                                                                     | QA audit             | 1h     | **Done** |
| QA audit fixes: consecutiveReadOnlyRounds reset, Map growth caps, timer cleanup                                                                                                                        | QA                   | Incl.  | **Done** |
| Hotfix: preserve user messages from poisoned exchanges for scope inheritance                                                                                                                           | prod diagnosis       | Incl.  | **Done** |

---

## v5.0 S1b — Memory Upgrades (Theme 3) (~1.5d)

| Item                                                                                                                | Source          | Effort | Status   |
| ------------------------------------------------------------------------------------------------------------------- | --------------- | ------ | -------- |
| S1.2 Multi-level compaction pipeline — L0 prune → L1 pair drain → L2 LLM summary → L3 emergency truncation          | hive + OpenFang | 0.5d   | **Done** |
| S1.3 Mechanical auto-persist — response >2K + tools >3, Playwright always, question + >1K                           | hive            | 0.5d   | **Done** |
| S1.7 Three-window spending quotas — hourly/daily/monthly, fixed-boundary SQL, wouldExceedBudget, /health + /metrics | OpenFang        | 0.5d   | **Done** |
| QA audit fixes: compaction boundary guards, dispatcher window reporting, auto-persist error logging                 | QA              | Incl.  | **Done** |

---

## v5.0 S2 — Concurrent Task Isolation (Theme 1) (~1d)

> **Pivot from worker_threads:** System is already async-concurrent (fetch yields event loop). Real problem was shared mutable state corrupting across concurrent tasks. Worker threads deferred to v6.0.

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

## Scope Fixes (post-S2, pre-S4)

> Telemetry analysis showed 87% scope accuracy. After targeted fixes: ~92%+. Embeddings (S3) deferred — regex maintenance cost doesn't justify embedding complexity at current scale.

| Item                                                                                       | Source             | Effort | Status   |
| ------------------------------------------------------------------------------------------ | ------------------ | ------ | -------- |
| Follow-up inheritance threshold 50→80 chars                                                | telemetry analysis | 0.5h   | **Done** |
| Tightened referential phrases — require verb context to avoid false-positive on new topics | QA audit           | 0.5h   | **Done** |
| PDF direct trigger for research scope ("lee este PDF", ".pdf")                             | telemetry analysis | 0.5h   | **Done** |
| 7 new scope tests (boundary, referential, PDF, false-positive guard)                       | —                  | Incl.  | **Done** |

---

## v5.0 S4 — CRM Integration (~2h)

> **Pivot from A2A protocol:** The CRM already has REST endpoints on port 3000 with JWT auth. A direct HTTP tool is simpler and sufficient — no A2A protocol overhead needed. Full bidirectional A2A deferred until CRM needs to initiate tasks on Jarvis.

| Item                                                                                   | Source   | Effort | Status   |
| -------------------------------------------------------------------------------------- | -------- | ------ | -------- |
| `crm_query` builtin tool (#139) — queries 7 CRM REST endpoints with VP-level JWT       | v4 carry | 1h     | **Done** |
| "crm" scope group — pipeline/cuota/ventas/prospectos/facturación keywords              | —        | 0.5h   | **Done** |
| `hasCrm` scope gate — conditional on CRM_API_TOKEN env var (matches Google/WP pattern) | QA audit | Incl.  | **Done** |
| QA audit fixes: fresh token per call (not module-level), non-JSON response guard       | QA       | Incl.  | **Done** |

**Exit criteria:** User asks Jarvis "cómo va el pipeline?" → crm_query(vp-glance) → real-time CRM data in Telegram response.

---

## Post-S4: CRM Bidirectional + Jarvis File System + Context Pressure

| Item                                                                                         | Source       | Effort | Status   |
| -------------------------------------------------------------------------------------------- | ------------ | ------ | -------- |
| POST /api/jarvis-pull — CRM agents request Jarvis analysis, role-based depth control         | prod design  | 2h     | **Done** |
| CRM persona templates — mandatory Jarvis flow (doc link first, commentary separate)          | UX review    | 1h     | **Done** |
| Jarvis File System — Layer 0 infrastructure (src/db/jarvis-fs.ts), 6 tools, auto-injection   | architecture | 1d     | **Done** |
| Context pressure awareness — advisory at 70%, compaction metadata in return type, SOP seeded | Claude Code  | 2h     | **Done** |
| `always-read` budget exemption — enforce + always-read files bypass KB char budget           | QA audit     | Incl.  | **Done** |
| QA: division-by-zero guard, estimateTokens extraction + 5 tests, mock updates                | QA           | Incl.  | **Done** |

---

## v5.0 S5 — Classifier Calibration (~1d)

| Item                                                                | Source   | Effort | Status  |
| ------------------------------------------------------------------- | -------- | ------ | ------- |
| Outcome-driven weight tuning from task_outcomes table               | CRIT 8.1 | 0.5d   | Planned |
| Lower adaptive adjustment thresholds                                | CRIT 8.2 | 2h     | Planned |
| Negative feedback loop (rephrase detection → classifier correction) | —        | 0.5d   | Planned |

**Exit criteria:** Classifier weights updated based on production outcomes. Mis-routing rate measurably reduced.

---

## v5.0 S5b — Knowledge Maps (Theme 7) (~1-2d)

> Source: [HyperGraph](https://github.com/hyperbrowserai/hyperbrowser-app-examples/tree/main/hypergraph) — breadth-first-then-expand pattern.

| Item                                                                                                                          | Source     | Effort | Status   |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------- |
| `knowledge_map` + `knowledge_map_expand` tools — LLM-generated domain overviews (8-12 nodes), expand-on-demand (3-6 children) | HyperGraph | 1d     | **Done** |
| SQLite `knowledge_maps` + `knowledge_nodes` tables, 7-day TTL, max 60 nodes, max depth 5, reusable across tasks               | —          | Incl.  | **Done** |
| Prometheus integration: planner injects map context, reflector scores against concepts/gotchas                                | —          | 0.5d   | **Done** |
| `file_delete` tool (#148) — path-restricted recursive delete with depth guard, requiresConfirmation                           | prod fix   | 0.5h   | **Done** |
| QA: deleteMap before regeneration, MAX-based nextNodeSeq, isStale→updated_at, prefix root guard                               | QA         | Incl.  | **Done** |

**Exit criteria:** knowledge_map generates domain overview. Nodes persist in SQLite. Prometheus planner uses existing maps.

---

## v5.0 S5c — Research Verification (Theme 8) (~1d)

> Source: [Feynman](https://github.com/getcompanion-ai/feynman) — 3-layer verification pipeline.

| Item                                                                                               | Source  | Effort | Status   |
| -------------------------------------------------------------------------------------------------- | ------- | ------ | -------- |
| Provenance records — `task_provenance` SQLite table (sources consulted/accepted/rejected per task) | Feynman | 0.5d   | **Done** |
| Mechanical source anchoring — URL-in-content check during reflect phase, conservative penalty      | Feynman | 0.5d   | **Done** |
| Source status tagging — verified / inferred / unverified 3-state classification                    | Feynman | Incl.  | **Done** |
| Search result condensation — LLM pass on multi-query results (≥3 queries, max 15 sources)          | Feynman | 2h     | **Done** |

**Exit criteria:** Provenance records written for Prometheus tasks. Source anchoring flags uncited URLs.

---

## v5.0 S5d — Video Production (Theme 9) (~3-5d)

> Source: [OpenMontage](https://github.com/calesthio/OpenMontage) — clean-room TS reimplementation (no AGPLv3).

| Item                                                                                                                                                                             | Source      | Effort | Status  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | ------- |
| VideoToolSource (~10 tools): video_create, video_status, video_script, video_tts, video_image, video_compose, video_stitch, video_audio_mix, video_subtitle, video_list_profiles | OpenMontage | 2d     | Planned |
| Remotion composer (React/TS) — image sequence + audio + subtitles + transitions                                                                                                  | OpenMontage | 1d     | Planned |
| Provider cascade: Tier 0 (Pexels+Piper, free) → Tier 1 (FLUX) → Tier 2 (ElevenLabs) → Tier 3 (AI video)                                                                          | OpenMontage | Incl.  | Planned |
| SQLite `video_jobs` table, CONFIRMATION_REQUIRED, 24h auto-cleanup                                                                                                               | —           | 0.5d   | Planned |
| `video` scope group with keyword gating                                                                                                                                          | —           | 1h     | Planned |

**Exit criteria:** "Hazme un video de 60s explicando X" → MP4 delivered via Telegram.

---

## v5.0 S6–S8 — Intelligence Depot (~7d total)

> See [V5-INTELLIGENCE-DEPOT.md](./V5-INTELLIGENCE-DEPOT.md) for full design.

| Session       | What                                                                          | Effort | Status  |
| ------------- | ----------------------------------------------------------------------------- | ------ | ------- |
| S6 Foundation | 30-source collector adapters + signal store + delta engine                    | 3d     | Planned |
| S7 Streaming  | WebSocket hub (Finnhub, Bluesky, HN) + alert router (FLASH/PRIORITY/ROUTINE)  | 2d     | Planned |
| S8 Prediction | Statistical baselines + anomaly detection + Jarvis tools + ritual integration | 2d     | Planned |

---

## Deferred to v6.0+

| Item                           | Reason                                                                                                                                                                                          | Revisit when                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S3 Embedding-based scoping     | Regex accuracy 92%+ after targeted fixes. Embedding adds latency, complexity, model dependency. ROI not justified at current scale (353 scope decisions, ~20 long-tail misses fixable by regex) | Scope accuracy drops below 85% or new languages added |
| Worker threads (original S2)   | System is I/O-bound, not CPU-bound. fetch() already async. Adding threads for non-blocking ops is zero benefit                                                                                  | CPU profiling shows bottlenecks                       |
| Multi-user (PostgreSQL, Redis) | Single user. Premature to build                                                                                                                                                                 | Second user exists                                    |
| detectActiveGroups unification | Both functions work, divergence is cosmetic. Embeddings would have replaced both                                                                                                                | S3 ships                                              |

---

## Metrics

| Metric              | v4.0 Final                | v5.0 Current                             | v5.0 Target                  |
| ------------------- | ------------------------- | ---------------------------------------- | ---------------------------- |
| Tests               | 903                       | 1092                                     | ~1,200+                      |
| Test files          | 74                        | 88                                       | ~90+                         |
| Tools               | 137                       | 134                                      | ~145 (+video, intel)         |
| Doom-loop detection | String-match              | 4-layer (JSON, cycles, chant, n-gram)    | Done                         |
| Escalation          | Binary (nudge→wrap)       | 4-level ladder                           | Done                         |
| Circuit breakers    | None                      | Per-service CLOSED/OPEN/HALF_OPEN        | Done                         |
| Compaction          | Single-level PRESERVE+ADD | 4-level (prune→pair→LLM→deterministic)   | Done                         |
| Spending controls   | Per-round only            | Three-window (hourly/daily/monthly)      | Done                         |
| Scope method        | Keyword regex             | Keyword regex (92%+ accuracy, tightened) | Embeddings deferred to v6    |
| Concurrent tasks    | Unsafe (shared state)     | Safe (per-task context)                  | Done                         |
| Task introspection  | None                      | task_history tool                        | Done                         |
| CRM integration     | None                      | REST + jarvis-pull (bidirectional)       | Done                         |
| Knowledge maps      | None                      | 2 tools, 2 tables, Prometheus integrated | Done                         |
| Research provenance | None                      | 3-state classification, anchoring score  | Done                         |
| Video production    | None                      | —                                        | On-demand via Telegram (S5d) |
| Signal sources      | 0 (manual)                | —                                        | 25+ automated (S6–S8)        |
| Context awareness   | None                      | Advisory at 70%, metadata in output      | Done                         |
| QA audits           | 6 (v4)                    | 11 (v5)                                  | Continuing                   |
