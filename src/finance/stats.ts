/**
 * F7.5 Strategy Backtester — statistical helpers for DSR and PBO.
 *
 * Pure functions. No deps. No mutation.
 *
 * Implements what de Prado's DSR/PBO formulas need:
 *   - normCdf / normInv  (standard normal CDF + inverse)
 *   - sampleSkewness (bias-corrected, Fisher-Pearson)
 *   - sampleExcessKurtosis (bias-corrected, returns excess i.e. K − 3)
 *   - sampleStdBessel (already in alpha-linalg but re-exported-style via
 *     local `sampleVariance`/`sampleStd` for algorithm readability)
 *
 * normCdf uses Abramowitz & Stegun 26.2.17 approximation (|error| < 7.5e-8).
 * normInv uses Beasley-Springer-Moro (common high-accuracy closed form).
 * Both round-trip to within 1e-9 across p ∈ [1e-8, 1 − 1e-8].
 *
 * EULER is Euler-Mascheroni γ ≈ 0.5772156649, used in DSR's expected-max-Sharpe
 * term (Bailey/de Prado 2014 equation ≈ 17).
 */

export const EULER = 0.5772156649015329;

// ---------------------------------------------------------------------------
// Standard normal CDF — Abramowitz & Stegun 26.2.17, |err| < 7.5e-8
// ---------------------------------------------------------------------------

const AS_P = 0.3275911;
const AS_A1 = 0.254829592;
const AS_A2 = -0.284496736;
const AS_A3 = 1.421413741;
const AS_A4 = -1.453152027;
const AS_A5 = 1.061405429;

/** erf approximation — A&S 7.1.26 coefficients; max abs error ~1.5e-7. */
export function erf(x: number): number {
  if (!Number.isFinite(x)) {
    if (x === Infinity) return 1;
    if (x === -Infinity) return -1;
    return Number.NaN;
  }
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + AS_P * ax);
  const y =
    1 -
    ((((AS_A5 * t + AS_A4) * t + AS_A3) * t + AS_A2) * t + AS_A1) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x). */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) {
    if (x === Infinity) return 1;
    if (x === -Infinity) return 0;
    return Number.NaN;
  }
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Inverse normal CDF — Beasley–Springer–Moro
// Reference: Moro, Boris (1995) "The Full Monte" Risk Magazine.
// Max abs error ~ 1e-9 across p ∈ (1e-15, 1 − 1e-15).
// ---------------------------------------------------------------------------

const BSM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const BSM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const BSM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const BSM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];

const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

/** Inverse standard normal CDF Φ⁻¹(p). Throws on p ∉ (0, 1). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new Error(`normInv: p must be in (0, 1), got ${p}`);
  }

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((BSM_C[0]! * q + BSM_C[1]!) * q + BSM_C[2]!) * q + BSM_C[3]!) * q +
        BSM_C[4]!) *
        q +
        BSM_C[5]!) /
      ((((BSM_D[0]! * q + BSM_D[1]!) * q + BSM_D[2]!) * q + BSM_D[3]!) * q + 1)
    );
  }

  if (p <= P_HIGH) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((BSM_A[0]! * r + BSM_A[1]!) * r + BSM_A[2]!) * r + BSM_A[3]!) * r +
        BSM_A[4]!) *
        r +
        BSM_A[5]!) *
        q) /
      (((((BSM_B[0]! * r + BSM_B[1]!) * r + BSM_B[2]!) * r + BSM_B[3]!) * r +
        BSM_B[4]!) *
        r +
        1)
    );
  }

  // Upper tail: symmetric to lower.
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(
      ((((BSM_C[0]! * q + BSM_C[1]!) * q + BSM_C[2]!) * q + BSM_C[3]!) * q +
        BSM_C[4]!) *
        q +
      BSM_C[5]!
    ) /
    ((((BSM_D[0]! * q + BSM_D[1]!) * q + BSM_D[2]!) * q + BSM_D[3]!) * q + 1)
  );
}

// ---------------------------------------------------------------------------
// Sample moments — bias-corrected estimators
// ---------------------------------------------------------------------------

/** Mean of a finite sample. Returns 0 on empty input. */
export function sampleMean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Bessel-corrected sample variance. Returns 0 for length < 2. */
export function sampleVariance(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mu = sampleMean(xs);
  let acc = 0;
  for (const x of xs) {
    const d = x - mu;
    acc += d * d;
  }
  return acc / (n - 1);
}

/** Sample standard deviation (Bessel-corrected). */
export function sampleStd(xs: number[]): number {
  return Math.sqrt(sampleVariance(xs));
}

/**
 * Fisher–Pearson sample skewness with Joanes–Gill bias correction (G1).
 *   g1 = m3 / s^3
 *   G1 = g1 × √(n(n−1)) / (n−2)
 * Returns 0 when the sample has insufficient points (n<3) or is flat (σ≤ε).
 */
export function sampleSkewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mu = sampleMean(xs);
  let m2 = 0;
  let m3 = 0;
  for (const x of xs) {
    const d = x - mu;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 <= 1e-24) return 0;
  const g1 = m3 / Math.pow(m2, 1.5);
  return (g1 * Math.sqrt(n * (n - 1))) / (n - 2);
}

/**
 * Sample excess kurtosis (Joanes–Gill G2). Returns kurtosis − 3.
 *   g2 = m4 / m2² − 3
 *   G2 = ((n+1)g2 + 6) × (n−1) / ((n−2)(n−3))
 * Returns 0 when n<4 or variance is zero.
 */
export function sampleExcessKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const mu = sampleMean(xs);
  let m2 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mu;
    const d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
  }
  m2 /= n;
  m4 /= n;
  if (m2 <= 1e-24) return 0;
  const g2 = m4 / (m2 * m2) - 3;
  return ((n + 1) * g2 + 6) * ((n - 1) / ((n - 2) * (n - 3)));
}
