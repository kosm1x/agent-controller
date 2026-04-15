# F7 Alpha Combination Engine — Math Study

> **Exploration item:** A (from `05-exploration-plan.md`)
> **Run date:** 2026-04-14 session 67 wrap+3
> **Source:** `docs/V7-ALPHA-COMBINATION-EQUATIONS.md` + V7-ROADMAP F7 section
> **Method:** Explore agent extracted the 11-step pipeline, derived formulas, constructed a worked example with invented inputs, and flagged fragility risks.
> **Purpose:** Derisk F7 implementation (the algorithmic core of Phase β, 2 sessions solo) BEFORE the session starts. The math spec exists but leaves ~7 implementation-critical items underspecified — the biggest one is a real pre-F7 blocker.

---

## Headline findings

1. **The 11 steps are extracted with explicit formulas.** The pipeline is rigorous: serial demean → variance → z-score → drop-for-look-ahead → cross-sectional demean → drop-final → forward expected return → **regression for independent residuals** → weight calc → normalize. Step 9 (residual regression) is the decision point.

2. **The worked example converges to surprisingly imbalanced weights.** With 3 invented signals (Momentum, RSI, Sentiment) and 2 periods, the algorithm produces `w = [0.219, 0.014, 0.767]` — Sentiment dominates (76.7%) because it had the highest independent edge relative to its noise. Key insight: **low-volatility signals get amplified**. This is a feature, not a bug, but the operator should know.

3. **Critical gap: R(i,s) construction is not specified.** The math assumes a 2D return matrix `R(signal, period)` — but the spec does NOT define how to convert F3's `signals` table rows + F1's `market_data` into that matrix. This is THE load-bearing gap. Resolving it is a hard pre-F7 requirement.

4. **ISQ (Ingredient Signal Quality) dimensions are mentioned in the roadmap but not defined in the math.** The 5-dimension shape I sketched below (efficiency / timeliness / coverage / stability / forward_ic) is a proposal, not the spec.

5. **Six other underspecified items** — window sizes (M, d), weight versioning strategy, per-signal freshness gates, regression singularity handling, off-by-one between Steps 5 and 7, regime-conditional IC tracking. All seven items get laid out in the recommendations at the bottom with suggested defaults.

6. **F7 is NOT blocked.** The math is implementable. What's missing is a 1-page F7 addendum resolving the seven underspecified items. That addendum should be drafted BEFORE the F7 session starts — it turns F7 from an invention task into a translation task.

---

## 1. The 11 steps

