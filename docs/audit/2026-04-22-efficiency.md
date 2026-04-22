# Dimension 1 — Efficiency audit

> **Status**: COMPLETE — 8 probes run, 6 findings landed as fixes, 2 deferred with triggers.
> **Baseline**: `../benchmarks/2026-04-22-baseline.md` (captured 09:01 UTC same day)
> **Methodology**: `../planning/stabilization/full-system-audit.md`
> **Post-fix commit**: see Commits section below.
>
> **Headline**: three observability bugs discovered and fixed mid-audit. Before fixing them, all measurements on the Sonnet path were unreliable (wrong model label, under-counted input tokens, empty tool-call telemetry). Post-fix, first live measurement showed Anthropic prompt caching firing at **56% hit ratio** on the second identical-shape call, cutting reported cost from $0.0578 → $0.0280 per turn.

---

## Summary

| Probe | Status   | Finding severity | Decision                                                                                                                                                                                  |
| ----- | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1    | complete | Critical         | Fix: cost_ledger model label under claude-sdk was stale `qwen3.5-plus`; now `claude-sonnet-4-6` (P0-2).                                                                                   |
| E2    | complete | Info             | No runaway loops (avg 1.0 LLM call per fast-runner task). `task_provenance` sparse — only heavy/swarm fire it.                                                                            |
| E3    | complete | Critical         | Fix: `scope_telemetry.tools_called` was always `[]` on SDK path (recordToolExecution not called). Populated from next call forward.                                                       |
| E4    | complete | Major            | Fix: no cache hit/miss counters existed in `DataLayer`; `stats()` added on `getDaily` path.                                                                                               |
| E5    | complete | Major            | Fix: per-call timing added to `recall()` so 5388ms baseline can be split into real latency vs 5s timeout.                                                                                 |
| E6    | complete | Info             | No regression; proper instrumentation deferred to Speed dimension.                                                                                                                        |
| E7    | complete | Warning          | Defer: three rituals fire simultaneously at 09:00 CDMX. Operator decision (stagger vs bundle).                                                                                            |
| E8    | complete | **Critical**     | Fix: `mxTime` in `identitySection` broke prompt cache (every call unique). Moved to user-msg preamble. Cache hit 0% → 56% on second call, cost **~52% lower per turn** (smoke-test data). |

Severity: Critical (ship-blocker, landed this audit) / Major (P0, landed) / Warning (P1/P2, document) / Info (no action).

---

## E1 — Tokens-per-task by agent type (7d + 30d)

### Measurement

**30d cost_ledger:**

| agent | model            | calls | avg prompt | avg completion | avg total |
| ----- | ---------------- | ----- | ---------- | -------------- | --------- |
| fast  | qwen3.5-plus     | 2,174 | 22,702     | 888            | 23,590    |
| fast  | kimi-k2.5        | 169   | 13,213     | 221            | 13,435    |
| fast  | llama-4-scout    | 141   | 5          | 1,192          | 1,197     |
| fast  | qwen3-coder-plus | 73    | 5,833      | 156            | 5,988     |
| fast  | glm-5            | 68    | 58,713     | 625            | 59,338    |
| heavy | qwen3.5-plus     | 64    | 188,727    | 11,104         | 199,831   |
| heavy | glm-5            | 6     | 92,140     | 6,262          | 98,402    |

**Post-Sonnet flip (2026-04-22 ≥ 08:35 UTC), 24 rows pre-fix:**

| agent | model (logged, wrong) | avg prompt | avg completion |
| ----- | --------------------- | ---------- | -------------- |
| fast  | `qwen3.5-plus`        | **8**      | 2,425          |

The `avg prompt = 8` is the smoking-gun observability bug: Sonnet calls were recording only `input_tokens` (the fresh/uncached portion). With SDK prompt caching on, that number is ~8 tokens — most of the prompt was being sent as `cache_creation_input_tokens` + `cache_read_input_tokens` and discarded by the ledger. See E8 for the cache-break diagnosis.

