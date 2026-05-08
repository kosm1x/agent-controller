/**
 * Portfolio allocators — F7 M1 (v7.5 leftovers L4 / Session 69 skfolio port).
 *
 * Pure-TS, no-deps allocators that turn a returns matrix into per-asset
 * weights summing to 1. Two baselines ship in this file (equal-weight,
 * inverse-volatility); HRP lives in `hrp.ts` and uses the same
 * `varianceVector` helper to keep the math source-of-truth single.
 *
 * Convention: returns matrix is T×N (rows=time-period, cols=asset). This
 * matches every finance library on earth (skfolio, pandas, R quantmod).
 *
 * All functions:
 *   - return long-only weights summing to exactly 1.0
 *   - degrade gracefully on edge cases (empty input, zero variance)
 *   - throw on shape inconsistency (rows of unequal length, etc.)
 */

import { sampleVarianceBessel } from "./alpha-linalg.js";

/** Throw if input is not a non-empty rectangular T×N matrix. */
function assertReturnsShape(returns: number[][], fnName: string): void {
  if (!Array.isArray(returns) || returns.length === 0) {
    throw new Error(`${fnName}: empty returns matrix`);
  }
  const N = returns[0]!.length;
  if (N === 0) {
    throw new Error(`${fnName}: returns matrix has zero columns`);
  }
  for (let t = 1; t < returns.length; t++) {
    if (returns[t]!.length !== N) {
      throw new Error(
        `${fnName}: row ${t} has ${returns[t]!.length} cols, expected ${N}`,
      );
    }
  }
}

/**
 * Equal-weight allocator: 1/N for every asset. The simplest possible
 * baseline — nothing to estimate, no failure modes. Often beats more
 * sophisticated allocators out-of-sample (DeMiguel et al. 2009).
 */
export function equalWeight(N: number): number[] {
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error(`equalWeight: N must be a positive integer, got ${N}`);
  }
  const w = 1 / N;
  return new Array<number>(N).fill(w);
}

/**
 * Sample covariance matrix from a T×N returns matrix. Uses Bessel's
 * correction (n-1 denominator) so it stays consistent with `varianceVector`
 * — `covarianceMatrix(returns)[i][i]` equals `varianceVector(returns)[i]`
 * exactly.
 *
 * Exists so callers wiring HRP → Black-Litterman through
 * `equilibriumReturnsReverse` use a single math source for Σ instead of
 * authoring inline covariance helpers in test files (v7.6 Spine 6 round-1
 * audit W3 fix).
 *
 * Output: N×N symmetric matrix. Σ[i][i] is sample variance; Σ[i][j] is
 * sample covariance with Bessel correction.
 */
export function covarianceMatrix(returns: number[][]): number[][] {
  assertReturnsShape(returns, "covarianceMatrix");
  const T = returns.length;
  const N = returns[0]!.length;
  if (T < 2) {
    // Bessel correction divides by (T-1); a single observation has no
    // sample covariance in this convention. Return all-zeros so callers
    // get a defined shape rather than NaN.
    return Array.from({ length: N }, () => new Array<number>(N).fill(0));
  }
  // Per-asset means (one pass)
  const means = new Array<number>(N).fill(0);
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) means[i]! += returns[t]![i]!;
  }
  for (let i = 0; i < N; i++) means[i]! /= T;

  const Sigma: number[][] = Array.from({ length: N }, () =>
    new Array<number>(N).fill(0),
  );
  for (let t = 0; t < T; t++) {
    const row = returns[t]!;
    for (let i = 0; i < N; i++) {
      const di = row[i]! - means[i]!;
      for (let j = i; j < N; j++) {
        Sigma[i]![j]! += di * (row[j]! - means[j]!);
      }
    }
  }
  const denom = T - 1;
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      const v = Sigma[i]![j]! / denom;
      Sigma[i]![j] = v;
      Sigma[j]![i] = v;
    }
  }
  return Sigma;
}

/**
 * Per-asset variance vector from a T×N returns matrix. Uses Bessel's
 * correction (n-1 denominator). Zero-variance assets are returned as 0.
 *
 * Exported because both inverse-volatility and HRP need this helper and
 * we want a single math-truth source.
 */
export function varianceVector(returns: number[][]): number[] {
  assertReturnsShape(returns, "varianceVector");
  const T = returns.length;
  const N = returns[0]!.length;
  const out = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const col = new Array<number>(T);
    for (let t = 0; t < T; t++) col[t] = returns[t]![i]!;
    out[i] = sampleVarianceBessel(col);
  }
  return out;
}

/**
 * Inverse-volatility allocator: w_i ∝ 1 / σ_i, then normalize to sum=1.
 * Risk-parity in 1D — every asset contributes equal volatility to the
 * portfolio (under the assumption of zero correlation).
 *
 * Edge cases:
 *   - Asset with zero variance gets a non-zero weight via the residual
 *     pool (otherwise it would dominate the inverse). We treat
 *     zero-variance assets as if they had the median variance of the
 *     remaining assets — keeps them in the portfolio at "average" risk.
 *   - All assets zero-variance → falls back to equal-weight.
 */
export function inverseVolatility(returns: number[][]): number[] {
  assertReturnsShape(returns, "inverseVolatility");
  const N = returns[0]!.length;
  const variances = varianceVector(returns);

  // Median of non-zero variances; used to substitute for zero-variance assets.
  const nonZero = variances.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) {
    // All flat — degenerate; equal-weight is the only sensible answer.
    return equalWeight(N);
  }
  const medianVar =
    nonZero.length % 2 === 1
      ? nonZero[(nonZero.length - 1) / 2]!
      : 0.5 * (nonZero[nonZero.length / 2 - 1]! + nonZero[nonZero.length / 2]!);

  const inv = new Array<number>(N);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const v = variances[i]! > 0 ? variances[i]! : medianVar;
    const sigma = Math.sqrt(v);
    const x = sigma > 0 ? 1 / sigma : 0;
    inv[i] = x;
    total += x;
  }
  if (total === 0) return equalWeight(N);

  // Normalize so weights sum to exactly 1. Last asset absorbs rounding
  // error so the sum invariant holds bit-exact for integration tests.
  const w = new Array<number>(N);
  let runningSum = 0;
  for (let i = 0; i < N - 1; i++) {
    w[i] = inv[i]! / total;
    runningSum += w[i]!;
  }
  w[N - 1] = 1 - runningSum;
  return w;
}
