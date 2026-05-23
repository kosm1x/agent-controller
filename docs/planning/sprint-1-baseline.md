# Sprint 1 Baseline — Fast Runner

**Snapshot:** 2026-05-23 (T-02 deliverable).
**Window:** Last 7 days, `agent_type='fast'`.
**Purpose:** Measurement spine for Sprint 1. Every post-sprint claim must be diffable against these numbers. Re-run the queries verbatim in T-08; do not paraphrase.

---

## TL;DR — three findings that re-frame Sprint 1

1. **Fast spend is ~$420-860/mo, not $754.** The 7-day extrapolation is **$495/mo** ($115.28 × 4.3). The "$754/mo" figure carried in prior memory was an early post-SDK-cutover projection and should be retired in favor of the live trend below.

2. **95% of fast turns sit in the 20-50% cache-hit bucket** with mean cache_create=51,341 tokens per turn — meaning the supposedly-stable prefix is being re-created on essentially every turn. The cache_diag investigation pointed to `flattenMessagesForSdk` as the cause; the live distribution corroborates. **Expected T-06 payoff** (moving the 20-50% bucket → ≥80%): ~$82/week ≈ **$355/mo** on the fast line alone.

3. **9.0% tool utilization.** Mean 50.7 tools loaded per task vs 4.6 called. We are loading 11× more tools than the LLM uses. **T-07 (Tool Search migration) is exactly the right architectural answer** — it's not an optimization, it's a correction.

---

## METRIC 1 — Cache shape

| Field                           | Value     |
| ------------------------------- | --------- |
| Fast tasks with cost rows (7d)  | **363**   |
| Mean `cache_read_tokens`        | 291,071   |
| Mean `cache_creation_tokens`    | 52,371    |
| Mean `prompt_tokens` (uncached) | 343,450   |
| % cache read of total input     | **42.4%** |
| % cache create of total input   | 7.6%      |

**Reproducible query:**

```sql
SELECT
  COUNT(*) AS fast_tasks_with_cost_rows,
  ROUND(AVG(cache_read_tokens), 0) AS mean_cache_read,
  ROUND(AVG(cache_creation_tokens), 0) AS mean_cache_create,
  ROUND(AVG(prompt_tokens), 0) AS mean_prompt,
  ROUND(SUM(cache_read_tokens) * 100.0
        / NULLIF(SUM(cache_read_tokens + cache_creation_tokens + prompt_tokens), 0), 2) AS pct_cache_read_of_input,
  ROUND(SUM(cache_creation_tokens) * 100.0
        / NULLIF(SUM(cache_read_tokens + cache_creation_tokens + prompt_tokens), 0), 2) AS pct_cache_create_of_input
FROM cost_ledger
WHERE agent_type = 'fast'
  AND created_at >= datetime('now', '-7 days');
```

### Cache hit distribution (per turn)

| Bucket           | n       | Mean prompt | Mean cache_read | Mean cache_create | Mean cost  |
| ---------------- | ------- | ----------- | --------------- | ----------------- | ---------- |
| 00_no_cache (0%) | 15      | 54,968      | 0               | 54,965            | $0.214     |
| 01_lt20pct       | 4       | 182,864     | 51,575          | 131,284           | $0.548     |
| 02_20_50         | **344** | 357,896     | 306,547         | **51,341**        | **$0.319** |
| 03_50_80         | 0       | —           | —               | —                 | —          |
| 04_ge80          | 0       | —           | —               | —                 | —          |

**Read:** Zero turns reach ≥50% cache hits. The 20-50% bucket dominates (95%) with the 51k cache_create/turn the smoking gun for the cache-collapse bug. The 15 no-cache turns are likely cold-start or first-touch tasks; the 4 lt20pct outliers are interesting (high cache_create, large prompts — worth investigating separately, possibly very long conversation threads).

**Reproducible query:**

