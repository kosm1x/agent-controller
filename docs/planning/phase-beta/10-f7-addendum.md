# F7 Alpha Combination Engine — Pre-Plan Addendum

> **Exploration follow-up:** A-2 (from item A's recommendations in `06-f7-math-study.md`)
> **Run date:** 2026-04-14 session 67 wrap+4
> **Source:** Direct re-read of `docs/V7-ALPHA-COMBINATION-EQUATIONS.md` (authoritative) alongside item A's math study
> **Purpose:** Lock down the 7 underspecified items flagged in item A so F7 is a translation task, not an invention task, when the session starts. Plus 4 new findings from re-reading the spec directly instead of relying on the agent's second-hand summary.

---

## Headline

Seven items were flagged as underspecified in item A. **Six are now locked.** One (Kelly sizing) turns out to belong in F8 (paper trading), not F7 — a scope clarification that reduces F7's surface. Additionally, the direct re-read of the equations doc surfaced **4 new findings** the agent's summary missed:

1. **Variance formula inconsistency in the spec itself.** Formal equation (2) uses `(M-1)` Bessel's correction; Step 3 of the 11-step prose uses `M`. Addendum picks `(M-1)` per the academic formulation.
2. **Step 5 prose is a typo.** Says "retain first M periods" but the formal equation (4) has `s = 1..M-1`. Step 5 drops one observation. Step 7 is a sanity-check no-op. Off-by-one ambiguity from item A is now resolved.
3. **Prediction-market mode is a first-class pipeline.** Spec Section "Prediction Market Application" shows the same 11 steps applied to probabilities instead of returns. F7 must support both modes — this is a scope expansion the roadmap didn't capture.
4. **IC filter rule is already specified.** Implementation Notes say "Signals with IC ≤ 0 are dropped, rolling 30-day window." This is the signal-exclusion rule F7 must implement before the 11-step pipeline runs. Not part of the 11 steps, but required pre-processing.

**Net F7 scope impact:** +0.1 session for the addendum's new locked decisions, -0.3 session for Kelly moving to F8, +0.2 session for the prediction-market mode. Net: **F7 stays at ~2 sessions.** The addendum reshapes scope without bloating it.

---

## Part 1 — R(i,s) construction (the critical blocker)

### The problem

Item A flagged this as "the most load-bearing gap in the spec." The equations assume a 2D return matrix `R(signal_index, period)`, but the doc does NOT define how to construct this matrix from our upstream tables (`signals` from F3, `market_data` from F1).

The implementation notes in the doc say: _"Signal return series — stored in market_data table, computed per signal per period."_ That's still a description, not an algorithm.

### The decision

**`R(i,s)` is computed by a dedicated pre-processing function `buildReturnMatrix()` that runs BEFORE the 11-step pipeline.** Inputs: `signals[]` from F3, `market_data[]` from F1. Output: `{ R, symbols, periodTimestamps, signalIds }` where `R` is a flat `Float64Array` of length `N × M` indexed by `R[i * M + s]`.

### The algorithm

For each signal `i` and each period `s` within a rolling window of M periods:

```
R(i, s) = forward_realized_return(symbol_i, period_s)
        = close(symbol_i, s + horizon) / close(symbol_i, s) - 1

where:
  - symbol_i = the symbol the signal fired on
  - horizon  = forward lookahead in bars (1 for daily, configurable)
  - if signal i did NOT fire in period s: R(i, s) = 0 (neutral)
  - if signal i fired but direction=short: negate the realized return
  - if close price is missing for either period: R(i, s) = 0 + flag
```

**Rationale:**

1. **`R(i, s) = 0` for non-firing periods** matches the "honest zero" approach — a non-firing signal has no information, not a negative bet. Alternative interpretations (e.g., `R = last_close_return`) would leak cross-signal information into what's supposed to be per-signal performance.

2. **Negating for short signals** keeps the sign convention consistent: positive R means the signal was right. Step 9's regression residuals measure "forward-looking edge" which is direction-agnostic at the weight stage.

3. **Fixed `horizon = 1` for F7 v1.** Every signal is scored against the next bar's return regardless of when it fired. Per-signal optimized `d` (mentioned in the Momentum section) is a future enhancement — F7 v1 uses a single horizon. Tracked as open item.

4. **Flagging missing closes** instead of silently zeroing means `api_call_budget.status='error'` can detect data-quality issues that would poison F7's weight calculation. If >5% of a signal's R(i, s) entries are flagged, drop the signal from that run's pipeline and log a warning.

### Pseudocode

```typescript
// src/finance/f7/build-return-matrix.ts (F7 session)

export interface ReturnMatrixInput {
  signals: SignalRow[]; // from signals table, ordered by signal_id
  marketData: MarketBar[]; // from market_data table, daily bars
  periods: string[]; // ISO date strings, the M trailing periods
  horizon: number; // forward lookahead, default 1
}

export interface ReturnMatrixResult {
  R: Float64Array; // flat N*M, indexed R[i*M + s]
  N: number;
  M: number;
  signalIds: number[];
  flags: Array<{ i: number; s: number; reason: string }>;
}

export function buildReturnMatrix(
  input: ReturnMatrixInput,
): ReturnMatrixResult {
  const uniqueSignalIds = Array.from(
    new Set(input.signals.map((s) => s.signal_id)),
  ).sort();
  const N = uniqueSignalIds.length;
  const M = input.periods.length;
  const R = new Float64Array(N * M);
  const flags: Array<{ i: number; s: number; reason: string }> = [];

  // Index market data by symbol + period for O(1) lookup
  const closeBySymbolPeriod = new Map<string, number>();
  for (const bar of input.marketData) {
    closeBySymbolPeriod.set(
      `${bar.symbol}:${bar.timestamp.slice(0, 10)}`,
      bar.close,
    );
  }

  for (let i = 0; i < N; i++) {
    const signalId = uniqueSignalIds[i]!;
    const signalFirings = input.signals.filter((s) => s.signal_id === signalId);
    const firingByPeriod = new Map<string, SignalRow>();
    for (const firing of signalFirings) {
      const day = firing.triggered_at.slice(0, 10);
      firingByPeriod.set(day, firing);
    }

    for (let s = 0; s < M; s++) {
      const period = input.periods[s]!;
      const firing = firingByPeriod.get(period);
      if (!firing) {
        R[i * M + s] = 0; // neutral for non-firing
        continue;
      }

      const forwardIdx = Math.min(s + input.horizon, M - 1);
      const forwardPeriod = input.periods[forwardIdx]!;
      const closeNow = closeBySymbolPeriod.get(`${firing.symbol}:${period}`);
      const closeFwd = closeBySymbolPeriod.get(
        `${firing.symbol}:${forwardPeriod}`,
      );

      if (closeNow == null || closeFwd == null) {
        R[i * M + s] = 0;
        flags.push({ i, s, reason: "missing_close" });
        continue;
      }

      let ret = closeFwd / closeNow - 1;
      if (firing.direction === "short") ret = -ret;
      R[i * M + s] = ret;
    }
  }

  // If >5% of entries for any signal are flagged, the caller should exclude that signal
  return { R, N, M, signalIds: uniqueSignalIds, flags };
}
```

### Test coverage

| Test                                     | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| 3 signals × 5 periods, all fire          | Happy path, non-zero R matrix                             |
| Signal fires only in half the periods    | Neutral zeros for non-firing periods                      |
| Long vs short direction                  | Short signals have negated returns                        |
| Missing forward close                    | Flag but zero, not NaN                                    |
| Signal fires at period M-1 (last period) | Forward lookup clamps to `M-1`, flags zero forward return |
| Signal with >5% flagged entries          | Caller exclusion test (validates the warning path)        |
| Horizon=5 (weekly)                       | Forward index computation correct                         |

---

## Part 2 — Window sizes M and d

### The problem

The spec never pins M (historical observation count) or d (forward estimation horizon). Item A suggested defaults but didn't commit.

### The decision

**M = 250 business days (1 year of daily data). d = 20 business days (1 month forward lookback, matching the IC tracking window in Implementation Notes).**

Both are F7 config constants, overridable via `config.f7.windowM` and `config.f7.windowD`. Not exposed to tools — operator can override via env var if needed.

### Rationale

1. **M = 250** is the standard "one year of trading days" used across institutional quant infrastructure. Enough history to compute reliable `σ(i)` for signals that fire regularly. Shorter windows (e.g., M=63 for one quarter) give unstable weights; longer windows (M=500+) make the weight distribution slow to adapt to regime changes.

2. **d = 20** matches the "rolling 30-day IC tracking" the doc already specifies in Implementation Notes. Using a coherent window across both the E(i) computation and the IC filter avoids split-brain behavior.

3. **Both configurable** so F7.5 backtester can run walk-forward with different M/d to measure sensitivity. Golden-file tests pin specific values.

### Open question

Whether **d should be per-signal** (as hinted by the Momentum section: _"Parameter d (lookback) optimized independently per signal"_). **Decision for F7 v1: single global d.** Per-signal d is a future enhancement that requires a separate optimization loop and more test surface. Log the signal-level IC over different d values but don't act on it yet.

---

## Part 3 — Weight versioning schema

### The problem

F8 and F9 will read weights produced by F7. If F7 overwrites weights each run, we can't audit historical decisions or A/B test alternative weight configs. Item A flagged this as "Medium risk, High blast radius — stale weights could silently break F8/F9."

### The decision

**New table `signal_weights` shipped in F1 (since F1 owns the schema) but populated by F7.** Append-only, immutable, timestamped per run.

```sql
CREATE TABLE IF NOT EXISTS signal_weights (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,                  -- UUID generated per F7 run
  run_timestamp   TEXT NOT NULL,                  -- ISO 8601 NY time
  mode            TEXT NOT NULL CHECK(mode IN ('returns','probability')),
  signal_id       INTEGER NOT NULL,               -- signals table FK (NOT enforced, signals table may rotate)
  signal_name     TEXT NOT NULL,                  -- snapshot of signal_type at run time for audit
  weight          REAL NOT NULL,                  -- w(i) from Step 10
  epsilon         REAL NOT NULL,                  -- residual ε(i) from Step 9
  sigma           REAL NOT NULL,                  -- σ(i) from Step 3
  e_norm          REAL NOT NULL,                  -- normalized forward return from Step 8
  ic_30d          REAL,                           -- 30-day IC snapshot (nullable if <30 firings)
  regime          TEXT,                           -- F5 regime label at run time (bull/bear/volatile/calm)
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  exclude_reason  TEXT,                           -- 'low_ic', 'flat_variance', 'missing_data', etc.
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_weights_run ON signal_weights(run_id);
CREATE INDEX IF NOT EXISTS idx_weights_time ON signal_weights(run_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_weights_signal ON signal_weights(signal_id, run_timestamp DESC);
```

**F1 adds this table to its schema migration.** F7 populates it. F8 reads it by `run_id` (not by "latest"). F9 rituals pick the most-recent-completed `run_id` at scan time.

### Rationale

1. **Append-only** → full audit trail. Can replay any past run's weights against any past signal state.
2. **`mode` column** supports both returns and probability pipelines (see Part 8 — prediction market application).
3. **`regime` column** captures the macro regime at run time so future F7.x can condition on it without schema migration.
4. **`excluded` column** captures signals that were filtered OUT by the IC filter or variance check. Gives visibility into why a signal wasn't in the weighted set.
5. **Read-by-run-id** (not "latest") eliminates the race condition where F7 is mid-run and F8 reads half-written weights.

### Test coverage

| Test                          | Purpose                                  |
| ----------------------------- | ---------------------------------------- |
| Insert a run with 10 signals  | Schema accepts valid shape               |
| Query by run_id               | Index performance + correctness          |
| Append 3 runs for same signal | Per-signal history query returns 3 rows  |
| Exclude a signal              | `excluded=1` + `exclude_reason` non-null |
| Mode='probability'            | CHECK constraint enforces valid values   |

---

## Part 4 — ISQ (Ingredient Signal Quality) dimensions

### The problem

The V7 roadmap lists "ISQ dimensions" as an F7 work item but the equations doc doesn't define them. Item A proposed a 5-dimension shape but didn't lock it.

### The decision

**5 dimensions, computed per signal per run, stored in a parallel `signal_isq` table (NOT in `signal_weights` — they have different cardinality).** Each ISQ dimension is a float 0-1 where 1 is best and 0 is worst.

```sql
CREATE TABLE IF NOT EXISTS signal_isq (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,                  -- FK to signal_weights.run_id (logical)
  signal_id       INTEGER NOT NULL,
  efficiency      REAL NOT NULL,                  -- 0-1
  timeliness      REAL NOT NULL,                  -- 0-1
  coverage        REAL NOT NULL,                  -- 0-1
  stability       REAL NOT NULL,                  -- 0-1
  forward_ic      REAL NOT NULL,                  -- 0-1 (clamped, raw IC can be ±)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_isq_run ON signal_isq(run_id, signal_id);
```

### Dimension definitions

| Dimension      | Formula                                                             | Meaning                                                                                                       |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **efficiency** | `min(1, abs(w_raw) / sum_abs_epsilon)`                              | How much of the idiosyncratic edge survived normalization — proxy for how distinct this signal is from others |
| **timeliness** | `1.0 if fired_today else 0.5`                                       | Freshness — penalizes stale signals that haven't fired in the current period                                  |
| **coverage**   | `n_symbols_fired / n_watchlist_symbols`                             | Breadth — what fraction of the watchlist the signal covers                                                    |
| **stability**  | `1 - clamp(rolling_ic_std / max(abs(rolling_ic_mean), 0.01), 0, 1)` | IC consistency — low variance / high mean is stable                                                           |
| **forward_ic** | `clamp((rolling_ic_30d + 0.15) / 0.30, 0, 1)`                       | 30-day IC remapped from `[-0.15, +0.15]` → `[0, 1]`                                                           |

### Rationale

1. **Separate table** because ISQ is computed per-run per-signal, independently of whether the signal was included in the weighted set. Keeps `signal_weights` lean for the primary F7→F8 read path.

2. **Pre-normalized [0, 1]** so a future "composite ISQ score" can be a simple mean. No unit mismatch.

3. **`forward_ic` clamp window `[-0.15, +0.15]`** reflects the doc's stated range for institutional IC values ("typically 0.05-0.15"). A signal with IC > 0.15 caps at 1.0; a signal with IC < -0.15 caps at 0.0 (but is dropped by the IC filter anyway).

4. **No composite score at F7 v1** — each dimension is stored independently. F7.5 backtester or a future monitoring layer can compute composites for dashboards. F7 itself doesn't branch on ISQ.

### Test coverage

| Test                                                           | Purpose             |
| -------------------------------------------------------------- | ------------------- |
| Compute ISQ for 3 signals, known inputs                        | Formula correctness |
| `timeliness` = 0.5 when last fired yesterday                   | Freshness penalty   |
| `coverage` = 1.0 when signal fires on all 20 watchlist symbols | Breadth math        |
| `forward_ic` = 0.5 at IC=0                                     | Remap midpoint      |
| `forward_ic` = 1.0 at IC≥0.15                                  | Clamp high          |
| `forward_ic` = 0.0 at IC≤-0.15                                 | Clamp low           |

---

## Part 5 — Regression singularity handling

### The problem

Step 9 solves an OLS regression that can go singular if signals are too correlated. Item A flagged this as a real risk: "15 signals submitted, 13 are linear combinations of 2, regression produces unreliable ε values."

### The decision

**Compute the condition number of `ΛᵀΛ` before solving. If > 1e10, warn and exclude the most-correlated signal; retry.** Maximum 3 exclusion iterations; if still singular, abort the run with a structured error and log to events.

### Algorithm

```typescript
// Pseudo-code for Step 9 singularity guard
const COND_THRESHOLD = 1e10;
const MAX_ITERATIONS = 3;

function solveWithSingularityGuard(lambdaMatrix, eNorm): Step9Result {
  let matrix = lambdaMatrix;
  let eNormVec = eNorm;
  let excluded: number[] = [];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const gramian = transpose(matrix).multiply(matrix);
    const cond = conditionNumber(gramian);
    if (cond < COND_THRESHOLD) {
      // Safe — solve and return
      return { residuals: ols(matrix, eNormVec), excluded };
    }

    // Find most-correlated pair, exclude the one with weaker forward IC
    const corrMatrix = correlationMatrix(matrix);
    const worstPair = findHighestOffDiagonal(corrMatrix);
    const toExclude =
      worstPair.ic_i < worstPair.ic_j ? worstPair.i : worstPair.j;
    excluded.push(toExclude);
    matrix = removeRow(matrix, toExclude);
    eNormVec = removeEntry(eNormVec, toExclude);
  }

  // Still singular after 3 exclusions — abort
  throw new F7SingularError(
    `Step 9 regression remained singular after excluding ${excluded.length} signals`,
    { excluded, finalCond: cond },
  );
}
```

### Rationale

1. **Condition number 1e10** is a standard numerical-stability threshold. Beyond this, the inverse is dominated by noise and β is meaningless.
2. **Exclude the weaker-IC signal** of a correlated pair rather than randomly dropping one — preserves the more informative signal. Ties broken by lower signal_id (deterministic).
3. **Max 3 iterations** prevents infinite loops while giving the guard enough room to converge on a reasonable subset.
4. **Abort with structured error** (not silent fallback) because if the pipeline can't solve, we should NOT ship weights — stale weights from the prior run are safer than made-up weights from a degenerate regression.
5. **Log to events table** so the operator can see "F7 run N aborted due to signal correlation" in the dashboard without digging through logs.

### Alternative considered

PCA truncation (keep components explaining 95% variance). **Rejected for F7 v1** because it changes the interpretation of ε(i) — residuals become residuals against the principal components, not against the original Λ matrix. Harder to explain and harder to audit. PCA is a good F7.5 enhancement if the exclusion-based guard produces too many aborts in practice.

### Test coverage

| Test                                | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| 3 signals, uncorrelated             | Happy path, no exclusion                                 |
| 3 signals, 2 identical              | Exclude one of the identical pair, solve rest            |
| 5 signals, all perfectly correlated | Abort after 3 iterations with F7SingularError            |
| Condition number exactly 1e10       | Boundary (just below threshold passes, just above fails) |
| Exclusion preserves higher IC       | Validates which of a pair is excluded                    |

---

## Part 6 — Step 5 vs Step 7 off-by-one (resolved)

### The problem

Item A flagged ambiguity: Steps 5 and 7 both say "drop," but it's unclear if they're sequential drops (M → M-1 → M-2) or the same drop described twice (M → M-1, M-1 → M-1).

### The resolution

**Reading the authoritative spec directly, not the agent summary:**

- Step 5 prose: _"Retain only first M periods in Y(i,s). Prevents look-ahead bias."_
- Formal equation (4): `A(i,s) = Y(i,s), s = 1,2,...,M−1`

**Step 5's prose says "first M periods" but the formal equation has `s = 1..M-1` — that's M-1 periods.** This is a **typo in the doc**. The formal equation is authoritative. Step 5 drops one observation.

- Step 7 prose: _"Retain M−1 periods in Λ(i,s). Final data hygiene against residual look-ahead."_
- Formal equation (6): `Λ(i,s), s = 1,2,...,M−1`

**Step 7's formal equation is identical to Step 5's — still M-1 periods.** This means Step 7 is a **sanity check, not an additional drop.** It asserts that the cross-sectional demean didn't accidentally reintroduce an observation.

### The decision

**Step 5 drops 1 observation (M → M-1). Step 7 is a no-op assertion that M-1 periods remain.** Implement as:

```typescript
// Step 5
const YTruncated = Y.slice(0, M - 1); // drop the most recent observation

// ... Step 6 (cross-sectional demean) happens on M-1 periods ...

// Step 7
assert(
  Lambda.length === M - 1,
  "Step 7 invariant violated: M-1 periods expected",
);
```

### Follow-up

**File a doc fix in `V7-ALPHA-COMBINATION-EQUATIONS.md` after F7 ships.** The Step 5 prose ("first M periods") should be "first M-1 periods" to match formal equation (4). Low priority — doesn't block implementation now that the interpretation is locked.

---

## Part 7 — Regime-conditional IC tracking

### The problem

Item A's recommendation: "F5 provides regime labels; F7 can log them alongside weights without yet conditioning on them. The conditioning can land as a post-launch enhancement once we have enough regime-diverse data."

### The decision (confirmed)

**F7 logs the regime label at run time in `signal_weights.regime` (already specified in Part 3 schema).** Does NOT branch on it. No regime-specific math in F7 v1.

### Post-launch enhancement path

After ~30 runs per regime (≈4-6 weeks of daily scans given that regimes shift slowly), compute per-regime IC as a separate monitoring query. If signals show significantly different IC across regimes (e.g., a trend-following signal that works in bull but fails in bear), the operator can decide whether to:

1. **Run two F7 pipelines**, one per regime class, producing mode-specific weights
2. **Down-weight by regime prior**, multiplying each signal's weight by its regime-conditional IC before normalization
3. **Exclude by regime**, dropping signals whose IC in the current regime < 0

This is explicitly NOT in F7 v1. The `regime` column is forward-compatible for all three options.

---

## Part 8 — New findings from direct spec re-read

Four findings the agent's second-hand summary missed that materially affect F7 scope.

### 8.1 — Variance formula inconsistency (M vs M-1)

The spec has two formulas for σ:

- **Formal equation (2):** `σ(i) = √[(1/(M-1)) × Σ X(i,s)²]` — Bessel's correction, unbiased sample variance
- **Step 3 prose:** `σ(i)² = (1/M) × Σ X(i,s)²` — population variance

**Decision: use (M-1) per the formal equation.** The formal equations are the authoritative source; the 11-step prose is explanatory. The Bessel-corrected estimator is the right choice for finite-sample statistics anyway.

**Numerical difference is tiny at M=250:** `(1/250) vs (1/249) = 0.4% relative difference in σ`. Doesn't change the qualitative behavior but could shift weights at the margin. Lock to (M-1) for determinism across F7 versions.

**Follow-up doc fix:** update Step 3 prose in `V7-ALPHA-COMBINATION-EQUATIONS.md` to use `(M-1)`, bundled with the Part 6 doc fix.

### 8.2 — Prediction-market mode is a first-class pipeline

The spec has a full section titled **"Prediction Market Application"** (lines 257-269 of the equations doc) that applies the same 11 steps to **probabilities instead of returns**:

| Signal                 | Produces                                         |
| ---------------------- | ------------------------------------------------ |
| Cross-venue pricing    | Implied probability from PM spread vs offshore   |
| Historical calibration | Probability from resolution rates                |
| Bayesian update        | Probability from new evidence                    |
| Microstructure (VPIN)  | Probability from informed order flow             |
| Momentum               | Probability from price direction near resolution |

Run through Steps 1-11 → single combined probability → gap vs market price = edge → empirical Kelly sizing.

**The roadmap entry for F7 doesn't mention prediction-market mode.** The v7 spec treats F7 as purely equity-return combination. This is a real scope ambiguity.

**Decision: F7 v1 implements BOTH modes as a single parameterized pipeline.** The 11 steps are identical; only the input semantics differ. A `mode: "returns" | "probability"` parameter selects which input channel to read from. Both modes write to `signal_weights` with the `mode` column set accordingly.

**Why both modes matter for F6 + F8:**

- F6 (Prediction Markets + Whale Tracker) produces probability signals
- F8 (Paper Trading via pm-trader MCP) needs combined probabilities to size trades on Polymarket
- Without probability-mode F7, F8 has to invent its own combination logic or skip multi-signal integration

**Scope impact:** +0.2 session for the probability mode (identical math, new input parser + test set).

### 8.3 — Kelly sizing belongs in F8, not F7

The spec has a "Position Sizing: Empirical Kelly" section immediately after the 11-step combination engine. Reading it carefully:

```
f_kelly = (p × b − q) / b
f_empirical = f_kelly × (1 − CV_edge)
```

**This is a trade-sizing rule, not a combination rule.** It takes the output of F7 (combined probability/edge) and converts it into a position size. That's the F8 (paper trading) layer — the part that decides "buy 500 shares" vs "buy 5000 shares."

**Decision: Kelly sizing moves to F8.** F7 produces `MegaAlpha(t)` and stops. F8 reads `MegaAlpha(t)` + current mid price and computes `f_kelly` + `f_empirical` for position sizing.

**Rationale:**

1. Kelly sizing depends on `b` (odds/payout ratio) which is a **market-pricing** input, not a signal input. F7 doesn't read prices; it reads signal returns.
2. `CV_edge` requires **Monte Carlo simulation over historical paths** (10K simulations per scan per symbol). That's a compute-heavy task that belongs in F8 or F7.5, not in the per-scan F7 pipeline.
3. Separating combination (F7) from sizing (F8) makes both testable in isolation. A bug in Kelly doesn't corrupt weights; a bug in weights doesn't poison sizing.

**Scope impact:** -0.3 session from F7 (Kelly is ~0.3 session of work that moves to F8). F7 net: still ~2 sessions after the other additions.

### 8.4 — IC filter rule is already specified

The spec's Implementation Notes say:

> **IC tracking** — measure actual IC per signal over rolling 30-day window. Signals with IC ≤ 0 are dropped

This is an **exclusion rule that runs BEFORE the 11-step pipeline.** F7 must:

1. Read rolling 30-day IC per signal from `signal_isq.forward_ic` (or compute it fresh if the run_id doesn't exist yet)
2. Exclude any signal with IC ≤ 0
3. Log the exclusion in `signal_weights.excluded=1` with `exclude_reason='ic_le_zero'`

**Decision: adopt as-is.** Simple rule, clear outcome. Signals that have consistently missed (negative IC = the signal predicted up and the market went down on average) are not just weak — they're anti-informative. Dropping them cleanly is better than feeding noise into Step 9's regression.

**Edge case:** Fresh signals (less than 30 firings in the window) don't have enough data to compute IC reliably. **Decision: admit them with `ic_30d = null` for the first 30 days, then apply the filter.** This is the "benefit of the doubt" window — gives new signals time to accumulate enough history to be judged.

**Follow-up:** track how many signals get excluded per run in F9 rituals. If >50% exclusion rate persists, something is wrong (maybe the IC computation is buggy, or the watchlist is too small for statistical reliability).

---

## Part 9 — F7 session impact

### Revised time estimate

| Component                         | Original (item A) | Revised (post-addendum) |
| --------------------------------- | ----------------- | ----------------------- |
| Core 11-step pipeline             | 1.5 sessions      | 1.5 sessions            |
| R(i,s) construction (Part 1)      | —                 | +0.1 (now specified)    |
| Weight versioning schema (Part 3) | —                 | +0.1 (ships in F1)      |
| ISQ table + computation (Part 4)  | —                 | +0.15                   |
| Singularity guard (Part 5)        | —                 | +0.1                    |
| Probability mode (Part 8.2)       | —                 | +0.2                    |
| Kelly sizing moves to F8          | -0.3              | -0.3                    |
| **Net**                           | **2.0 sess**      | **~1.85 sess**          |

**F7 now estimates at ~1.85 sessions**, _lower_ than the 2.0 original. The addendum's scope clarifications (Kelly → F8) more than offset the new locked-in items.

### Impact on other sessions

- **F1:** +0.1 session for `signal_weights` + `signal_isq` tables in the schema migration. F1's pre-plan already has 6 tables; adding 2 more is a minor DDL addition. F1 estimate 1.85 → **1.95 sessions**.
- **F8:** +0.3 session for the Kelly sizing that moved out of F7. F8 estimate 1.5 → **1.8 sessions**.
- **Phase β total:** 11.4 sequential → **11.5 sequential** (+0.1). ~9 parallelized → **~9.1 parallelized**.

The addendum doesn't bloat Phase β — it just reallocates work.

### F7 session implementation order (revised)

1. Read `R(i,s)` construction helper (Part 1) — **30 min**
2. Implement Steps 1-4 (collect → demean → variance → normalize) — **30 min**
3. Implement Steps 5-7 (truncate → cross-sectional demean → assert) — **20 min**
4. Implement Step 8 (forward expected return + normalize) — **20 min**
5. Implement Step 9 with singularity guard (Part 5) — **60 min** (the hardest piece)
6. Implement Steps 10-11 (weight + normalize) — **20 min**
7. Implement ISQ computation (Part 4) — **40 min**
8. Write `signal_weights` + `signal_isq` insertion code — **20 min**
9. Add `mode: returns | probability` parameter + probability-mode input parser (Part 8.2) — **40 min**
10. Write unit tests per the addendum's test coverage matrices (~35 tests total) — **90 min**
11. Write end-to-end golden-file test (3 signals × 10 periods, known output) — **30 min**
12. Live smoke test + commit — **30 min**

**Total: ~7 hours focused work ≈ 1.85 sessions** (matches the estimate).

---

## Part 10 — Acceptance criteria for F7 session

When F7 ships, it's done if:

### Part 1 — R(i,s) construction

- [ ] `buildReturnMatrix()` exists in `src/finance/f7/build-return-matrix.ts`
- [ ] Returns `{R, N, M, signalIds, flags}` shape
- [ ] Zero-fills non-firing periods (does NOT forward-fill from prior bar)
- [ ] Negates returns for `direction='short'` signals
- [ ] Flags missing-close entries without crashing
- [ ] 7 unit tests pass (per Part 1's coverage matrix)

### Part 2 — Window sizes

- [ ] `config.f7.windowM` defaults to 250, overridable via env var
- [ ] `config.f7.windowD` defaults to 20, overridable via env var
- [ ] Passing `d > windowM` throws `F7ConfigError` at run start

### Part 3 — Weight versioning

- [ ] F1 migration adds `signal_weights` table with the Part 3 schema
- [ ] F7 populates it per run with a fresh UUID `run_id`
- [ ] F8 reads by `run_id`, never by "latest"
- [ ] 5 schema tests + 3 insert/query tests pass

### Part 4 — ISQ dimensions

- [ ] F1 migration also adds `signal_isq` table
- [ ] All 5 dimensions computed per signal per run
- [ ] Dimensions clamped to [0, 1]
- [ ] `timeliness` uses America/NY time for "today" check (not UTC)
- [ ] 6 unit tests pass (per Part 4's coverage matrix)

### Part 5 — Singularity guard

- [ ] `conditionNumber(ΛᵀΛ)` computed before OLS solve
- [ ] Threshold = 1e10 (configurable via `config.f7.singularThreshold`)
- [ ] Max 3 exclusion iterations
- [ ] Abort with `F7SingularError` after 3 iterations
- [ ] Event logged to `events` table on abort
- [ ] 5 unit tests pass

### Part 6 — Step 5/7 disambiguation

- [ ] Step 5 truncates to M-1 periods (drops 1)
- [ ] Step 7 asserts M-1 periods remain (no-op sanity check)
- [ ] Invariant test covers both

### Part 8.2 — Probability mode

- [ ] `mode: "returns" | "probability"` parameter on F7 entry function
- [ ] Probability-mode input shape documented
- [ ] `signal_weights.mode` column set correctly
- [ ] 3 tests cover probability-mode path

### Part 8.4 — IC filter

- [ ] Signals with `rolling_ic_30d ≤ 0` excluded before pipeline
- [ ] Exclusion logged in `signal_weights.excluded=1` + `exclude_reason='ic_le_zero'`
- [ ] Fresh signals (< 30 firings) admitted with `ic_30d = null` for benefit of the doubt
- [ ] 3 tests cover the filter

### Golden-file test

- [ ] `src/finance/f7/__fixtures__/f7-golden-3x10.json` exists
- [ ] 3 signals × 10 periods with hand-computed expected weights
- [ ] End-to-end test loads the fixture, runs the full pipeline, asserts weights within 1e-6 tolerance

---

## Part 11 — Open questions (deferred beyond F7 v1)

1. **Per-signal optimized `d`** (hinted at in the Momentum section). F7 v1 uses a single global `d = 20`. Per-signal optimization requires a separate loop + test surface and isn't needed at launch.

2. **Regime-conditional weights** (Part 7). Schema is forward-compatible; implementation deferred until we have ≥30 runs per regime class.

3. **Monte Carlo for `CV_edge`** (moved to F8 with the rest of Kelly sizing). F7 doesn't compute or read CV_edge.

4. **PCA fallback for singularity** (Part 5). Current v1 uses exclusion-based guard. If we hit too many aborts in production, add PCA as F7.5 enhancement.

5. **Per-signal optimized `horizon` in R(i,s) construction** (Part 1). Currently fixed at 1. Per-signal horizon requires the same optimization loop as `d` and is deferred symmetrically.

6. **Composite ISQ score for dashboards** (Part 4). F7 stores dimensions independently; composite is a future monitoring query.

7. **Walk-forward interaction** (F7.5 integration). Step 5 drop is already a look-ahead guard, so walk-forward at F7.5 can use any window boundary without conflict. No F7-side work needed; F7.5 owns the walk-forward loop.

---

## Summary

Seven underspecified items from the F7 math study are now locked. Four new findings from re-reading the authoritative spec are also captured. F7 is now a translation task: the 11-step pipeline with `R(i,s)` construction, window sizes, weight versioning, ISQ, singularity handling, Step 5/7 interpretation, and probability mode are all decided.

F7 estimate revised: **~1.85 sessions** (down from 2.0 after Kelly sizing moved to F8).
Phase β total: **+0.1 session net** (Kelly move cancels most of the addendum's additions).
F1 schema grows by 2 tables (`signal_weights`, `signal_isq`).
F8 grows by ~0.3 session (Kelly inherited).

**F7 can now start mechanically when its turn comes.** The remaining unknowns are either operator questions (open items in Part 11) or F7.5/post-launch enhancements that don't block Phase β shipping.
