# V7 Alpha Combination — Mathematical Reference

> Complete equation set from the Fundamental Law of Active Management framework.
> Source: RohOnChain institutional signal combination thread.
> Academic formalization: "A Unified Framework for Alpha Extraction and Signal Combination" (Working Paper).
> Reference for implementing F7 (Alpha Combination Engine).

## Formal 12-Step Procedure (from Working Paper)

The paper formalizes the combination engine as follows. Let R(i,s) denote the return series for signal i at time s. We construct a standardized alpha extraction pipeline as follows. First, a linear process is applied to remove drift:

```
(1)  d' = R(i,s) − (1/M) × Σ R(i,s)
     Variance estimation follows, utilizing the demeaned returns X(i,s) for standardization:

(2)  σ(i) = √[(1/(M-1)) × Σ X(i,s)²]

     Normalization of the return series to consistent scaling:

(3)  Y(i,s) = X(i,s) / σ(i)

     Subsequent time-series truncation is performed, limiting the observation window to M−1 periods:

(4)  A(i,s) = Y(i,s),  s = 1,2,...,M−1

     Cross-sectional demeaning removes average market-wide bias from the normalized signals:

(5)  Λ(i,s) = A(i,s) − (1/N) × Σ A(j,s),  s = 1,2,...,M−1

     A final trimming ensures the line horizon is restricted to s:

(6)  Λ(i,s),  s = 1,2,...,M−1

     The estimation of expected returns relies on a defined estimation period d:

(7)  E(i) = (1/d) × Σ R(i,s)  for most recent d periods

     We normalize these returns so that their respective utilities to compute E_norm(i):

(8)  E_norm(i) = E(i) / σ(i)

     Residual extraction is then achieved by orthogonalizing E_norm(i) against the factors Λ(i,·):

(9)  ε_resid(i) = β × Λ(i,·) + ε(i)
     Residual ε(i) = independent contribution

     Signal weighting is constructed to inversely proportion the residual to volatility, where η is a
     normalization constant:

(10) w(i) = η × ε(i) / σ(i)

     Weights are constrained to sum to absolute total of unity:

(11) Σ |w(i)| = 1

     Combined Signal:

(12) Combined Signal = Σ w(i) × s(i)
```

Note: "Do not distribute" — Preliminary Draft. Equations transcribed for implementation reference only.

## Core Law

```
IR = IC × √N
```

- **IR** = Information Ratio (risk-adjusted edge of combined system)
- **IC** = Average Information Coefficient (correlation of signal vs outcome, typically 0.05-0.15)
- **N** = Number of genuinely independent signals (NOT total signal count)

Example: 50 signals at IC=0.05 → IR = 0.05 × √50 = 0.354
vs single signal at IC=0.10 → IR = 0.10 × √1 = 0.10
The 50-signal system is 3.5× more powerful.

---

## Signal Categories

### 1. Momentum (expected return)

```
E(i) = (1/d) × Σ R(i,s)  for s in most recent d periods
```

Parameter `d` (lookback) optimized independently per signal.

### 2. Factor Model (Fama-French)

```
R(i) = α(i) + β₁×MKT + β₂×SMB + β₃×HML + ε(i)
```

- MKT = market excess return
- SMB = small minus big (size factor)
- HML = high minus low (value factor)
- Each β = sensitivity estimate, each factor = independent signal with its own IC

### 3. Microstructure (Effective Spread)

```
Effective Spread = 2 × |Trade Price − Mid Price|
```

- Compressing → low information asymmetry
- Expanding → someone trading on unpriced information

### 4. Bayesian Update (Prediction Markets)

```
P(H|E) = [P(E|H) × P(H)] / P(E)
```

Each new evidence E updates the prior probability P(H) of hypothesis H.

---

## 11-Step Combination Engine

### Step 1: Collect returns

```
R(i,s) = return of signal i in period s
```

For each signal i ∈ {1..N}, each period s ∈ {1..M}.

### Step 2: Serial demean (remove drift)

```
X(i,s) = R(i,s) − mean(R(i,·))
```

Centers each signal around zero. Prevents trending signals from appearing more valuable due to market regime.

### Step 3: Sample variance

