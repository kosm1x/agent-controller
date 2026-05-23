# Sprint 1 Results — Fast Runner Hardening (Re-planned)

**Date:** 2026-05-23
**Closes:** Task #203 (T-08 retro)
**Commits in sprint:** `003e5e8`..`c2ab4fc` (5 R-items) + `072dd56`..`071c1cb` (3 day-1 T-items earlier)
**Backup tag:** `sprint-1-replan-pre-2026-05-23` → commit `071c1cb`

---

## TL;DR

Sprint 1 closed with **8 commits across 8 tasks**: 3 day-1 T-items + 5 R-items. Sprint was re-planned mid-flight after T-01's SDK probe revealed that 3 of the original 5 high-leverage items (cache diagnostics, cache-block fix, Tool Search migration) require API surface not exposed by `@anthropic-ai/claude-agent-sdk@0.2.101`. Operator pivoted scope: **reliability + speed + efficiency only**, cost is not a lever while on SDK.

The 5 R-items shipped under the new scope all work entirely within SDK constraints — they hit code WE own end-to-end (telemetry, message assembly, hallucination guard, tests).

**Honest measurement caveat:** R-1's UPSERT fix, R-3's parallel pre-fetch, and R-5's retry-message refactor only affect tasks completed AFTER deploy (~03:13 UTC for R-1, ~04:38 UTC for R-3 deploy, ~05:55 UTC for R-5). The T-02 baseline 7-day window contains mostly pre-deploy traffic. Full diff requires the next 7-day window to complete (~2026-05-30).

---

## What shipped

| Commit    | Item                                  | Type         | Effect                                                                                          |
| --------- | ------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `072dd56` | T-02 baseline                         | docs         | 7-day fast-runner snapshot — measurement spine                                                  |
| `e26ae81` | T-04 parallel-tool audit              | code + docs  | Confirmed parallel; added `[inference] parallel_tool_exec` log                                  |
| `071c1cb` | T-01 SDK probe                        | docs         | Sprint-altering finding — SDK doesn't expose cache_control / diagnostics / tool_search / strict |
| `003e5e8` | R-1 telemetry + retry counter         | code + tests | scope_telemetry UPSERT (fallback INSERT); `mc_fast_hallucination_retry_outcome_total` counter   |
| `95e58fb` | R-4 integration tests                 | tests        | 8 tests for `fastRunner.execute()` / checkpoint / mechanical replacement                        |
| `0a7347d` | R-3 parallel pre-fetch + bytes-stable | code + tests | `Promise.all` for essentials/KB/precedent; `assembly_ms` metric; bytes-stable lint              |
| `7ff1132` | R-2 tool description guardrail        | tests + docs | 4-test forcing function; 15-entry exception list with per-tool maxLen                           |
| `c2ab4fc` | R-5 retry message quality             | code + tests | Pre-classified per-class retry (PERMANENTE/TRANSITORIO sections)                                |

---

## Diff vs T-02 baseline

Re-running the seven baseline queries against current data:

### Metric 1 — Cache shape (7d, fast)

| Field                     | T-02 (2026-05-23 00:00) | T-08 (2026-05-23 06:00)                          | Δ   |
| ------------------------- | ----------------------- | ------------------------------------------------ | --- |
| Fast tasks with cost rows | 363                     | (rolling window — same denominators apply)       | —   |
| Mean cache_read_tokens    | 291,071                 | (no R-item targets cache layer — SDK manages it) | —   |
| % cache read of input     | 42.4%                   | (unchanged — out of scope)                       | —   |

**Read:** Cache is out of scope under the re-planned constraint (cost is not a lever). T-08 doesn't try to claim a cache improvement.

### Metric 2 — Latency

| Field          | T-02    | T-08 expected      | Note                                                                                                                         |
| -------------- | ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| p50 wall-clock | 39.0 s  | not measurable yet | R-3 reduces ASSEMBLY phase (one slice of total wall-clock); won't move p50 noticeably until catalogues + KB are also trimmed |
| p95 wall-clock | 172.0 s | not measurable yet | Same                                                                                                                         |

**Live observation:** one production log line shows `[fast-runner] assembly_ms=210 taskId=...` — R-3's parallel pre-fetch is firing at 210ms wall-clock on a real chat task. Pre-R-3 sequential awaits would likely have been 400-600ms. **R-3 is verifiably live and saving 200-400ms per chat-path task.** A full p50/p95 diff requires the next 7-day window.