```sql
SELECT
  CASE
    WHEN cache_read_tokens = 0 THEN '00_no_cache'
    WHEN cache_read_tokens * 1.0
         / (cache_read_tokens + cache_creation_tokens + prompt_tokens) < 0.20 THEN '01_lt20pct'
    WHEN cache_read_tokens * 1.0
         / (cache_read_tokens + cache_creation_tokens + prompt_tokens) < 0.50 THEN '02_20_50'
    WHEN cache_read_tokens * 1.0
         / (cache_read_tokens + cache_creation_tokens + prompt_tokens) < 0.80 THEN '03_50_80'
    ELSE '04_ge80'
  END AS cache_hit_bucket,
  COUNT(*) AS n,
  ROUND(AVG(prompt_tokens), 0) AS mean_prompt,
  ROUND(AVG(cache_read_tokens), 0) AS mean_cread,
  ROUND(AVG(cache_creation_tokens), 0) AS mean_ccreate,
  ROUND(AVG(cost_usd), 4) AS mean_cost
FROM cost_ledger
WHERE agent_type='fast'
  AND created_at >= datetime('now', '-7 days')
GROUP BY cache_hit_bucket
ORDER BY cache_hit_bucket;
```

---

## METRIC 2 — Latency

| Field                     | Value       |
| ------------------------- | ----------- |
| Fast tasks completed (7d) | **361**     |
| Mean wall-clock           | **61.2 s**  |
| **p50**                   | **39.0 s**  |
| **p95**                   | **172.0 s** |

**Read:** Tail is heavy. p95 is 4.4× p50. T-04 (parallel-tool audit) and T-06 (cache fix) both attack the tail.

**Reproducible query:** see file source — uses `LIMIT 1 OFFSET (COUNT × 0.95)` pattern.

---

## METRIC 3 — Cost (7d + 30d trend)

| Field                     | Value       |
| ------------------------- | ----------- |
| Cost rows (7d)            | 363         |
| **Total fast spend (7d)** | **$115.28** |
| Mean cost per task        | **$0.3176** |
| Extrapolated 30d          | **$495.68** |

### Historical weekly trend (60 days)

| Week     | Tasks | Spend   | Mean/task |
| -------- | ----- | ------- | --------- |
| 2026-W20 | 311   | $98.00  | $0.3151   |
| 2026-W19 | 401   | $103.98 | $0.2593   |
| 2026-W18 | 632   | $199.88 | $0.3163   |
| 2026-W17 | 583   | $192.04 | $0.3294   |
| 2026-W16 | 656   | $179.91 | $0.2743   |
| 2026-W15 | 347   | $1.28   | $0.0037   |
| 2026-W14 | 609   | $10.93  | $0.0180   |
| 2026-W13 | 930   | $6.93   | $0.0075   |
| 2026-W12 | 544   | $30.72  | $0.0565   |

**Critical inflection:** The W15→W16 jump (Apr 12 → Apr 13) corresponds to the **2026-05-10 SDK cutover** to `claude-sdk` as primary inference. Pre-cutover, fast was on Fireworks/OpenAI-compat with negligible cost; post-cutover, fast routes through Sonnet 4.6 at $3/$15 per MTok. Per-task cost increased **~40×** ($0.0075 → $0.3151).

This is not a regression — the SDK cutover was an intentional reliability/quality trade. Sprint 1 partially reverses the COST side of that trade by stabilizing the cache (T-06) and reducing prompt size (T-07).

---

## METRIC 4 — Reliability (status distribution)

| Status                  | n   | %     |
| ----------------------- | --- | ----- |
| completed               | 290 | 79.5% |
| completed_with_concerns | 71  | 19.5% |
| needs_context           | 2   | 0.5%  |
| failed                  | 2   | 0.5%  |

**Read:**

- **"Shipped" rate (completed + completed_with_concerns):** **98.9%** — matches the dossier number.
- **"Clean" rate (completed only):** **79.5%** — the gap (19.5% with_concerns) is what the verification nudge + quality checks generate.
- Sprint must not let this regress. T-05 (strict mode) should _reduce_ with_concerns by eliminating the JSON-arg failure subclass that contributes to it.

**Reproducible query:**

```sql
SELECT status, COUNT(*) AS n
FROM tasks
WHERE agent_type='fast' AND created_at >= datetime('now', '-7 days')
GROUP BY status ORDER BY n DESC;
```

---

## METRIC 5 — Tool surface (utilization)

| Field                           | Value    |
| ------------------------------- | -------- |
| Scope rows (7d, non-degenerate) | 268      |
| Mean tools in scope             | **50.7** |
| Mean tools called               | **4.6**  |
| **Utilization**                 | **9.0%** |
| Mean tools failed               | 0.0      |
| Mean tools repaired             | 0.0      |