```
σ(i)² = (1/M) × Σ X(i,s)²
```

High variance = noisy/unpredictable. Low variance = consistent. Used in Step 10 to penalize unreliable signals.

### Step 4: Normalize to common scale

```
Y(i,s) = X(i,s) / σ(i)
```

After this step, a momentum signal in percentage points and a microstructure signal in basis points are directly comparable.

### Step 5: Drop most recent observation

Retain only first M periods in Y(i,s). Prevents look-ahead bias.

### Step 6: Cross-sectional demean

```
Λ(i,s) = Y(i,s) − mean(Y(·,s))  across all N signals at each period s
```

At each time point, subtract the average of all signals. Removes market-wide effects driving all signals in the same direction. What remains = idiosyncratic contribution.

### Step 7: Drop final period

Retain M−1 periods in Λ(i,s). Final data hygiene against residual look-ahead.

### Step 8: Forward expected return

```
E(i) = (1/d) × Σ R(i,s)  for most recent d periods
E_normalized(i) = E(i) / σ(i)
```

Forward-looking estimate scaled to same units.

### Step 9: Isolate independent contribution (CRITICAL)

```
Regress E_normalized over Λ(i,s) without intercept, unit weights
Residuals ε(i) = independent forward-looking edge
```

**This is the key step.** Not "which signal has highest expected return" but "which signal contributes the most that no other signal already captures."

### Step 10: Portfolio weight

```
w(i) = η × ε(i) / σ(i)
```

Weight ∝ independent edge / noise. High edge + low noise → high weight. Low edge + high noise → low weight. No subjective judgment.

### Step 11: Normalize

```
Σ |w(i)| = 1
```

Set η so absolute weights sum to 1. Full allocation, no unintended leverage.

---

## Output: MegaAlpha

For any instrument at time t:

```
MegaAlpha(t) = Σ w(i) × Signal(i,t)
```

The weighted combination across all N signals. Single high-conviction output from N individually weak signals.

---

## Position Sizing: Empirical Kelly

```
f_kelly = (p × b − q) / b
```

- p = probability of winning (from megaAlpha)
- q = 1 − p
- b = odds (payout ratio)

### Uncertainty adjustment

```
f_empirical = f_kelly × (1 − CV_edge)
```

- CV_edge = coefficient of variation of edge estimates across Monte Carlo simulation
- Run 10,000 path simulations of historical returns
- Measure how much edge estimate varies across paths
- More variation → more reduction from full Kelly
- Math automatically adjusts for how certain you ARE vs how certain you FEEL

---

## Key Insight: Effective N ≠ Total N

```
N_effective ≤ N_total
```

50 correlated signals ≈ 10-15 independent signals after shared variance removal.
The combination engine forces honest accounting of actual independence.

**The failure mode it prevents:**
A trader believes she has 3 independent reasons to be confident.
She actually has 1 reason expressed 3 times, sized for 3.
The combination engine exposes this structurally.

---

## Prediction Market Application

Instead of combining signals about returns, combine signals about probabilities:

| Signal                 | Produces                                         |
| ---------------------- | ------------------------------------------------ |
| Cross-venue pricing    | Implied probability from PM spread vs offshore   |
| Historical calibration | Probability from resolution rates (400M trades)  |
| Bayesian update        | Probability from new evidence                    |
| Microstructure (VPIN)  | Probability from informed order flow             |
| Momentum               | Probability from price direction near resolution |

Run through Steps 1-11 → single combined probability → gap vs market price = edge → empirical Kelly sizing.

---

## Implementation Notes for Jarvis v7

- **Pure TypeScript math** — no external deps. The 11 steps are matrix operations on arrays
- **Signal return series** — stored in market_data table, computed per signal per period
- **Effective N** — logged per combination run. If N_effective < N_total/3, warn: signals are too correlated
- **IC tracking** — measure actual IC per signal over rolling 30-day window. Signals with IC ≤ 0 are dropped
- **Walk-forward** — Step 5 (drop most recent) is already a guard; combine with F7.5 walk-forward for double protection
- **Monte Carlo for CV_edge** — 10K simulations, ~2 seconds on VPS. Run once per daily scan, cache result
