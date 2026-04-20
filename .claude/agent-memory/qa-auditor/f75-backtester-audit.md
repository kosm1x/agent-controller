---
name: F7.5 Strategy Backtester audit (Phase β S10, 2026-04-19)
description: F7.5 audit on branch phase-beta/f75-backtester. Verdict FAIL — 2 critical math bugs (PBO formula double-logit, DSR annualization) + NaN ship-gate bypass. Integration row-7 clean.
type: project
---

# F7.5 Strategy Backtester Audit — Phase β S10 (2026-04-19)

## Verdict: FAIL

## Critical findings (ship-blockers)

### C1. PBO formula applies logit twice (backtest-overfit.ts:127)

```
const l = logit(rank / (N + 1 - rank + 1e-9));
if (l < 0) foldLogitsBelowZero += 1;
```

Per Bailey/de Prado 2014: `logit_f = log(rank / (N+1-rank))`. The ratio
`rank/(N+1-rank)` IS the logit value (log of odds). The code passes it
through `logit()` again which does `log(p/(1-p))`, effectively taking
`log(ratio/(1-ratio))` — a nested logit.

Effect: threshold for "below median" becomes `rank < (N+1)/3` instead of
`rank < (N+1)/2`. For N=24 trials, ranks 9-12 (below median) all escape
the count. PBO is systematically UNDER-reported, so overfit strategies
slip past the ship-gate.

Numerical confirmation: N=10, rank=5 → paper logit=-0.18 (below median,
count), code logit=+1.61 (miss).

Fix: replace with `const l = Math.log(rank / (N + 1 - rank))` (or just
`if (rank < (N + 1) / 2) foldLogitsBelowZero += 1`).

Tests do NOT catch this because both extreme tests (all-win, all-lose)
and bounds tests still pass.

### C2. DSR annualization mismatch vs √(T-1) scaling (backtest-overfit.ts:182)

`observedSharpe` and `trialSharpes` are annualized by √52 (multiplied
in sharpeWeekly). `expectedNull` is in the same (annualized) scale via
σ_SR which inherits from trialSharpes. So `(obs - null)` is in annualized
units. But `√(T-1)` in the numerator implements the per-period sample-size
scaling — it assumes SR is per-period (not annualized).

For a 54-week weekly strategy with Sharpe_weekly=0.14 (Sharpe_annual=1):

- Correct Z ≈ 0.14 × √53 ≈ 1.02, pvalue ≈ 0.15 (marginal)
- Code Z ≈ 1.00 × √53 ≈ 7.28, pvalue ≈ 1.7e-13 (false "high confidence")

Effect: DSR p-values are systematically too small; ship-gate `pvalue > 0.05`
almost never trips even for insignificant Sharpes. The firewall does not
fire.

Fix: either de-annualize obs/null/trialSharpes (divide by √52) inside
computeDsr, or use the annualized-variant formula where √(T-1) is replaced
by √N_trials_years or similar. Recommended: keep SR annualized, but
rescale inner: `numer = (obs - null) / sqrt(1/(T-1))`. See de Prado
errata — the formula must use per-period Sharpe with T=n_observations OR
annualized Sharpe with T=years.

Tests only verify monotonicity (pvalue(SR=3) < pvalue(SR=0.1)), so the
scale error isn't caught.

### C3. NaN ship-gate bypass (backtest.ts:375-377)

```
const shipBlocked =
  (Number.isFinite(pbo) && pbo > 0.5) ||
  (Number.isFinite(dsrPvalue) && dsrPvalue > 0.05);
```

When CPCV produces zero eligible folds (all aborted), PBO = NaN and
pvalue ∈ {NaN, garbage}. Both isFinite checks fail → `shipBlocked = false`.
A degenerate run where the firewall couldn't run at all is marked
`ship_ok`.

persistBacktestRun sanitizes `pboSafe=1, dsrPvalueSafe=1` for insert but
stores `ship_blocked=0` because it uses the pre-sanitized value from the
tool layer. DB ends up with `pbo=1, dsr_pvalue=1, ship_blocked=0` —
internally inconsistent. backtest_latest shows "ship_ok" on a broken run.

Fix at tool level: treat NaN as ship-blocked.

```
const shipBlocked =
  !Number.isFinite(pbo) ||
  pbo > 0.5 ||
  !Number.isFinite(dsrPvalue) ||
  dsrPvalue > 0.05;
```

Or sanitize before evaluating: `const pboEval = Number.isFinite(pbo) ? pbo : 1`.

## Warnings (should fix before merge)

### W1. `is_mean` vs `oos_mean` inconsistency in backtest_explain (backtest.ts:565-571)

`is` uses `x.is_sharpe ?? 0` (nulls become 0, biasing mean low) while
`oos` uses `filter(x.oos_sharpe !== null)` (correct). When aborted folds
set both to null, IS_mean ends up diluted by zeros. Operator-facing
output is misleading.

### W2. computePbo rank stratification test is absent

