# F7 Alpha Combination Engine — Implementation Plan

> **Phase:** β (Financial Stack v7.0), S6 of β — the algorithmic core.
> **Scope:** 11-step combination pipeline with ISQ, weight versioning, singularity guard, probability mode.
> **Branch:** `phase-beta/f7-alpha-combination`.
> **Upstream plans:** `06-f7-math-study.md`, `10-f7-addendum.md`, `V7-ALPHA-COMBINATION-EQUATIONS.md`.
> **Upstream feedback:** `feedback_phase_beta_5sprint_day.md` — F7 **must not bundle**; solo focus; budget 2 audit passes; hand-computed golden values per pipeline step.

Per the 5-sprint-day meta-pattern, F7 gets a fundamentally different rhythm than S1–S5. This plan exists to make F7 a translation task (not an invention task) by the time the first `npm test` runs.

---

## 1. Scope

**In (shipped this sprint):**

- Pure-math pipeline: `src/finance/alpha-combination.ts` — 11 steps + orchestration
- Return matrix builder: `src/finance/alpha-matrix.ts` — R(i,s) construction from F3 firings + F1 closes
- ISQ computer: `src/finance/alpha-isq.ts` — 5 dimensions per signal per run
- Linear algebra primitives: `src/finance/alpha-linalg.ts` — scalar OLS (no intercept) via Fama-MacBeth-style time-average + correlation matrix + vector helpers
- Probability-mode input parser: shared entry point in `alpha-combination.ts` accepts `mode: "returns" | "probability"`
- Schema migration: 2 new tables (`signal_weights`, `signal_isq`), additive, live-applicable
- Tool surface: 3 tools — `alpha_run`, `alpha_latest`, `alpha_explain` — all deferred, gated on `alpha` scope
- Scope regex: 1 new activation pattern (alpha/combination/megaalpha/weights vocabulary ES+EN)
- Integration: builtin source register, scope, READ_ONLY / write-tools-sync classification, auto-persist Rule 2b, guards, tests

**Out (deferred with explicit triggers):**

- **Kelly sizing** — moves to F8 per addendum Part 8.3 (sizing ≠ combination; depends on mid-price + CV_edge)
- **Monte Carlo CV_edge** — F8 concern; 10K path simulation per scan is F8/F7.5-scoped
- **Regime-conditional weights** — F5 regime label is logged in `signal_weights.regime`, not branched on. Post-launch once ≥30 runs per regime exist
- **Per-signal optimized `d`** — single global `d = 20` at F7 v1
- **Per-signal optimized `horizon` in R(i,s)** — single `horizon = 1` at v1
- **PCA singularity fallback** — v1 uses exclusion-based guard only; PCA is F7.5 enhancement if aborts become frequent
- **Composite ISQ score** — each dimension stored independently; composites are monitoring-layer concern
- **F9 ritual integration** — F9 reads `alpha_latest`, but the ritual itself is S12
- **F8 consumption** — F8 reads weights by `run_id`; F8 is a separate session

---

## 2. Design decisions resolved upfront

All seven addendum items plus the three new locks (A, K, L below) needed for session execution.

### D-A. Logical signal identity

**`signal_key = "{signal_type}:{symbol}"`** for F3 firings. For F6.5 sentiment: **`"{source}:{indicator}:{symbol||'*'}"`**. For F6 prediction markets: **deferred** (not wired at F7 v1 — the 11-step pipeline consumes returns/probabilities, but F6 stores market snapshots without a time series). The addendum's probability-mode input shape (Part 8.2) is reserved for v1.1.

**N (at F7 v1) ≈** unique F3 `signal_key`s within M-period window + unique F6.5 `signal_key`s. Typical N ≈ 12–20.

**Why**: the `market_signals` table dedupes on `(symbol, signal_type, triggered_at)` (confirmed in `src/finance/signals.ts:379`). The logical signal that the FLAM combines is the `(symbol, type)` recurring pattern across periods s, not the individual row. The row is a firing event, not a signal identity.

### D-B. R(i,s) construction (addendum Part 1, locked)

Implemented in `alpha-matrix.ts`:

```typescript
R(i, s) = close(symbol_i, s + horizon) / close(symbol_i, s) - 1
         (negated when firing.direction === "short")
         = 0 when no firing in period s (neutral)
         = 0 + flag when close missing for either period
```