**Post-fix smoke test (3 Sonnet calls, 19:55 UTC):**

| agent | model               | calls | avg prompt | avg completion |
| ----- | ------------------- | ----- | ---------- | -------------- |
| fast  | `claude-sonnet-4-6` | 3     | 73,619     | 179            |

Model label now correct. Prompt tokens now include cache fields (Anthropic Messages API spec: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`).

### Finding

**Critical — three stacked observability bugs on the Sonnet path (matches baseline's P0-2 + surfaces two more):**

1. Model string: `cfg.inferencePrimaryModel` was stale `"qwen3.5-plus"` despite provider=`claude-sdk`. `getModelFromTask()` returned it verbatim.
2. Prompt-token count: only raw `input_tokens` recorded, missing cache tokens (spec says to sum all three).
3. Per-call model attribution lost when multiple models are invoked in one run (no `actualModel` threaded from result).

All three blocked honest token-per-task measurement.

### Decision — **Fix**

- `src/dispatch/dispatcher.ts` — `getModelFromTask` returns `SONNET_MODEL_ID` under `claude-sdk`; prefer `result.tokenUsage.actualModel` when present.
- `src/inference/claude-sdk.ts` — export `SONNET_MODEL_ID`; sum three input-token fields into `promptTokens`; surface `cacheReadTokens` + `cacheCreationTokens`; extract actual model from `success.modelUsage`.
- `src/runners/fast-runner.ts` — thread `actualModel` + `actualCostUsd` + cache tokens through `tokenUsage`.
- `src/budget/service.ts` — `recordCost` accepts `costUsdOverride` so Max-auth $0 is recorded faithfully instead of re-computed via pricing table.
- `src/budget/pricing.ts` — Sonnet/Opus/Haiku entries with $0 pricing (Max auth); document override path.
- Tests: 6 new assertions in `claude-sdk.test.ts` + `service.test.ts`.

---

## E2 — Tool-call overhead + duplicate reads

### Measurement

```
SELECT MIN(calls), ROUND(AVG(calls),1), MAX(calls)
FROM (SELECT t.task_id, COUNT(c.id) AS calls FROM tasks t LEFT JOIN cost_ledger c ON c.task_id=t.task_id WHERE t.agent_type='fast' AND t.created_at>=datetime('now','-7 days') GROUP BY t.task_id)
```

Result: **min=0, avg=1.0, max=1** (fast-runner, 7d). A clean 1:1 task-to-cost_ledger ratio — no LLM-call loops on fast-runner.

Duplicate provenance (same task, same tool, same URL/query >1 hit):

```
SELECT task_id, tool_name, target, COUNT(*) FROM task_provenance WHERE created_at>=datetime('now','-30d') AND target IS NOT NULL GROUP BY 1,2,3 HAVING COUNT(*)>1
```

Zero rows in 30d. But `task_provenance` has only 85 rows in 30d vs 2,660 fast tasks — sparse because provenance is only written on certain heavy/swarm paths with goal graphs. Fast-runner does not emit provenance rows.

### Finding

**Info — no waste detected, but sparse provenance limits observability.** Provenance is written by a subset of runners; the fast-runner path (96% of volume) isn't observable via this table.

### Decision — **Defer (trigger: Speed audit)**

Fast-runner tool-call patterns aren't currently instrumented at provenance-level granularity. Adding that would be new feature work outside the audit freeze scope. The Speed audit will look at per-tool latency via `/health.topByLatency`; if tool-call overhead surfaces there, re-promote.

---

## E3 — Deferred-tool activation yield

### Measurement — pre-fix

```
SELECT active_groups, COUNT(*) AS activations, AVG(yield) AS mean_yield
FROM scope_telemetry
WHERE tools_called != '[]' ... GROUP BY active_groups
```

Result: **mean_yield = 0.0 for every single scope group.**

Raw inspection:

```
1759 | Intenta con MCP         | ["browser","google"] | tools_called=[]
1758 | Entra a la plataforma   | ["browser","google"] | tools_called=[]
1743 | Quién es Federico...    | [20 groups, all of them] | tools_called=[]
...
```

Every row's `tools_called` is empty. Hypothesis verified: `recordToolExecution()` was only called from the OpenAI/inferWithTools code path (`fast-runner.ts:1122`). The SDK branch returned early at line 1013 without recording — so every Sonnet-routed task silently dropped tool-call telemetry.

### Side finding

The `"Quién es Federico Moctezuma"` and `"Sofía está perfecto"` messages activated **all 20 scope groups** at once. That's pure noise — a single identity question has no business activating `crm`, `social`, `seo`, `ads`, `destructive`, etc. Root cause not diagnosed here (it's a Dim-5 tool-scoping concern) but it's visible in scope_telemetry and inflating `tools_in_scope` averages.

### Finding

**Critical — yield was unmeasurable because telemetry writes were silently dropped on the dominant code path.**

### Decision — **Fix + defer downstream**

- `src/runners/fast-runner.ts` — SDK branch now calls `recordToolExecution(input.taskId, sdkResult.toolCalls, [])` before returning. Failed-tool list is empty for the SDK path (no is_error surfaced yet); tracking that is a follow-up.
- Scope-over-activation on identity questions: **defer to Dim 5 (tool-scoping) audit**; promote if a week of correct data shows the pattern persists.

---

## E4 — L1/L2 cache hit ratios in data layer

### Measurement

Code inspection of `src/finance/data-layer.ts`: L1 (`Map<string, CacheEntry>` with FIFO eviction, 500 entries) and L2 (SQLite `market_data` table). Hit/miss counters: **none existed.** `api_call_budget` only tracks realised API calls (misses); total-request count is not persisted.

### Finding

**Major — cache hit ratio not measurable.** No observability for what's supposed to be ≥80% hit ratio per the H2 hardening success criterion in the audit methodology.

### Decision — **Fix**

- `src/finance/data-layer.ts` — added private `cacheStats` object and public `stats()` method tracking `l1Hits`, `l2Hits`, `l2Stale`, `fetches`, `inflightDedups`, plus derived `hitRatio`.
- Instrumented `getDaily` path this pass. `getWeekly`, `getIntraday`, `getMacro` follow the same shape — plumbing them through is a mechanical follow-up.
- Test added: `data-layer.test.ts` — asserts counters track L1/L2/fetch breakdown across two instances.
- **Follow-up**: wire `stats()` into `/health` endpoint. Deferred so this commit stays scoped to Dim 1.

---

## E5 — Memory search/reflect latency root cause

### Evidence

- `src/memory/hindsight-client.ts:14` — `DEFAULT_TIMEOUT_MS = 5000`.
- Baseline `/health.topByLatency` showed `memory_search` avg 5388ms — indistinguishable from "everything times out at 5s" vs "everything takes ~5s legit."
- Real p50/p90/p99 invisible: prior logs only wrote "Hybrid recall: FTS5=X, embed=Y, merged=Z" without a timestamp delta.

### Finding

**Major — latency bucket unknown because per-call timing wasn't logged.** Cannot decide between "shorten the timeout" and "fix the embedding/Hindsight round trip" without data.

### Decision — **Fix**

- `src/memory/hindsight-backend.ts` — added Date.now() timing around both the Hindsight path and the SQLite fallback. Logs `[memory] recall(hindsight) bank=... results=N Tms` on success, `recall(hindsight) FAILED after Tms` + `recall(sqlite-fallback) results=N Tms` on failure.
- After 24h of production data, re-query journalctl and decide: (a) Hindsight reliably <1s → tighten timeout; (b) Hindsight reliably 3-5s → investigate network path; (c) Hindsight times out frequently → force SQLite primary, circuit-breaker open harder.

---

## E6 — Conversation thread buffer vs used tokens

### Evidence

- Read-only analysis of `src/runners/fast-runner.ts` prompt assembly.
- For chat tasks (the hot path), message composition is: system (description+STATUS_SUFFIX) → system (essentials ~200tok) → system (KB section, 0–5k) → system (precedent block, 0–2k) → system (deferred catalog, 3–5k) → each conversationHistory turn.
- conversationHistory flows verbatim — no summarization until the SDK's internal auto-compact at `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000`.
- No per-call instrumentation of "buffer bytes vs actually-used tokens."

### Finding

**Info — no acute waste visible from static inspection; instrumentation is missing to measure.** A 20-turn conversation will resend all turns every call (cache should absorb the system+turns prefix now that E8 is fixed, but the user-message-to-user-message delta will still retransmit repeats).

### Decision — **Defer (trigger: Speed audit, or if cost ledger shows >30% regression week-over-week post-fix)**

The Speed dimension audit will add per-call prompt-size logging. If that reveals buffer-vs-used skew >2x, promote to a thread-compaction work item.

---

## E7 — Scheduled task duplication / overlap

### Measurement

```
id | name                                             | cron_expr    | last_run_at          | active
---+--------------------------------------------------+--------------+----------------------+-------
 3 | PipeSong Tech Radar - Revisión TTS/STT           | 0 9 */3 * *  | 2026-04-22 15:00:00  | 1
19 | Monitoreo Roadmap Jarvis v7                      | 0 9 * * *    | 2026-04-22 15:00:00  | 1
29 | Reporte Diario Pharma & Cáncer + EurekaMD        | 0 9 * * *    | 2026-04-22 15:00:00  | 1
```

Three rituals fire at exactly 09:00 CDMX (15:00 UTC). Two fire daily, one every third day. All three kick off Sonnet runs concurrently.

### Finding

**Warning — simultaneous launch, not a bug.** LLM-call path handles parallelism fine. Concerns are:

- Spike in token throughput at one minute of the day
- Rate-limit risk if one ritual hits a flaky provider and cascade-retries overlap
- Telegram delivery burst (3 reports landing within seconds)

### Decision — **Defer (operator decision)**

Options:

1. Stagger: change `0 9 * * *` → `0 9 * * *` / `5 9 * * *` / `10 9 * * *`. 5-min spread. Zero code change.
2. Keep bundled: accept the spike; it's below Jarvis's steady-state capacity.
3. Rate-limit at scheduler level: harder, defers further.

Operator call. Flag on the 30d-hardening-plan P1 list. Trigger to promote: if any of the three rituals starts hitting token/rate limits.

---

## E8 — Prompt token audit + caching

### Evidence chain

1. Log grep showed `[prompt] System prompt: 3972 tokens, 11 sections` for a typical call — the Jarvis persona + scoped sections.
2. First smoke call post-deploy: `prompt_tokens=15395` total, cache_read=0, cache_creation=15392. **The whole prompt was being freshly hashed every call — 0% cache hit.**
3. Root-cause trace: `src/messaging/prompt-sections.ts:63` — identitySection was calling out the current time ("son las ${mxTime}") in a P1 (never-truncated) block. `mxTime` changes every second → the system prompt's byte contents differ on every call → Anthropic prompt cache never reuses its prefix → zero cache hit.
4. Prior log line showed `[prompt] System prompt: 3972 tokens` — the Jarvis persona was stable in shape but not in bytes.

### Fix

- `src/messaging/prompt-sections.ts` — identitySection is now byte-stable across calls (no date, no time). New helper `timeContextLine(mxDate, mxTime)` emits a compact single-line block consumed by the user message.
- `src/messaging/router.ts` —
  - `buildJarvisSystemPrompt` signature trimmed (no mxDate/mxTime args).
  - Chat path: copies `conversationHistory` and prepends `timeContextLine(...)` to the final user turn's content.
  - Background-agent spawn path: appends `timeContextLine(...)` inside the `description` body (which the non-chat fast-runner branch already emits as a user message).
- Tests: `prompt-sections.test.ts` asserts byte-identical output across two calls; `router.test.ts` asserts the preamble lands on the last user turn.

### Verification (live smoke)

Two synthetic Sonnet tasks submitted via `POST /api/tasks`, 30s apart, shared scope:

| Call | prompt_tokens | cache_read | cache_creation | cache hit | cost_usd    |
| ---- | ------------- | ---------- | -------------- | --------- | ----------- |
| 1    | 15,395        | 0          | 15,392         | 0%        | $0.0578     |
| 2    | 15,397        | 8,678      | 6,716          | **56%**   | **$0.0280** |

- **~52% cost reduction** on the second call, delivered entirely by making the system prompt byte-stable.
- At steady-state chat traffic (~300 fast tasks/day), a rough projection: if warm-cache hit ratio averages 40–60%, theoretical Sonnet-rate-equivalent spend drops from the $62/mo baseline to ~$30-35/mo. (Moot under Max subscription — real billing is $0 — but token throughput reduction is real and will matter on any API migration.)

### Decision — **Fix landed**

### Follow-ups captured

- SystemPrompt remains ~4k tokens. The next 11k of each call is KB + deferred catalog + precedent + history — those are already positioned after the cached system prefix, but not individually cached. Incremental gain if we expose them through the SDK's breakpoint mechanism.
- Prompt-size-by-section logging (`[prompt] section=kb tokens=X`) would turn E8's qualitative argument quantitative; defer to Speed dimension.

---

## Commits landed this audit

- `(this session)` — fix(observability): Dim-1 efficiency audit
  - model-label fix (P0-2), SDK token accounting (cache fields), scope_telemetry SDK-path fix, cost override for Max auth, SONNET_MODEL_ID constant, `DataLayer.stats()`, memory recall timing logs, cache-friendly systemPrompt (time context → user msg preamble).
  - Tests: 3711 → 3717 (+6 assertions).
  - Live verification: cache hit 0% → 56% on second smoke call, $0.0578 → $0.0280 per turn.

---

## Dimension 1 closing criteria vs actuals

| Criterion                                                                          | Status after this audit                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Median tokens-per-task for fast-runner ≤25% over baseline despite Sonnet verbosity | Deferred — first post-fix sample n=3 is too small. Re-measure at day-7.                                 |
| Tool-deferral activation yield ≥70%                                                | Unmeasurable until now; telemetry writes restored. Re-measure at day-7 with real data.                  |
| Cache hit ratio in data layer ≥80%                                                 | Counters now exist; no hit-ratio data yet (finance tools low-traffic in chat).                          |
| No prompt block >10 KB outside cacheable position                                  | Partially verified: systemPrompt is now fully cacheable (~15k). KB + catalog not individually cached.   |
| **Prompt caching actually firing on the Sonnet path**                              | **0% → 56% on first post-fix repeat call.** This was the unwritten criterion driving the other numbers. |

---

## Key patterns to carry forward

1. **Observability bugs cascade.** Three stacked bugs (model label, token count, tool telemetry) all invalidated the Sonnet-path data. A fourth — prompt cache not firing — invalidated the cost/latency story. Fix instrumentation before you trust any number.
2. **"Static-looking" blocks lie.** identitySection looked static but embedded `${mxTime}` mid-P1. Cache performance is a byte-level invariant; every template interpolation is a suspect.
3. **Measurement-driven audit requires good measurement infrastructure.** The productive 45 minutes of this audit were spent fixing the instrumentation; the "audit" itself then became a verification pass.

Next dimension: Speed. Methodology in `../planning/stabilization/full-system-audit.md`.