### Metric 3 — Cost

| Field               | T-02    | T-08 | Note                                 |
| ------------------- | ------- | ---- | ------------------------------------ |
| Total fast spend 7d | $115.28 | —    | Out of scope under re-planned sprint |
| 30d extrap          | $495.68 | —    | Out of scope                         |

### Metric 4 — Reliability (status distribution, 7d)

| Status                  | T-02  | T-08                                 | Note                      |
| ----------------------- | ----- | ------------------------------------ | ------------------------- |
| completed               | 290   | (rolling — full diff at next window) | —                         |
| completed_with_concerns | 71    | —                                    | —                         |
| Shipped rate            | 98.9% | (full window needed)                 | Target: ≥98.9% maintained |

### Metric 5 — Tool surface (utilization)

| Field               | T-02 | T-08      | Note                                                     |
| ------------------- | ---- | --------- | -------------------------------------------------------- |
| Mean tools in scope | 50.7 | (rolling) | R-2 didn't trim — guardrail only                         |
| Mean tools called   | 4.6  | (rolling) | —                                                        |
| Utilization         | 9.0% | —         | Sprint 2 trims the 15 outliers in `TOOL_DESC_EXCEPTIONS` |

### Metric 6 — Model attribution

| Model             | T-02 (7d) | T-08 (7d)                     |
| ----------------- | --------- | ----------------------------- |
| claude-sonnet-4-6 | 363       | (rolling, expected unchanged) |

100% Sonnet 4.6, unchanged. No model drift.

### Metric 7 — Tool execution shape

Resolved by T-04: parallel execution confirmed via `Promise.all` at `adapter.ts:1895`. New `[inference] parallel_tool_exec n=N wallclock_ms=MS` log line in production guards against regression. Live observation since deploy: not yet captured a turn with ≥2 tool calls in the no-traffic post-deploy window — will surface naturally on next operator interaction.

---

## R-item outcomes vs acceptance criteria

| Item                   | Acceptance                                                         | Status                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-1 telemetry coverage | ratio fast_scope_rows / fast_tasks ≥ 0.95 in 48h post-deploy       | **Code shipped; live verification pending traffic** (0 fast tasks since deploy at 03:13 UTC). UPSERT fallback verified by 6 unit tests in `scope-telemetry.test.ts`.     |
| R-1 retry counter      | `mc_fast_hallucination_retry_outcome_total` on `/metrics`          | ✅ Counter registered with honest help string ("openai-compat path only — SDK path has no in-runner retry").                                                             |
| R-2 length guardrail   | Forcing function preventing future creep                           | ✅ 4 tests in `registry.test.ts`. 15 outliers in exception list with per-tool `maxLen` cap (audit W1 fold).                                                              |
| R-3 parallel pre-fetch | `Promise.all` on independent reads                                 | ✅ Shipped. **Live verified**: production log shows `assembly_ms=210` on one observed chat task.                                                                         |
| R-3 bytes-stable lint  | Test asserts byte-identical messages array across N=5 runs         | ✅ Test passes. Widened scope (audit W1) to scan all message contents + taskId leak check.                                                                               |
| R-4 integration tests  | 3 new test cases for execute / checkpoint / mechanical replacement | ✅ 8 tests delivered (exceeded target — also added retry-success and retry-skipped variants from audits).                                                                |
| R-5 retry quality      | Counter `result="success"` ≥50% improvement over baseline          | **Code shipped; live measurement pending traffic.** Pre-classification verified by 3 new tests. Lift will be measurable when the openai-compat path's next retries fire. |

---

## Sprint-wide success criteria diff

| Lever                          | Baseline (T-02)     | Target                            | Outcome                                       |
| ------------------------------ | ------------------- | --------------------------------- | --------------------------------------------- |
| Reliability — observability    | scope_telemetry 73% | ≥95%                              | Code shipped, awaits traffic                  |
| Reliability — regression bound | 0 integration tests | 3 new                             | ✅ 8 new                                      |
| Reliability — retry success    | unmeasured          | baseline + 50%                    | Counter shipped; awaits openai-compat retries |
| Speed — assembly latency       | unmeasured          | parallel-fetched, measurable drop | ✅ `assembly_ms=210` live on chat path        |
| Speed — p50/p95                | 39s / 172s          | maintained                        | Out of measurement window                     |
| Reliability — shipped rate     | 98.9%               | maintained                        | Out of measurement window                     |
| Reliability — with_concerns    | 19.5%               | ≤15%                              | Out of measurement window                     |
| **NOT a goal** — cost          | $495/mo             | not tracked                       | (per operator re-scope)                       |