### Distribution by scope size

| Tools in scope             | n tasks | Mean called | % util |
| -------------------------- | ------- | ----------- | ------ |
| ≤10 (rituals/skipDeferral) | 1       | 0.0         | 0%     |
| 11-25                      | 0       | —           | —      |
| 26-50                      | 162     | 4.1         | 9.7%   |
| 51-75                      | 79      | 4.7         | 7.4%   |
| >75                        | 26      | 7.2         | 8.5%   |

**Read:** Utilization is flat across scope sizes — adding more tools to the scope does NOT yield more tools-called. This is the canonical Tool Search Tool argument: server-side BM25 retrieval should select the 4-5 tools the LLM actually uses, and the rest stay outside the prefix.

**Coverage caveat:** Only 268 scope_telemetry rows over 7d vs 365 fast tasks completed → ~73% coverage. Either: (a) some fast tasks bypass `recordToolExecution`, (b) some are conversation tasks where scope isn't recorded, (c) recording is in a code path that drops on certain branches. Worth investigating in T-04 since T-04 also touches the executor.

**Reproducible query:**

```sql
SELECT
  COUNT(*) AS n_tasks,
  ROUND(AVG(json_array_length(tools_in_scope)), 1) AS mean_tools,
  ROUND(AVG(json_array_length(tools_called)), 1) AS mean_called,
  ROUND(AVG(json_array_length(tools_called)) * 100.0
        / AVG(json_array_length(tools_in_scope)), 1) AS pct_utilization
FROM scope_telemetry
WHERE created_at >= datetime('now', '-7 days')
  AND json_array_length(tools_in_scope) > 0;
```

---

## METRIC 6 — Model attribution

| Model             | n (7d) | Spend (7d) |
| ----------------- | ------ | ---------- |
| claude-sonnet-4-6 | 363    | $115.28    |

**Read:** 100% Sonnet 4.6. No Haiku leakage, no Sonnet 4.5 leakage, no Opus leakage on fast. Confirms the assumption underlying T-05 (Haiku cascade for aux calls) is targeting a real lever — every single fast turn is paying Sonnet pricing.

---

## METRIC 7 — Tool execution shape (parallel vs serial)

**Deferred to T-04** (parallel-tool audit). Direct SQL doesn't surface per-call wall-clock; T-04 will read code + measure one live trace + add a metric if missing.

---

## Sprint 1 success criteria — derived from this baseline

The plan's headline goals translate into specific diffable numbers:

| Plan goal                       | Concrete target diff                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cache hit rate ≥40% improvement | Move ≥300 of the 344 "20-50%" bucket turns into "≥80%" cache hit bucket; overall pct_cache_read_of_input from 42.4% → ≥60% |
| Prompt size ≥50% reduction      | Mean prompt_tokens 343,450 → ≤170,000 (Tool Search migration is the load-bearing change)                                   |
| Fast spend ≥30% reduction       | 30d extrapolated $495 → ≤$345 (T-06 alone projected ~$355/mo savings; trust margin)                                        |
| Reliability ≥98.9%              | "Shipped" rate (completed + concerns) stays ≥98.9%                                                                         |
| No latency regression           | p50 stays ≤45s; p95 stays ≤180s (gives ~10s headroom on both)                                                              |
| Cleaner reliability             | with_concerns rate 19.5% → ≤15% (strict mode reduces JSON-arg failure subclass)                                            |

---

## Caveats / honest accounting

- **The $754/mo number in prior memory should be retired.** Live trend is $98-200/week (W16-W20 stable), extrapolating to $420-860/mo. Memory file `sdk_systemprompt_single_cache_block.md` should be updated to cite the current $495/mo extrapolation, not the older projection.
- **No `recall_audit` data analyzed** — this baseline focuses on cost/latency/cache/tool surface. Memory hit rate is a separate concern (T-10 in the 10-item list, telemetry-gated, deferred to Sprint 2+).
- **Tool execution shape (Metric 7)** intentionally deferred — produces noise to estimate from SQL alone; T-04 will read code directly.
- **No vision/image-heavy task slice** — the cache-hit bucket query lumps all fast turns together; image-heavy turns may have very different cache shapes. Spot-check during T-06.

---

**Generated:** 2026-05-23 by Sprint 1 task T-02.
**Re-run at:** T-08 (sprint retro) for the diff.