Only extreme cases (all win / all lose) are tested. No synthetic case
verifies that a winner at rank=N/2-0.5 (just below median) is counted.
This is how C1 escaped. Add test:

```
it("PBO = 1 when winner rank is (N-1)/2 for N=4", () => {
  // rank=2 of 4 is below median — paper says count, code does NOT.
});
```

### W3. DSR tests check monotonicity but not absolute values

Add a hand-computed fixture with known Bailey/de Prado 2014 values.
Example: Bailey's table 1 has SR=1.2, σ_SR=0.3, γ3=0, γ4=3, N=100,
T=252 → DSR=0.XXXX. Without such a fixture, C2's annualization error
is uncaught.

### W4. partitionGroups + small dates → empty groups not guarded by tool

`partitionGroups(10 dates, 6 groups)` → groups of [2,2,2,2,1,1]. With
kTestGroups=2, many folds have total test indices < 2 → aborted with
"insufficient_bars". The tool-level `MIN_BARS_FOR_BACKTEST = 26` gates
this, so runtime is safe, but the CPCV library doesn't warn when
nGroups is too high for the data. Log a warning when > 25% of folds
would be insufficient.

### W5. try/catch in applyWeightsStaticToDates swallows non-missing-return errors (backtest-cpcv.ts:264)

`try { simulate } catch { return empty }` catches ALL errors, not just
"missing return". Non-ascending schedule or negative costBps would also
be silently swallowed. Since dates come from sorted indices, current
callers are safe, but this is fragile against future callers.

## Info (nits, deferred OK)

### I1. riskTier inconsistency vs alpha_run

`backtest_run` declares `riskTier: "low"`. `alpha_run` (same codebase,
same pattern — persists to signal_weights table) does not. Either add to
alpha_run or remove from backtest_run for consistency. Low priority.

### I2. "PBO" as scope activator could false-positive on accounting text

Pension Benefit Obligation (accounting) abbreviates to PBO. Unlikely in
this agent's normal traffic, but if user discusses retirement accounting,
backtest scope activates. Consider pairing "pbo" with a financial
context anchor (`\bpbo\b(?=.*sharpe|.*overfit)` or similar).

### I3. backtestExplainTool sort with null `oosMean`

`(b.oosMean ?? -Infinity) - (a.oosMean ?? -Infinity)` can produce
`-Infinity - -Infinity = NaN` when both are null; sort comparator NaN
has undefined-but-stable behavior. Not a crash but could yield
surprising ordering. Prefer: filter nulls out, then sort.

### I4. DSR expectedNull falls to 0 for single-trial case

When only 1 trial is eligible (all others aborted), σ_SR = 0,
expectedNull = 0, DSR collapses to a plain Z test on observed Sharpe.
This is the documented fallback, but surface a flag in the output so
operators know the deflation was skipped.

## Integration (7-row checklist)

All 7 rows present and consistent:

| Row                       | File                                         | Status |
| ------------------------- | -------------------------------------------- | ------ |
| 1. builtin source imports | src/tools/sources/builtin.ts:171-175         | OK     |
| 2. builtin array          | src/tools/sources/builtin.ts:289-292         | OK     |
| 3. scope group constant   | src/messaging/scope.ts:266-271               | OK     |
| 4. scope pattern          | src/messaging/scope.ts:493-500               | OK     |
| 5. scope dispatch         | src/messaging/scope.ts:754-756               | OK     |
| 6. WRITE_TOOLS            | src/runners/fast-runner.ts:322-326           | OK     |
| 7. write-tools-sync test  | src/runners/write-tools-sync.test.ts:146-161 | OK     |
| 8. auto-persist Rule 2b   | src/memory/auto-persist.ts:156-158           | OK     |

## Tests (per file)

- backtest-sim.test.ts (230 lines, 10 cases) — comprehensive including
  hand-computed 3-bar 2-symbol fixture. Strong.
- stats.test.ts (163 lines, 15 cases) — hand-verified G1 formula, table
  values for Φ. Strong.
- backtest-walkforward.test.ts (299 lines, 11 cases) — covers abort,
  rebalance cadence, multi-signal aggregation. Strong.
- backtest-cpcv.test.ts (262 lines, 13 cases) — covers embargo, abort,
  grid sizing. Mostly structural, not numerical. Medium.
- backtest-overfit.test.ts (296 lines, 13 cases) — weakest. Only extreme
  PBO cases, only monotonicity DSR. Missed C1 and C2. See W2 + W3.
- backtest.test.ts (250 lines, 11 cases) — covers malformed inputs,
  degenerate runs, persist round-trip. Good.

Persistence uses better-sqlite3 transaction — atomicity OK.

## Schema

backtest_runs / backtest_paths / backtest_overfit all additive, NOT NULL
columns sanitized with `finite(x, fallback)` in persist layer (except
for shipBlocked — see C3). Schema applied live to data/mc.db per the
audit brief.