The `V7-ALPHA-COMBINATION-EQUATIONS.md` doc specifies **11 concrete steps** (the section header says "12-Step Procedure from Working Paper" but that's the academic formalization — the implementation spec defines 11 steps and the 12th is the final synthesis line `MegaAlpha(t) = Σ w(i) × Signal(i,t)`).

| #   | Step                                 | Purpose                                                                  |
| --- | ------------------------------------ | ------------------------------------------------------------------------ |
| 1   | Collect returns                      | Raw return series `R(i,s)` per signal `i`, period `s`                    |
| 2   | Serial demean                        | Center each signal by subtracting its own mean                           |
| 3   | Sample variance                      | Compute `σ(i)²` for each signal                                          |
| 4   | Normalize to common scale            | Z-score: `Y(i,s) = X(i,s) / σ(i)`                                        |
| 5   | Drop most recent observation         | Look-ahead guard (part 1)                                                |
| 6   | Cross-sectional demean               | Subtract the average across all signals at each period                   |
| 7   | Drop final period                    | Look-ahead guard (part 2)                                                |
| 8   | Forward expected return              | Momentum estimate over most recent `d` periods                           |
| 9   | **Isolate independent contribution** | Regress forward returns against orthogonalized history; residuals = edge |
| 10  | Portfolio weight                     | `w(i) = η × ε(i) / σ(i)`                                                 |
| 11  | Normalize weights                    | Constrain `Σ \|w(i)\| = 1`                                               |

**Final output:** `MegaAlpha(t) = Σ w(i) × Signal(i,t)` — weighted combination of N signals.

---

## 2. Core equations

### Step 2: Serial demean

```
X(i,s) = R(i,s) − (1/M) × Σ R(i,·)
```

### Step 3: Variance

```
σ(i)² = (1/M) × Σ X(i,s)²
σ(i)  = √[(1/M) × Σ X(i,s)²]
```

### Step 4: Z-score normalization

```
Y(i,s) = X(i,s) / σ(i)
```

### Step 6: Cross-sectional demean

```
Λ(i,s) = Y(i,s) − (1/N) × Σ_{j=1..N} Y(j,s)
```

At each time `s`, subtract the average of all N signals' normalized returns.

### Step 8: Forward expected return (momentum)

```
E(i)      = (1/d) × Σ_{s ∈ recent d periods} R(i,s)
E_norm(i) = E(i) / σ(i)
```

### Step 9: Isolate residuals (the decision point)

```
Regression model (no intercept):
E_norm(i) = β₁·Λ(i,1) + β₂·Λ(i,2) + … + β_{M-1}·Λ(i,M-1) + ε(i)

ε(i) = residuals = idiosyncratic forward edge not captured by cross-sectional patterns
```

### Step 10: Weight calculation

```
w(i) = η × ε(i) / σ(i)
```

### Step 11: Normalization constraint

```
Σ |w(i)| = 1
η = 1 / Σ |ε(i) / σ(i)|
```

### Final synthesis

```
MegaAlpha(t) = Σ w(i) × Signal(i, t)
```

### Information Ratio core law (why combination works)

```
IR = IC × √N_effective
```

- **IR** = Information Ratio (risk-adjusted edge of combined system)
- **IC** = Information Coefficient (0.05–0.15 typically)
- **N_effective** ≤ N_total (true independent signals after shared variance removal)

50 weakly independent signals at IC=0.05 → IR ≈ 0.354. Single signal at IC=0.10 → IR = 0.10. The 50-signal system is 3.5× more powerful despite lower per-signal IC because **independence compounds**. This is the entire rationale for having a combination engine at all.

---

## 3. Dimensionality

- **N (ingredients/signals) at launch:** F3 produces ~6 base signals (MA crossover, RSI extreme, MACD cross, Bollinger breakout, volume spike, price threshold). F6 adds ~4 prediction market signals. F6.5 adds ~3 sentiment signals (two free sources blended + crypto funding). **Estimated N ≈ 13–15 at Phase β launch.** Algorithm is generic over N.

- **M (historical observation window):** Spec says "most recent d periods" for Step 8 lookback but does not pin M globally. Implied constraint from Steps 5–7: M must span enough history to compute reliable `σ(i)` and solve the Step 9 regression. **For daily data, M ≈ 63–250 business days (3 months to 1 year) is typical.** Not specified in the doc — implementation choice.

- **Layers:** Spec does NOT explicitly layer the combination. The math flattens all N signals into a single vector and applies the 11 steps. The V7-ROADMAP mentions "per-layer freshness gates" and "weight versioning" as F7 work items, but the equations assume a single flat aggregation. **This is a discrepancy** between the spec and the roadmap — worth asking before F7.

- **ISQ (Ingredient Signal Quality) dimensions:** Listed as a work item in roadmap line 226 but NOT defined in the equations doc. Closest proxy is the 3-tuple `(ε(i), σ(i), IC(i))`. **Underspecified.**

- **Dynamicity:** Both M and N are dynamic. M grows as new periods arrive; N grows as new signals are added (F3 → F6 → F6.5 sequence). The algorithm handles both — re-weight after each new period, re-regress after adding signals.

---

## 4. Worked example

**Setup:** 3 signals (Momentum, RSI, Sentiment), 2 observation periods, 1-period lookahead.

| Signal     | Period 0 Return | Period 1 Return | Forward Return (d=1) |
| ---------- | --------------- | --------------- | -------------------- |
| Mom (i=1)  | +0.5%           | +0.3%           | +0.8%                |
| RSI (i=2)  | −0.2%           | +0.4%           | +0.1%                |
| Sent (i=3) | +0.1%           | +0.2%           | +0.5%                |

**Step 2 (serial demean):**

- Mom: mean = 0.4%; X(1,0) = 0.1%, X(1,1) = −0.1%
- RSI: mean = 0.1%; X(2,0) = −0.3%, X(2,1) = 0.3%
- Sent: mean = 0.15%; X(3,0) = −0.05%, X(3,1) = 0.05%

**Step 3 (variance):**

- `σ(1) = 0.1%`, `σ(2) = 0.3%`, `σ(3) = 0.05%`

**Step 4 (normalize):**

- Mom: Y(1,0) = 1.0, Y(1,1) = −1.0
- RSI: Y(2,0) = −1.0, Y(2,1) = 1.0
- Sent: Y(3,0) = −1.0, Y(3,1) = 1.0

**Step 5 (drop most recent):** Retain period 0 only.

**Step 6 (cross-sectional demean, period 0):**

- Mean across all 3 at period 0: `(1.0 − 1.0 − 1.0) / 3 = −1/3`
- Λ(1,0) = 4/3 ≈ 1.333
- Λ(2,0) = −2/3 ≈ −0.667
- Λ(3,0) = −2/3 ≈ −0.667

**Step 7 (drop final):** Already done.

**Step 8 (forward expected return):**

- E_norm(1) = 0.8 / 0.1 = **8.0**
- E_norm(2) = 0.1 / 0.3 = **0.333**
- E_norm(3) = 0.5 / 0.05 = **10.0**

**Step 9 (OLS regression, β = Σ(E_norm × Λ) / Σ(Λ²)):**

- Numerator: `8.0 × 4/3 + 0.333 × (−2/3) + 10.0 × (−2/3) ≈ 3.56`
- Denominator: `(4/3)² + (−2/3)² + (−2/3)² = 8/3 ≈ 2.67`
- **β ≈ 1.33**
- Residuals (idiosyncratic edge):
  - ε(1) ≈ 6.23 (Mom)
  - ε(2) ≈ 1.22 (RSI)
  - ε(3) ≈ 10.89 (Sent)

**Step 10 (raw weights):**

```
w(1) = η × 6.23 / 0.1   = η × 62.3
w(2) = η × 1.22 / 0.3   = η × 4.07
w(3) = η × 10.89 / 0.05 = η × 217.8
```

**Step 11 (normalize, Σ|w| = 1):**

- `η = 1 / 284.17 ≈ 0.00352`
- Final weights: **w(1) ≈ 0.219, w(2) ≈ 0.014, w(3) ≈ 0.767**

**Final:** `MegaAlpha(t) = 0.219 × Mom + 0.014 × RSI + 0.767 × Sent`

**Insights surfaced by this example:**

- Signals with low volatility `σ(i)` get amplified (Sentiment's 0.05% noise makes it dominant at 76.7%)
- Cross-sectional demean (Step 6) removes market-wide effects; idiosyncratic residuals dominate weights
- The regression (Step 9) is the decision point: if two signals capture the same factor, only the residual survives as independent
- **RSI got 1.4% weight despite being in the pipeline** — if its residual is low because it's correlated with another signal, it contributes almost nothing. Is that desired behavior, or a bug? Depends on whether low-residual signals should be dropped entirely vs kept at low weight.

---

## 5. Fragility risks

### 5.1 Zero-denominator NaN propagation

Step 3 computes `σ(i)` from variance. If a signal is perfectly flat (all returns identical), `σ(i) = 0`, and Steps 4, 8, 10 produce NaN or Inf.

**Mitigation:** Check `σ(i) > ε_threshold` (e.g., 1e-6) before division. Signals with `σ ≤ threshold` are dropped before pipeline — they have no signal, only noise.

### 5.2 Off-by-one in window truncation

Steps 5 and 7 both drop observations to prevent look-ahead bias. The doc phrases them as "drop most recent observation" (Step 5) and "drop final period" (Step 7). **The spec does not clarify if these are sequential or the same drop.**

- If two drops: `M → M−1 → M−2` (e.g., 63 → 62 → 61 periods). Weaker regression.
- If one drop: `M → M−1` (63 → 62 periods). Correct.

Effective sample size differs by 1 depending on interpretation, which silently degrades regression power in Step 9. **Ambiguity — implementer must audit.**

### 5.3 Signal evolution & weight drift

Signals fire and cease over time. Example:

- Periods 0–50: Signal A fires reliably, IC = 0.12
- Periods 51–100: Signal A stops (API outage, regime change, bug), IC = 0

If Step 3 and Step 8 compute over the **combined 100-period window**, `σ(A)` and `E(A)` are diluted by 50 silent periods. Weights in Step 10 reflect an average quality, not current state.

**The doc mentions "Signal evolution tracking" and "Per-layer freshness gates" as F7 work items but does not specify the algorithm.** If not implemented, weights drift when signals stop firing. A signal with zero forward return in recent periods still gets a weight if it was strong historically.

**Mitigation:** Rolling windows. Recompute `σ(i)` and `E(i)` over recent N days (e.g., last 30) rather than all-time. Flag signals with <20 firing events in the recent window (insufficient history).

### 5.4 Weight versioning ambiguity

Steps 10–11 compute weights `w(i)` once per run. The roadmap lists "weight versioning" as an F7 item. **The spec does not say if weights are:**

- Overwritten each run (no history)
- Appended with timestamps (full audit trail)
- Versioned per day/symbol (immutable snapshots)

If weights are computed once per day but signals change within the day, F8 paper trading and F9 scan rituals apply **stale weights to live signals**. Silent and dangerous.

**Mitigation:** Always store `(timestamp, symbol, version_hash(signal_inputs), w(i) vector, E_norm(i), ε(i), σ(i))`. Recompute weights intraday if any signal state changes.

### 5.5 Regression stability in Step 9

Step 9 solves `E_norm(i) = β × Λ(i,·) + ε(i)` via OLS. If the Λ matrix is rank-deficient (signals too correlated), the regression is singular or near-singular. β estimation becomes unstable; ε residuals blow up.

The doc mentions `N_effective ≤ N_total` but does not specify a check. **If 15 signals are submitted but 13 are linear combinations of 2, the regression produces unreliable ε values.**

**Mitigation options:**

1. Compute condition number of `Λᵀ × Λ`. Flag if > 1e10.
2. Run PCA on Λ; keep only components explaining 95% variance.
3. If rank deficiency detected, warn and exclude correlated signals via correlation matrix thresholding.

### 5.6 ISQ (Ingredient Signal Quality) dimensions

The roadmap lists ISQ dimensions as a work item (line 226), but the math spec does not define them. Code must invent a shape (e.g., `[efficiency, timeliness, coverage, stability, ic_rolling_30d]`) without guidance.

**Fragility:** Ad-hoc implementation choices don't compose. Example: if ISQ includes "freshness" but the implementation only tracks "last_fired_timestamp," signals that stopped firing won't be penalized correctly.

**Suggested ISQ spec:**

```
ISQ(i) = {
  efficiency:   Σ|w(i)| / Σ|ε(i)|,                            // how much of the edge survived normalization
  timeliness:   1.0 if signal_fired_today else 0.5,           // staleness penalty
  coverage:     n_symbols_signal_fired / n_symbols_total,     // breadth
  stability:    rolling_ic_std / rolling_ic_mean,             // consistency
  forward_ic:   rolling_correlation(signal, realized_return)  // predictive power
}
```

### 5.7 External state dependencies

Steps 8 and 9 require forward returns `R(i,s)` for "most recent d periods" and historical returns for regression. **The spec does not clarify:**

- Does "return" mean price change, log return, or normalized return?
- Which interval? Daily? Intraday? Mixed?
- If a signal is intraday but `market_data` is daily, how is R(i,s) bridged?
- Are forward returns actual realized (outcome), or predicted (from the signal itself)?

**Fragility:** If F1 provides daily OHLCV but F3 produces intraday signals, Step 8 cannot compute E(i) without explicit alignment logic **missing from the spec**.

---

## 6. Dependencies on upstream F-sessions

**F7 reads from:**

1. **F3 (Signal Detector)** — `signals` table rows:
   - `symbol`, `signal_type`, `direction`, `strength`, `triggered_at`, `indicators_snapshot`
   - Each row is an individual signal firing. Step 1 must convert this into return series `R(i,s)`.
   - **Gap:** The spec does not define how to aggregate multiple signal firings into a return series for regression.

2. **F1 (Data Layer)** — `market_data` table:
   - `symbol`, `timestamp`, `close`, `volume`, `adjusted_close`
   - Used to compute realized returns for Step 1 and forward returns for Step 8.
   - **Verified in F1 pre-plan:** The `market_data` table has all required columns.
   - **Gap:** If F3 signals fire at 1-min intervals but F1 provides daily closes, forward returns cannot be computed per-signal granularity.

3. **F5 (Macro Regime Detection)** — indirectly via regime context:
   - The spec mentions regime-conditional IC tracking (e.g., IC during bull vs bear).
   - **Gap:** Regime labels are not in the equations. If F5 provides regime but F7 doesn't integrate it, per-regime weight versioning can't happen.

4. **F6 (Prediction Markets)** — signal outputs (implied probabilities, whale positions). Treated as N signals. F6 schema not reviewed in detail yet — must output `symbol`, `timestamp`, value.

5. **F6.5 (Sentiment)** — signal outputs (Fear & Greed, funding rates, stablecoin flows). Treated as N signals. Simple scalar values, no shape issues expected.

**The most load-bearing gap:** R(i,s) construction. The equations assume a 2D return matrix where `i = signal index, s = time period`. **The spec does not define how to build this from the upstream tables.** Example:

If F3 produces a "RSI > 70" signal at 2026-04-15 14:30 with `strength = 0.8`, what is R(i,s)?

- +0.8% (the strength value)?
- Log return close-to-close from 14:30 to 15:00?
- Realized return close-to-close from signal fire to next period?
- Prediction (forward return predicted by the signal)?

**Implementation choice deferred in spec.** This is the pre-F7 blocker.

---

## 7. Test strategy

### Minimal end-to-end golden-file test

Use the Section 4 worked example as the primary fixture. 3 signals × 2 periods → known weights [0.219, 0.014, 0.767] → known `MegaAlpha` output. Store as JSON in `src/finance/__fixtures__/f7-golden-3x2.json`.

### Per-step unit tests

| Step  | Test                   | Assertion                                   |
| ----- | ---------------------- | ------------------------------------------- |
| 2     | Serial demean          | `mean(X(i,·)) ≈ 0` for all i after demean   |
| 3     | Variance               | `σ(i)²` matches manual calculation          |
| 4     | Normalize              | `mean ≈ 0, std ≈ 1` for all i after z-score |
| 6     | Cross-sectional demean | `mean(Λ(·,s)) ≈ 0` for all s after          |
| 8     | Momentum               | `E_norm(i)` correct for known lookback      |
| 9     | Residuals              | `Σ ε(i) ≈ 0` (OLS property)                 |
| 10–11 | Weights                | `Σ \|w(i)\| = 1 ± 1e-6`                     |

### Fragility tests

| Risk                | Test case                      | Expected behavior                                              |
| ------------------- | ------------------------------ | -------------------------------------------------------------- |
| Zero σ              | Flat signal (constant returns) | Drop signal before pipeline; do NOT emit NaN                   |
| Off-by-one          | Run with M=10, 20, 100         | Document effective sample size in output; same across M values |
| Singular regression | 3 signals with 99% correlation | Emit condition-number warning; exclude or decompose            |
| NaN/Inf propagation | Signal with ±1000× returns     | Clamp or reject; never emit Inf in output                      |
| Determinism         | Same inputs twice              | Identical weights (no RNG, no time-dependent state)            |
| Stale weights       | Modify signal state mid-day    | Weights recomputed or flagged stale                            |

### Regression suite (run weekly against live data)

Once the golden fixture is established:

- Run pipeline weekly on live F3+F1+F6+F6.5 data
- Assert `MegaAlpha` changes < 10% week-over-week (catches major algo regressions)
- Log `N_effective` per run; alert if `N_eff < 3` (signals too correlated)

---

## 8. Recommendations for the F7 pre-plan (mine, not the agent's)

The math study surfaced seven underspecified areas. Before the F7 session starts, draft a **1-page F7 addendum** in `docs/planning/phase-beta/` that locks these down. This turns F7 from an invention task into a translation task.

### Must-specify before F7 starts (pre-F7 blockers)

1. **R(i,s) construction algorithm.** The most important one. Define exactly how `signals` table rows + `market_data` rows become a 2D return matrix. Proposed default: For each signal `i`, `R(i,s)` = realized close-to-close return of the signal's target symbol over a fixed interval (e.g., 1 day) following the signal firing at period `s`. Signals that don't fire in period `s` get `R(i,s) = 0` (neutral). Store the alignment assumption explicitly.

2. **Window sizes M and d.** Propose default: `M = 250` business days (1 year rolling window), `d = 20` business days (~1 month forward lookback). Make both overridable via F7 config.

3. **Weight versioning schema.** Propose a new table `signal_weights` with `(version_id, timestamp, symbol, signal_id, weight, epsilon, sigma, e_norm, n_effective, regime)`. Every pipeline run appends a new version — never overwrites. F8 and F9 reference weights by `version_id`, not by "latest."

### Should-specify before F7 starts (high-value but not blocking)

4. **ISQ dimensions.** Lock the 5-dimension shape proposed in Section 5.6. Implementation computes ISQ per signal per run and stores it alongside weights.

5. **Regression singularity handling.** Pick: (a) condition-number threshold + warn, (b) PCA truncation at 95% variance, or (c) correlation-matrix exclusion. Lock one. I'd recommend (a) + warn for launch simplicity, add (b) later if needed.

6. **Off-by-one Step 5/7 interpretation.** Read the equations doc one more time carefully; if ambiguous, email the original working-paper author or make the implementation choice explicit in a comment.

### Can defer (not blocking)

7. **Regime-conditional IC tracking.** F5 provides regime labels; F7 can log them alongside weights without yet conditioning on them. The conditioning can land as a post-launch enhancement once we have enough regime-diverse data to compute per-regime IC reliably.

---

## 9. Impact on F7 session estimate

**Original v7-ROADMAP:** 2 sessions (unchanged by this study).

**Revised with addendum:** 2 sessions + ~0.3 session for the pre-F7 addendum = **~2.3 sessions total**.

The +0.3 is well-spent. Without the addendum, F7 implementation would spend that much time (or more) discovering these gaps mid-session and making ad-hoc choices. Per the pattern in `feedback_audit_iteration.md`, surfacing design decisions before coding is always cheaper than discovering them during coding.

---

## 10. What this study did NOT cover

- **Performance / compute cost.** The Step 9 regression at M=250, N=15 is trivially cheap (15×249 matrix). Not worth studying until we're at N > 100 which is years away.
- **Numerical stability of the OLS solver.** Assumed adequate for our scale. If N grows to 50+, revisit with a QR or SVD solver.
- **Online / streaming variant.** The 11-step pipeline is batch. If we want per-period incremental updates later, that's a separate design.
- **Regime transition handling.** What happens to weights when regime shifts? Not addressed in spec. F5 and F7 will need a brief interaction contract post-F5.

---

## Summary

F7 is the algorithmic core of Phase β and deserved the derisking pass. The math spec is rigorous on the pipeline but leaves 7 implementation-critical items underspecified, most dangerously the `R(i,s)` construction rule. A 1-page pre-F7 addendum locking the 6 must/should items turns F7 from a 2-session invention task into a 2-session translation task with a predictable shape.

**Recommendation:** Write the F7 addendum as exploration item "A2" during the readiness gate window (or at latest, as the first 30 minutes of the F7 session itself). Do NOT start F7 implementation without it.
