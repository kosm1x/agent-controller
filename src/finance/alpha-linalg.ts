/**
 * F7 Alpha Combination — linear-algebra primitives.
 *
 * Step 9 of the 11-step FLAM pipeline regresses the N-vector E_norm on a
 * single feature per signal (the time-average of Λ). This is the
 * Fama-MacBeth-style reading of Step 9 that matches the `06-f7-math-study.md`
 * worked example exactly when M=2. For multi-period (M>2) the time-average
 * collapses Λ into a length-N vector Λ_bar, and the regression reduces to
 * scalar-β no-intercept OLS:
 *
 *   β        = Σ (E_norm(i) · Λ_bar(i)) / Σ (Λ_bar(i))²
 *   ε(i)     = E_norm(i) − β · Λ_bar(i)
 *
 * Rationale: the naive `N × (M−1)` multivariate regression is underdetermined
 * at F7 production sizes (N≈15, M−1=249 → (M−1) >> N, ΛᵀΛ rank-deficient by
 * construction). The scalar-β interpretation is stable for any (N, M) and
 * degenerates cleanly to β=0 when Σ Λ_bar² ≤ ε.
 *
 * The doubling-count concern the addendum's condition-number check was meant
 * to address is handled at a different layer (correlation-guard on raw
 * returns in `alpha-combination.ts`, using `correlationMatrix()` below).
 *
 * All functions pure. No mutation. No I/O. No deps.
 */

export interface ScalarOlsResult {
  /** β scalar; 0 if Σx² ≤ epsilon (degenerate case). */
  beta: number;
  /** residuals[i] = y[i] − β · x[i]. */
  residuals: number[];
  /** Sum of squared x; useful for diagnostics. */
  sumXSquared: number;
}

const DENOM_EPSILON = 1e-12;

/** Dot product. Throws on length mismatch. */
export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`dot: length mismatch (${a.length} vs ${b.length})`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Arithmetic mean. Returns 0 for empty input. */
export function sampleMean(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s / a.length;
}

/**
 * Sample variance with Bessel's correction: (1/(n−1)) Σ (x − mean)².
 * Returns 0 for n ≤ 1 (no degrees of freedom).
 */
export function sampleVarianceBessel(a: number[]): number {
  if (a.length <= 1) return 0;
  const mean = sampleMean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - mean;
    s += d * d;
  }
  return s / (a.length - 1);
}

/**
 * Per-row time average of an N×M matrix. Returns length-N vector where
 * out[i] = (1/M) Σ_s matrix[i][s]. Empty rows produce 0.
 */
export function timeMeanMatrix(matrix: number[][]): number[] {
  return matrix.map((row) => sampleMean(row));
}

/**
 * Scalar-β no-intercept OLS:  y(i) ≈ β · x(i) + ε(i).
 * β = Σ(x · y) / Σ(x²), residuals = y − β·x.
 * If Σx² ≤ DENOM_EPSILON, returns β=0, residuals=y (passthrough).
 */
export function scalarOlsNoIntercept(
  x: number[],
  y: number[],
): ScalarOlsResult {
  if (x.length !== y.length) {
    throw new Error(
      `scalarOlsNoIntercept: length mismatch (${x.length} vs ${y.length})`,
    );
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += x[i]! * y[i]!;
    den += x[i]! * x[i]!;
  }
  if (den <= DENOM_EPSILON) {
    return { beta: 0, residuals: y.slice(), sumXSquared: den };
  }
  const beta = num / den;
  const residuals = new Array<number>(y.length);
  for (let i = 0; i < y.length; i++) residuals[i] = y[i]! - beta * x[i]!;
  return { beta, residuals, sumXSquared: den };
}

/**
 * Pearson correlation coefficient between two equal-length vectors.
 * Returns 0 if either vector is flat (zero variance).
 */
export function correlation(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `correlation: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  if (a.length < 2) return 0;
  const ma = sampleMean(a);
  const mb = sampleMean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= DENOM_EPSILON || vb <= DENOM_EPSILON) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Correlation matrix over row time-series. Input is N×M (each row = a
 * signal's M-length return series). Output is N×N symmetric with diag=1.
 * A row with zero variance produces zero correlations with every other row.
 */
export function correlationMatrix(rows: number[][]): number[][] {
  const n = rows.length;
  const out: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i++) {
    out[i]![i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = correlation(rows[i]!, rows[j]!);
      out[i]![j] = c;
      out[j]![i] = c;
    }
  }
  return out;
}

export interface OffDiagonalPair {
  i: number;
  j: number;
  /** Signed correlation value at (i,j). Use `Math.abs` for magnitude comparisons. */
  value: number;
}

/**
 * Find the off-diagonal entry with the largest absolute value. Ties broken
 * by lower (i, j) for determinism. Returns null if matrix is 1×1 or empty.
 */
export function maxOffDiagonal(corr: number[][]): OffDiagonalPair | null {
  const n = corr.length;
  if (n < 2) return null;
  let best: OffDiagonalPair | null = null;
  let bestAbs = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = corr[i]![j]!;
      const abs = Math.abs(v);
      if (abs > bestAbs) {
        bestAbs = abs;
        best = { i, j, value: v };
      }
    }
  }
  return best;
}

/** Return a new array with index `idx` removed. Does not mutate input. */
export function removeIndex<T>(vec: T[], idx: number): T[] {
  if (idx < 0 || idx >= vec.length) {
    throw new Error(`removeIndex: out of bounds ${idx} (length ${vec.length})`);
  }
  const out = new Array<T>(vec.length - 1);
  for (let i = 0, j = 0; i < vec.length; i++) {
    if (i === idx) continue;
    out[j++] = vec[i]!;
  }
  return out;
}

/** Return a new matrix with row `idx` removed. Does not mutate input. */
export function removeRow<T>(matrix: T[][], idx: number): T[][] {
  return removeIndex(matrix, idx);
}

/** Numeric clamp. */
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