`symbol_i` is extracted from the `signal_key`. `horizon = 1` bar (daily). Non-firing periods = 0. Signals with >5% flagged periods are dropped from this run with `exclude_reason='missing_data'`.

### D-C. Window sizes (addendum Part 2, locked)

`M = 250` business days, `d = 20` business days. Both in `config.f7.windowM` / `config.f7.windowD`. Overridable via env (`F7_WINDOW_M`, `F7_WINDOW_D`). Throws `F7ConfigError` if `d > M` or `M < 30`.

### D-D. Weight versioning schema (addendum Part 3, locked)

Table `signal_weights`. Append-only. Primary read key is `run_id` (UUID). F8 and F9 pick the most-recent-completed `run_id`; they never read "latest-by-signal".

### D-E. ISQ dimensions (addendum Part 4, locked)

Table `signal_isq`, 5 dimensions (`efficiency`, `timeliness`, `coverage`, `stability`, `forward_ic`), all clamped to [0, 1]. Computed per signal per run. `timeliness` uses America/New_York "today" per existing F1 timezone helpers.

### D-F. Correlation guard (supersedes addendum Part 5)

**Deviation from addendum**: addendum proposed condition-number check on `ΛᵀΛ` via Jacobi eigenvalues. That machinery is over-engineered — the Step 9 regression as written is `N × (M-1)` multivariate, which is **underdetermined** at F7 production dimensions (N≈15, M-1=249) so `ΛᵀΛ` is always rank-deficient by construction.

**F7 v1 uses a scalar-β Fama-MacBeth reading of Step 9** that matches the worked example exactly (verified numerically — see below). The doubling-count concern the condition-number check was meant to address is still handled, but via a correlation-matrix guard on raw returns, which is simpler and more principled:

1. Compute `corr = correlationMatrix(R)` over the raw return rows (N×N, symmetric, diag=1)
2. Find max off-diagonal `|corr[i][j]|`
3. If > 0.95 threshold: exclude the signal in that pair with LOWER `ic_30d` (ties broken by lexicographically-later `signal_key` for determinism)
4. Repeat up to 3 iterations
5. If still > threshold after 3 exclusions: abort with `F7CorrelatedSignalsError`, log to events table

**Worked-example verification**: scalar-β reduces to the exact formula the math study uses. At M=2 (worked example), Λ has only one period so the "time-average Λ_bar" equals that one period. Computed weights `[0.215, 0.015, 0.770]` match addendum's `[0.219, 0.014, 0.767]` to 0.004 (discrepancy = addendum rounded β=1.33 vs actual 1.417 — see verification log in commit history).

### D-G. Step 5/7 off-by-one (addendum Part 6, locked)

Step 5 drops 1 observation (M → M-1). Step 7 is a no-op assertion `assert(Λ.length === M-1)`. Documented inline per spec doc-fix follow-up (deferred).

### D-H. Variance formula (addendum Part 8.1, locked)