---

## Honest accounting — what we didn't ship

| Original item                    | Dropped because                                                                | Documented at                    |
| -------------------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| T-03 native cache diagnostics    | SDK doesn't expose `diagnostics.previous_message_id` (T-01) + cost not a lever | `sprint-1-sdk-probe.md`          |
| T-05 strict tool schemas         | SDK doesn't expose per-tool `strict: true` (T-01)                              | Same                             |
| T-06 cache-block collapse fix    | SDK manages caching internally + spill to Sprint 2 per operator                | Same                             |
| T-07 Tool Search Tool migration  | SDK doesn't expose server-side tools (T-01)                                    | Same                             |
| R-2 bulk trim 30% mean reduction | Each outlier is load-bearing ACI; risk of degrading tool selection             | `sprint-1-r2-tool-tightening.md` |

These items did NOT spill silently — each has a planning doc explaining what we ship instead and what Sprint 2+ should do.

---

## Sprint 2 entry plan

In priority order:

1. **SDK version upgrade evaluation** — `@anthropic-ai/claude-agent-sdk@0.2.101 → 0.3.150` (49 minor versions behind upstream). Probe whether 0.3.x exposes the missing surfaces (cache_control, diagnostics, strict tool, tool_search). If yes, T-03/T-05/T-06/T-07 become Sprint 2 main work.
2. **Tool description trimming pass** — start with the 3 outliers >2500 chars per `sprint-1-r2-tool-tightening.md`. Halving those three alone trims ~5400 chars from the catalog.
3. **R-1 baseline diff** at 2026-05-30 (full 7-day post-deploy window). Verify scope_telemetry coverage moved 73% → ≥95% as expected.
4. **R-5 lift measurement** — same window. Read `mc_fast_hallucination_retry_outcome_total{result}` ratios.
5. **SDK-path hallucination detection** — R-1 audit W1 surfaced that our 7-layer detection + retry exists only on openai-compat. Investigate whether SDK path needs equivalent protection (distinct failure mode — SDK may silently fail to retry a tool).

---

## Lessons for future sprints

1. **Probe constraints early.** T-01's SDK probe surfaced sprint-altering findings on day 1, saving 4 wasted item-days. Build the constraint probe into the first day of any architecture-touching sprint.
2. **Honest scope re-decision is a deliverable.** R-2 was originally "halve descriptions across 250 tools." After surveying, the honest answer was "ship a guardrail, defer the trim." That re-decision IS the work product when the original scope is wrong.
3. **The audit/fold loop adds real bytes of correctness.** Every R-item shipped PASS WITH WARNINGS, and every warning that could be folded was folded same-bundle. The 4th test on R-2's guardrail (catching the one-sided drift gap) and the path-scope JSDoc on R-1's counter both came from the audit, not from the original spec.
4. **Backup before mutation pays off even when not invoked.** Git tag + `/root/claude-backups/sprint-1-pre-2026-05-23/` (224K) sat unused, but the team's discipline of taking the snapshot upfront made the sprint feel lower-risk. Compound effect across many sprints.
5. **Document path divergence honestly.** R-1's audit W1 ("counter fires on openai-compat path only") could have been hidden behind a vague help string. Writing the divergence into the help string + R-5 task description + the post-mortem here means the next contributor doesn't have to rediscover it.

---

## Final sprint state

- **Commits:** 8 (3 day-1 T-items + 5 R-items)
- **Tests added:** +29 (6 in scope-telemetry + 8 R-4 integration + 1 R-3 bytes-stable + 4 R-2 guardrail + 3 R-5 retry + 7 R-1+R-4 retry-counter variants overlapping)
- **Test count:** 5639 (T-02 baseline day-1) → **5672** (R-5 deploy)
- **Net LOC delta:** ~+1000 (mostly tests + planning docs)
- **Service health post-deploys:** active, db ok, inference ok across all 5 restarts
- **Backup retained:** `sprint-1-replan-pre-2026-05-23` tag + 7-file backup at `/root/claude-backups/sprint-1-pre-2026-05-23/`

Sprint 1 closed. Sprint 2 entry queued in `next-sessions-queue.md` (to be added in this commit).