**`(M-1)` denominator** (Bessel's correction) per formal equation (2). Step 3 prose in the spec doc has a `1/M` typo; doc fix deferred.

### D-I. Probability mode (addendum Part 8.2, locked)

`mode: "returns" | "probability"` parameter on the entry function. Identical 11 steps; only input semantics differ. `signal_weights.mode` column records which pipeline ran.

**F7 v1 ships probability mode as a pipeline stub**: the math executes over any `(N × M)` input matrix. The consumer (F6 → F7 bridge) is deferred to v1.1 because F6 stores market snapshots, not a probability time-series. The mode parameter + column exist; the input parser for probability mode throws `NotImplementedError` at v1 with a clear message. This preserves schema forward-compatibility without bundling a F6-data-shape redesign into F7.

### D-J. IC filter (addendum Part 8.4, locked)

Signals with `rolling_ic_30d ≤ 0` are excluded before the pipeline. Fresh signals (fewer than 30 firings in 30-day window) are admitted with `ic_30d = null`. Excluded signals are written to `signal_weights` with `excluded=1, exclude_reason='ic_le_zero'`.

### D-K. File layout (new)

**Flat convention** (matches existing `src/finance/signals.ts`, `macro.ts`, `sentiment.ts`):

| File                                           | Purpose                                            | LOC est. |
| ---------------------------------------------- | -------------------------------------------------- | -------- |
| `src/finance/alpha-linalg.ts`                  | scalar OLS (no intercept), correlation, vector ops | ~150     |
| `src/finance/alpha-matrix.ts`                  | `buildReturnMatrix()`, signal identity helpers     | ~180     |
| `src/finance/alpha-isq.ts`                     | 5 ISQ dimensions per signal per run                | ~140     |
| `src/finance/alpha-combination.ts`             | 11-step orchestrator, `runAlphaCombination()`      | ~300     |
| `src/finance/alpha-combination.test.ts`        | Per-step unit tests + fragility + golden-file      | ~400     |
| `src/finance/alpha-linalg.test.ts`             | Linalg primitive tests                             | ~200     |
| `src/finance/alpha-matrix.test.ts`             | Return matrix builder tests                        | ~180     |
| `src/finance/alpha-isq.test.ts`                | ISQ dimension tests                                | ~120     |
| `src/finance/__fixtures__/f7-golden-3x10.json` | Hand-computed fixture                              | ~60      |
| `src/tools/builtin/alpha.ts`                   | 3 tools: alpha_run / alpha_latest / alpha_explain  | ~320     |
| `src/tools/builtin/alpha.test.ts`              | Tool handler tests                                 | ~220     |

Total new source: ~1,200 LOC. Total new tests: ~1,120 LOC. Zero new deps.

### D-L. Tool surface (new)

Three tools, all deferred, all in `alpha` scope group.

| Tool            | Kind  | What it does                                                                                             |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `alpha_run`     | write | Runs the 11-step pipeline. Persists to `signal_weights` + `signal_isq`. Returns run_id + summary.        |
| `alpha_latest`  | read  | Returns the most-recent completed run's weights + N_effective + regime. For F8/F9.                       |
| `alpha_explain` | read  | Given a `run_id` (or default: latest), breaks down signal-by-signal: weight, ε, σ, ISQ, excluded-reason. |

`alpha_run` is gated as a **write tool** (it writes to `signal_weights` + `signal_isq` + `events`). Included in WRITE_TOOLS + write-tools-sync check.

Why three, not one: keeps the read paths cheap (F8/F9 don't pay pipeline cost every call) and makes `alpha_explain` debuggable without re-running.

---

## 3. Schema migration

Additive only — can be applied live via `sqlite3 ./data/mc.db < ddl.sql`. Does NOT require DB reset.

```sql
-- F7 Alpha Combination Engine — 2 new tables

CREATE TABLE IF NOT EXISTS signal_weights (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  run_timestamp   TEXT NOT NULL,                              -- ISO 8601 America/New_York
  mode            TEXT NOT NULL CHECK(mode IN ('returns','probability')),
  signal_key      TEXT NOT NULL,                              -- "{type}:{symbol}" or "{source}:{indicator}:{symbol}"
  signal_name     TEXT NOT NULL,                              -- snapshot display name
  weight          REAL NOT NULL,                              -- w(i) from Step 10; 0 if excluded
  epsilon         REAL,                                       -- residual ε(i); null if excluded
  sigma           REAL,                                       -- σ(i); null if excluded pre-variance
  e_norm          REAL,                                       -- E_normalized(i); null if excluded
  ic_30d          REAL,                                       -- 30-day IC snapshot (null if <30 firings)
  regime          TEXT,                                       -- F5 regime label (bull/bear/volatile/calm/null)
  n_effective     REAL,                                       -- matrix-wide N_effective (redundant per row for queryability)
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  exclude_reason  TEXT,                                       -- 'ic_le_zero','flat_variance','missing_data','singular'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signal_weights_run ON signal_weights(run_id);
CREATE INDEX IF NOT EXISTS idx_signal_weights_time ON signal_weights(run_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_signal_weights_signal ON signal_weights(signal_key, run_timestamp DESC);

CREATE TABLE IF NOT EXISTS signal_isq (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,                              -- logical FK to signal_weights.run_id
  signal_key      TEXT NOT NULL,
  efficiency      REAL NOT NULL,
  timeliness      REAL NOT NULL,
  coverage        REAL NOT NULL,
  stability       REAL NOT NULL,
  forward_ic      REAL NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signal_isq_run ON signal_isq(run_id, signal_key);
```

Applied live during deploy. No data migration required (tables are new).

---

## 4. Algorithm contracts (inputs → outputs)

### 4.1 `buildReturnMatrix(input)` — `alpha-matrix.ts`

**Inputs:**

- `firings`: `market_signals` rows for the M-period window, all symbols
- `bars`: `market_data` daily bars for the union of firing symbols + watchlist, M+horizon periods
- `periods`: ordered list of M ISO date strings (trading days, provided by caller)
- `horizon`: forward bar count (default 1)

**Outputs:**

```typescript
{
  R: Float64Array,         // flat N*M, indexed [i*M + s]
  N: number,
  M: number,
  signalKeys: string[],    // length N, stable order (sorted)
  symbolOfKey: string[],   // length N, parallel to signalKeys
  flags: Array<{i, s, reason}>, // diagnostic log
  excludePremature: Set<number>, // indices where >5% flagged → excluded from this run
}
```

**Invariant:** `R[i*M+s]` is finite for all non-flagged entries. `R[i*M+s] = 0` for flagged entries (neutral). Never NaN, never Inf.

### 4.2 `runAlphaCombination(opts)` — `alpha-combination.ts`

Top-level orchestrator. Called by `alpha_run` tool handler.

**Inputs:**

- `opts.mode`: `"returns" | "probability"` (v1 implements only `"returns"`)
- `opts.windowM`: override default 250
- `opts.windowD`: override default 20
- `opts.asOf`: ISO date, default = today NY
- `opts.runId`: optional UUID override (default: generated)

**Pipeline:**

1. Resolve M periods from `asOf` backwards (trading days only, from F1's `market_data`)
2. Fetch `market_signals` firings in window
3. Fetch `sentiment_readings` in window
4. Derive `signal_keys` set + per-signal 30-day IC
5. Apply IC filter (exclude `ic ≤ 0`, admit `ic == null`)
6. `buildReturnMatrix()` → R, N, M
7. Steps 2–4: serial demean → variance → normalize (drop σ ≤ 1e-6 signals as `flat_variance`)
8. Step 5: slice to first M-1
9. Step 6: cross-sectional demean
10. Step 7: assertion
11. Step 8: forward expected return + normalize (E_norm)
12. Step 9: singularity-guarded OLS → residuals ε
13. Step 10: raw weights w_raw(i) = ε(i) / σ(i)
14. Step 11: normalize Σ|w| = 1, compute η
15. Compute ISQ per signal
16. Compute `N_effective` (sum-of-squared-weights heuristic: `N_eff = (Σ|w|)² / Σw² = 1 / Σw²`)
17. Persist to `signal_weights` + `signal_isq` in one transaction
18. Return summary: `{run_id, mode, N, N_effective, n_excluded, regime, top_3_signals, duration_ms}`

**Output:** structured summary consumed by `alpha_run` tool.

### 4.3 Linear algebra primitives — `alpha-linalg.ts`

All pure functions, no mutation of inputs.

- `dot(a, b)` → vector dot product
- `sampleMean(a)` → arithmetic mean
- `sampleVarianceBessel(a)` → `(1/(n-1)) Σ (x-mean)²`
- `timeMeanMatrix(M)` → per-row time average → length-N vector
- `scalarOlsNoIntercept(x, y)` → `{beta, residuals}` where `β = Σ(x·y)/Σ(x²)` and `residuals[i] = y[i] - β·x[i]`. Returns `β=0` if `Σx² ≤ ε`.
- `correlationMatrix(rows)` → N×N symmetric with `diag=1` over row time-series
- `maxOffDiagonal(corr)` → `{i, j, value}` for the largest-absolute-value off-diagonal entry
- `removeIndex(vec, idx)`, `removeRow(matrix, idx)` → exclusion helpers (pure, return new copies)
- `clamp(x, lo, hi)` → numeric clamp helper

Why this shape (deviation from addendum): Step 9's regression as originally specified (`N × (M-1)` multivariate) is underdetermined at F7 production sizes (N≈15, M-1=249). The math study's worked example uses M=2 which hides this. The correct multi-period generalization that matches the worked example at M=2 is a Fama-MacBeth-style single scalar β with `Λ_bar(i) = (1/(M-1)) Σ_s Λ(i,s)` as the single feature per signal. Numerically verified against the worked example (weights match addendum's to 0.004).

Correlation-based correlation-guard (see D-F) replaces the eigenvalue-based condition-number check. Max pair-correlation threshold 0.95. Max 3 exclusion iterations. Abort with `F7CorrelatedSignalsError` after 3.

---

## 5. Implementation order

Follows the 22-step cadence from `feedback_phase_beta_5sprint_day.md`, adapted for F7's solo depth.

1. **Plan doc review + operator approval** — this file.
2. **Schema migration SQL added to `src/db/schema.sql`**; applied live.
3. **`alpha-linalg.ts` + tests** — cleanest unit; scalar OLS verified against worked example, correlation matrix against hand-computed 3×3 fixture.
4. **`alpha-matrix.ts` + tests** — build R, test sparsity/direction/missing-close paths.
5. **`alpha-isq.ts` + tests** — 5 dimensions, clamp bounds.
6. **`alpha-combination.ts` core** — pipeline with no persistence yet. Unit-test each step against the 3×2 worked example from `06-f7-math-study.md`.
7. **Golden-file fixture** `f7-golden-3x10.json` — hand-computed 3 signals × 10 periods → expected weights at 1e-6 tolerance.
8. **Persistence wiring** — `signal_weights` + `signal_isq` transactional insert; IC filter + exclusion recording.
9. **Tool handlers** — `alpha_run` / `alpha_latest` / `alpha_explain`. Pre-formatted text output (per `feedback_preformat_over_prompt`).
10. **Integration checklist walkthrough** — 7 rows per tool × 3 tools = 21 touchpoints. See §7 below.
11. **`npm run typecheck`** → zero errors.
12. **`npx vitest run --reporter=dot`** → 2508 + ~60 new = ~2568+ tests, all green.
13. **qa-auditor subagent (round 1)** — expect algorithmic-bug findings per memory.
14. **Fix round-1 audit findings** — close Criticals; close load-bearing Warnings; defer Info with written rationale.
15. **qa-auditor subagent (round 2)** — verify round-1 fixes didn't introduce regressions, per `feedback_audit_iteration`.
16. **Fix round-2 findings (expected lower volume)**.
17. **Build + deploy** — `npm run build && systemctl restart mission-control`.
18. **Live smoke test** — call `alpha_run` via mc-ctl or direct tool invocation; verify `signal_weights` row count + non-null weights + `Σ|w|=1±1e-6`.
19. **Docs** — PROJECT-STATUS + V7-ROADMAP item marked Done + EVOLUTION-LOG entry + memory feedback file.
20. **Commit on `phase-beta/f7-alpha-combination` branch**; push; PR; merge to main.
21. **V7-ROADMAP master sequence** — mark S9 Done; sync metrics.
22. **Session wrap**.

---

## 6. Test strategy

### 6.1 Per-step unit tests (per `06-f7-math-study.md` §7)

| Step  | Test                   | Assertion                                  |
| ----- | ---------------------- | ------------------------------------------ |
| 2     | Serial demean          | `mean(X(i,·)) ≈ 0` for all i after demean  |
| 3     | Variance (M-1)         | `σ(i)²` matches hand calc within 1e-9      |
| 4     | Normalize              | `mean ≈ 0, std ≈ 1` for all i              |
| 5     | Drop most recent       | length goes M → M-1                        |
| 6     | Cross-sectional demean | `mean(Λ(·,s)) ≈ 0` for each period s       |
| 7     | Invariant              | assertion fires on length mismatch         |
| 8     | Momentum               | `E_norm(i)` correct for known lookback d=3 |
| 9     | OLS residuals          | `Σ ε(i) ≈ 0` (OLS property, no intercept)  |
| 10-11 | Weights                | `Σ \|w(i)\| = 1 ± 1e-6`                    |

### 6.2 Fragility tests

| Risk                | Test case                       | Expected behavior                                      |
| ------------------- | ------------------------------- | ------------------------------------------------------ |
| Zero σ              | Flat signal (constant returns)  | Excluded with `exclude_reason='flat_variance'`; no NaN |
| Singular regression | 3 signals with 99% correlation  | Exclusion-guard iteration; preserve highest-IC         |
| Hard singular       | 5 signals identical (collinear) | `F7SingularError` after 3 iterations; event logged     |
| NaN inputs          | Signal with NaN in firings      | Validation error; reject at runAlphaCombination entry  |
| Inf inputs          | Signal with ±1e308 return       | Clamp at matrix build; flag entry                      |
| Determinism         | Same inputs twice               | Identical weights (tolerance 0, deterministic)         |
| Empty input         | N = 0 signals                   | Structured empty response; no persistence              |
| Tiny input          | N = 1 signal                    | Pipeline short-circuit: weight = 1.0 if IC>0 else skip |
| Large N             | N = 50 signals synthetic        | Performance < 500ms; correctness                       |
| Horizon=5           | Weekly forward returns          | Matrix indexing correct; no off-by-five                |

### 6.3 Singularity-guard-specific tests

| Test                               | Expected                                         |
| ---------------------------------- | ------------------------------------------------ |
| 3 signals uncorrelated             | Happy path, no exclusion                         |
| 3 signals, 2 identical             | Exclude lower-IC of the pair; solve rest         |
| 5 signals all perfectly correlated | Abort after 3 iterations with `F7SingularError`  |
| Condition number ≈ 1e10 (boundary) | Just below passes; just above triggers exclusion |
| Exclusion preserves higher-IC      | Validates pair-selection deterministic rule      |

### 6.4 ISQ tests

Per addendum Part 4, 6 unit tests.

### 6.5 R(i,s) builder tests

Per addendum Part 1, 7 unit tests.

### 6.6 Golden-file end-to-end

`src/finance/__fixtures__/f7-golden-3x10.json` — 3 signals × 10 periods, hand-computed weights. Assert `Σ|w| = 1 ± 1e-6` and each weight matches expected to 1e-4 (tighter than 1e-6 because floating-point path is long).

### 6.7 Tool-layer tests (`alpha.test.ts`)

- `alpha_run` happy path — persists run, returns run_id
- `alpha_run` with empty signals window — structured empty response
- `alpha_run` with singular signal set — reports error in text output, events row written
- `alpha_latest` — returns most recent completed run
- `alpha_latest` with no runs — graceful empty response
- `alpha_explain` by run_id — per-signal breakdown including excluded signals
- `alpha_explain` unknown run_id — error
- `alpha_run` probability mode — NotImplementedError with clear message (v1 stub)

### 6.8 Test count budget

- alpha-linalg.test.ts: ~18 tests
- alpha-matrix.test.ts: ~9 tests
- alpha-isq.test.ts: ~7 tests
- alpha-combination.test.ts: ~20 tests (steps + fragility + golden)
- alpha.test.ts: ~10 tests

**Total: ~64 new tests.** Current baseline 2508 → target 2572+.

---

## 7. Integration checklist (per tool, 7 rows)

Applied to all 3 F7 tools.

| #   | Step                                                              | alpha_run            | alpha_latest | alpha_explain |
| --- | ----------------------------------------------------------------- | -------------------- | ------------ | ------------- |
| 1   | Handler in `src/tools/builtin/alpha.ts`                           | ✓                    | ✓            | ✓             |
| 2   | Registered in builtin source (`src/tools/sources/builtin.ts`)     | ✓                    | ✓            | ✓             |
| 3   | Added to `ALPHA_TOOLS` in `src/messaging/scope.ts`                | ✓                    | ✓            | ✓             |
| 4   | READ_ONLY classification (runner read/write policy)               | write (has write fx) | read         | read          |
| 5   | Rule 2b auto-persist — tool output persisted for follow-up turns  | ✓                    | ✓            | ✓             |
| 6   | WRITE_TOOLS (fast-runner.ts) + `write-tools-sync.test.ts` updated | ✓                    | —            | —             |
| 7   | Tests: handler unit + integration-mock scope-activation           | ✓                    | ✓            | ✓             |

---

## 8. Scope activation

New group `ALPHA_TOOLS = ["alpha_run", "alpha_latest", "alpha_explain"]`.

**Activation regex** (ES + EN, matching the pattern established by F3/F5/F6):

```typescript
// src/messaging/scope.ts
{
  name: "alpha",
  pattern:
    /\b(alpha[_ -]?(combination|run|explain|latest|engine)|megaalpha|mega[_ -]?alpha|signal[_ -]?weights?|combine[_ -]?signals?|pondera(?:ci[oó]n|r)[_ -]?se[nñ]ales|combinaci[oó]n[_ -]?alfa|pesos[_ -]?se[nñ]ales)\b/i,
  tools: ALPHA_TOOLS,
},
```

**Why these tokens**:

- `alpha_combination`, `alpha_run`, `megaalpha` — direct tool / concept match
- `signal_weights` — user asking about weights
- `combine signals`, `combinar señales`, `combinación alfa` — natural language ES+EN
- `ponderación de señales`, `pesos de señales` — ES operator vocabulary

**Negative tests** (should NOT activate):

- `"alpha version"`, `"alpha release"` — `\balpha\b` alone doesn't match (requires suffix)
- `"combinar"` without `señales` — no match
- `"weights"` alone — no match

**Positive tests**:

- `"run the alpha combination"` ✓
- `"¿Cuáles son los pesos de las señales?"` ✓
- `"show me megaalpha"` ✓
- `"ponderación de señales ahora"` ✓

---

## 9. Tool descriptions (per ACI principles)

Following `feedback_aci_workflows`: descriptions teach the model the multi-step workflow.

### alpha_run

```
Run the F7 alpha combination engine — executes the 11-step pipeline over
the last 250 trading days of market_signals + sentiment_readings,
produces weighted signal combination, persists run to signal_weights +
signal_isq tables.

USE WHEN:
- User asks for combined signal / megaalpha / weights for today
- F8 paper-trade loop needs fresh weights before sizing
- F9 scan ritual invokes this nightly

NOT WHEN:
- User just wants to see last run's weights (use alpha_latest)
- User wants per-signal diagnostic (use alpha_explain <run_id>)

PIPELINE (high level):
  IC filter → build return matrix → Steps 1-11 FLAM pipeline → ISQ →
  persist to signal_weights + signal_isq with unique run_id.

Returns a run summary: run_id, N, N_effective, regime, top-3 signals by
|weight|, duration.

Can take 1-3 seconds. Safe to retry (new run_id each time; append-only).
```

### alpha_latest

```
Return the most recent completed alpha run's weights + N_effective +
regime. Read-only, no side effects. Use this for F8 / F9 / user queries
asking "what does the system think right now."

NOT WHEN:
- You want to force a fresh run (use alpha_run)

Returns pre-formatted text: run_id, timestamp, N signals (of which M
excluded), regime, ranked weights (|w| desc), N_effective.

Latency: <50ms (single indexed SELECT).
```

### alpha_explain

```
Given a run_id (or default: latest), returns the full per-signal
breakdown: weight, epsilon (residual edge), sigma (volatility), E_norm
(forward return normalized), IC_30d, ISQ dimensions, and — for excluded
signals — the exclusion reason.

USE WHEN:
- "Why is signal X weighted at 0?"
- Audit a specific past run
- Debugging unexpected weight distribution

Returns a table-formatted breakdown, one row per signal.
```

---

## 10. Risks & mitigations

| Risk                                                           | Mitigation                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| R(i,s) construction is subtle — off-by-one on horizon          | Unit tests: horizon=1 (default), horizon=5 (weekly), last-period clamp                            |
| IC filter drops too aggressively (fresh signals with noisy IC) | 30-firing admittance window (addendum Part 8.4); log exclusion rate per run                       |
| Jacobi eigenvalue convergence slow for near-singular           | Max 100 sweeps hard cap + fall back to correlation-matrix exclusion (skip cond# if Jacobi slow)   |
| Cholesky fails on numerically-singular PSD matrix              | Exception caught → falls through to exclusion loop; same abort semantics after 3 iterations       |
| Golden file drift when minor math change lands                 | `f7-golden-3x10.json` is version-pinned; any diff requires explicit user approval + doc update    |
| Probability mode stub confuses consumers                       | Clear `NotImplementedError` message; separate `alpha_run_probability` tool deferred as v1.1       |
| 2 audit passes eat session time                                | Budgeted in implementation order; `feedback_audit_iteration` says don't short-circuit             |
| Symbol-normalization divergence across F1/F3/F6.5 inputs       | Use same `normalizeSymbol()` helper in alpha-matrix.ts that F1 uses at adapter boundary           |
| Zero firings in window (fresh deploy, no history)              | Short-circuit with structured empty response; alpha_run returns `N=0`, no rows persisted          |
| Market closed (weekend) + asOf = today → M periods underfilled | `asOf` resolves to last completed trading day via existing F1 calendar helpers; test weekend case |

---

## 11. Acceptance criteria

F7 ships when all the following pass:

### Functional

- [ ] `alpha_run` executes pipeline end-to-end, persists to `signal_weights` + `signal_isq`, returns summary
- [ ] `alpha_latest` returns most recent run
- [ ] `alpha_explain` returns per-signal breakdown
- [ ] Probability mode stub returns `NotImplementedError` cleanly
- [ ] IC filter drops ic≤0 signals, admits fresh (<30 firing) signals
- [ ] Singularity guard excludes iteratively, aborts after 3 iterations
- [ ] Weights sum: `Σ|w| = 1 ± 1e-6`
- [ ] N_effective computed and stored

### Testing

- [ ] ~64 new tests added, all passing
- [ ] Golden-file fixture matches hand-computed weights to 1e-4
- [ ] Full suite `npx vitest run --reporter=dot` green (≥2568)
- [ ] `npx tsc --noEmit` zero errors

### Schema

- [ ] `signal_weights` table created, append-only
- [ ] `signal_isq` table created
- [ ] Both tables indexed for read-by-run_id + read-by-signal paths
- [ ] Live migration applied to production SQLite without reset

### Integration

- [ ] 3 tools registered in builtin source
- [ ] All 3 in `ALPHA_TOOLS` scope group
- [ ] Scope regex activates on positive cases, rejects negatives
- [ ] `alpha_run` in WRITE_TOOLS + write-tools-sync passes
- [ ] Rule 2b auto-persist wired for all 3

### QA

- [ ] qa-auditor round 1 run; all Critical findings resolved
- [ ] qa-auditor round 2 run; verify round-1 didn't introduce regressions
- [ ] All deferred items have explicit justification

### Deploy

- [ ] `npm run build` succeeds
- [ ] `systemctl restart mission-control` → active
- [ ] Live smoke: `alpha_run` invocation against real `market_signals` data produces a `signal_weights` row with non-null weights summing to 1

### Docs

- [ ] `docs/PROJECT-STATUS.md` — session entry with metrics
- [ ] `docs/V7-ROADMAP.md` — S9 (F7) marked Done
- [ ] `docs/EVOLUTION-LOG.md` — Day entry with ≥5 lessons
- [ ] `memory/feedback_f7_alpha_combination.md` — durable learning file
- [ ] `memory/MEMORY.md` — index updated

---

## 12. Open items (carried into implementation)

These are _not_ blockers. They're tracked so F7's follow-up sprints know where to start.

1. **Probability-mode input parser** — F6 (prediction markets) stores market snapshots, not probability time-series. A separate F6.5.x sprint is needed to persist `(market_id, timestamp, implied_probability)` rows before F7 probability mode becomes useful. Stub exists; consumer deferred.

2. **Doc fixes in `V7-ALPHA-COMBINATION-EQUATIONS.md`** — Step 3 prose (`1/M` → `1/(M-1)`) and Step 5 prose (retain M-1 not M). Single commit after F7 ships; low priority.

3. **N_effective definition** — the spec mentions `N_effective ≤ N_total` but doesn't give a formula. F7 v1 uses `1 / Σw²` (sum-of-squared-weights heuristic, common in portfolio theory). Alternative is PCA-based (keep components for 95% variance). Lock v1 to the former; flag for F7.5 if the backtester wants finer-grained accounting.

4. **Regime branching** — `regime` logged but not consumed. Once ≥30 runs per regime exist, decide between per-regime pipelines vs down-weighting vs exclusion (addendum Part 7).

5. **F9 ritual wiring** — S12 (F9) will call `alpha_run` as part of morning scan + `alpha_latest` as part of EOD review. Not F7's work.

6. **Performance budget** — N=20, M=250 pipeline should run in <500ms. If that degrades as N grows with new signal detectors, revisit with profiling.

---

## 13. Rollback plan

If F7 deploys and live smoke fails:

1. `systemctl stop mission-control`
2. `git checkout main && npm run build && systemctl start mission-control`
3. Tool set reverts to pre-F7 state; `signal_weights` + `signal_isq` tables remain (additive, no harm)
4. Inspect `events` table for `F7SingularError` or unexpected errors
5. File incident memory; patch on branch; retry

No data-loss risk: all F7 writes are to new tables. Existing F1–F6.5 tables untouched.

---

## Summary

F7 is the translation of a locked-down 11-step FLAM pipeline into TypeScript + SQLite persistence + 3 tools + 2 new tables. Addendum Part 1–8 resolve the 7 math-level ambiguities; this plan adds 3 more session-execution locks (signal identity, file layout, tool surface).

Estimated effort: **~1.85 sessions** (addendum estimate), shipped in one session solo per the 5-sprint-day feedback: _"F7 shouldn't bundle. No companion sprint."_

Ready for operator approval → ship.
