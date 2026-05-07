/**
 * Black-Litterman signal combiner — F7 portfolio-level posterior (v7.5 L5 / A8).
 *
 * Port of the closed-form Black-Litterman model to pure TS, matching the
 * He-Litterman (1999) reformulation that skfolio's
 * `prior/_black_litterman.py` ships. Combines a prior over expected
 * returns with multi-agent views weighted by confidence, producing a
 * posterior μ and Σ that downstream allocators (HRP, inverse-vol) consume.
 *
 * Why Black-Litterman is the right shape for F7's signal-blending:
 *   - Mean-variance is fragile to estimation error in raw signals.
 *   - BL treats each signal as a "view" with explicit uncertainty,
 *     letting confident views move the posterior more than vague ones.
 *   - The math is closed-form linear algebra (no solver), so it ships
 *     as a pure-TS port without breaking the no-deps invariant.
 *
 * Closed form (He-Litterman 1999 / skfolio reformulation):
 *   posterior_μ = inv(M) · (inv(τ·Σ)·π + Pᵀ·inv(Ω)·Q)
 *     where M = inv(τ·Σ) + Pᵀ·inv(Ω)·P
 *   posterior_Σ = Σ + inv(M)
 *
 * Idzorek 2005 contributes the confidence-percentage → Ω mapping used by
 * `blackLittermanFromSignals` below, not the closed form itself.
 *
 * Inputs:
 *   π  (N)      equilibrium returns (prior μ)
 *   Σ  (N×N)    prior covariance (symmetric, positive-definite)
 *   P  (K×N)    pick matrix (which assets each view applies to)
 *   Q  (K)      view magnitudes (the multi-agent signal numbers)
 *   Ω  (K×K)    view uncertainty (diagonal; lower = more confident)
 *   τ  scalar   prior scaling, typical 0.025-0.05
 *
 * The "no views" path (K=0) is supported and returns the prior
 * unchanged — useful when the upstream signal pipeline produces
 * nothing actionable for a given asset universe.
 */

import {
  matAdd,
  matInverse,
  matMul,
  matTranspose,
  matVecMul,
  diagMatrix,
} from "./matrix.js";

/** Per-asset signal from a multi-agent pipeline. Maps cleanly to a BL view. */
export interface AssetSignal {
  /** Asset symbol — matches one entry in `BlackLittermanInput.assets`. */
  asset: string;
  /** Signal magnitude. Positive = expected outperformance, negative = underperformance. */
  signal: number;
  /**
   * Confidence in [0, 1]. 0 = no view (drops the row); 1 = absolute
   * certainty (Ω diagonal collapses to ~0). Used to build Ω as
   * `diag(viewVariance / confidence)` so high-confidence views get
   * tight uncertainty bands.
   */
  confidence: number;
}

export interface BlackLittermanInput {
  /** Asset universe; the order pins column order of P, Σ, π. */
  assets: readonly string[];
  /** Equilibrium returns prior, length N. */
  pi: number[];
  /** Prior covariance, N×N. */
  Sigma: number[][];
  /** Pick matrix, K×N. Each row encodes one view's asset weights. */
  P: number[][];
  /** View magnitudes, length K. */
  Q: number[];
  /** View uncertainty, K×K diagonal. */
  Omega: number[][];
  /** Prior-scaling parameter; defaults to 0.025 (Idzorek). */
  tau?: number;
  /**
   * Singular-pivot threshold for the Gauss-Jordan inverses (`τ·Σ` and `M`).
   * Defaults to `1e-10`. Looser than `matInverse`'s default `1e-12` because
   * `τ·Σ` shrinks the prior eigenvalues by a factor of τ (~40× at default
   * τ=0.025) and a borderline-conditioned Σ can become near-singular under
   * scaling. Tighten for high-precision research; loosen if hitting
   * spurious singular-throw on regularization-light covariances.
   */
  epsilon?: number;
}

export interface BlackLittermanResult {
  /** Posterior μ (length N) — what F7 hands to allocators. */
  posteriorMu: number[];
  /** Posterior Σ (N×N). */
  posteriorSigma: number[][];
}

/** Idzorek 2005 baseline for τ; alternative range typically 0.01-0.05. */
const DEFAULT_TAU = 0.025;

/**
 * Default singular-pivot threshold for `matInverse`. Loose enough to
 * pass typical financial covariance matrices but tight enough to catch
 * genuinely rank-deficient input. Configurable via
 * `BlackLittermanInput.epsilon` for callers with extreme conditioning.
 */
const DEFAULT_EPSILON = 1e-10;

/**
 * Run Black-Litterman with already-built P, Q, Ω. For the typical
 * "list of asset signals → posterior" path use `blackLittermanFromSignals`
 * which handles the pick-matrix construction.
 */
export function blackLitterman(
  input: BlackLittermanInput,
): BlackLittermanResult {
  const {
    assets,
    pi,
    Sigma,
    P,
    Q,
    Omega,
    tau = DEFAULT_TAU,
    epsilon = DEFAULT_EPSILON,
  } = input;
  const N = assets.length;
  if (N === 0) throw new Error("blackLitterman: empty asset universe");
  if (pi.length !== N) {
    throw new Error(`blackLitterman: pi length ${pi.length} != N ${N}`);
  }
  if (Sigma.length !== N || Sigma.some((r) => r.length !== N)) {
    throw new Error(`blackLitterman: Sigma must be ${N}x${N}`);
  }
  if (!Number.isFinite(tau) || tau <= 0) {
    throw new Error(`blackLitterman: tau must be positive, got ${tau}`);
  }

  const K = Q.length;

  // No-views path: posterior == prior. Return early to avoid building
  // a degenerate K=0 system through inverse(Ω).
  if (K === 0) {
    if (P.length !== 0) {
      throw new Error(
        `blackLitterman: K=0 requires P to be empty, got P with ${P.length} rows`,
      );
    }
    return {
      posteriorMu: [...pi],
      posteriorSigma: deepCopyMatrix(Sigma),
    };
  }

  if (P.length !== K || P.some((r) => r.length !== N)) {
    throw new Error(
      `blackLitterman: P must be ${K}x${N}, got ${P.length}x${P[0]?.length ?? 0}`,
    );
  }
  if (Omega.length !== K || Omega.some((r) => r.length !== K)) {
    throw new Error(`blackLitterman: Omega must be ${K}x${K}`);
  }

  // 1. Scaled prior covariance: τ·Σ
  const tauSigma = scaleMatrix(Sigma, tau);

  // 2. Inverse pieces.
  //    Ω is diagonal in the standard BL formulation — element-wise inverse
  //    is exact and avoids the conditioning issues of full Gauss-Jordan
  //    on the K×K block. Falls back to full Gauss-Jordan if the caller
  //    supplies a non-diagonal Ω (audit W6 — a slight-correlation Ω
  //    should degrade gracefully, not hard-throw).
  const tauSigmaInv = matInverse(tauSigma, epsilon);
  let omegaInv: number[][];
  try {
    omegaInv = invertDiagonal(Omega);
  } catch (err) {
    if (err instanceof Error && /off-diagonal/.test(err.message)) {
      omegaInv = matInverse(Omega, epsilon);
    } else {
      throw err;
    }
  }

  // 3. M = inv(τ·Σ) + Pᵀ · inv(Ω) · P
  const Pt = matTranspose(P);
  const PtOmegaInv = matMul(Pt, omegaInv);
  const PtOmegaInvP = matMul(PtOmegaInv, P);
  const M = matAdd(tauSigmaInv, PtOmegaInvP);

  // 4. RHS = inv(τ·Σ)·π + Pᵀ·inv(Ω)·Q
  const tauSigmaInvPi = matVecMul(tauSigmaInv, pi);
  const PtOmegaInvQ = matVecMul(PtOmegaInv, Q);
  const rhs = vecAdd(tauSigmaInvPi, PtOmegaInvQ);

  // 5. Posterior μ = inv(M) · RHS
  const Minv = matInverse(M, epsilon);
  const posteriorMu = matVecMul(Minv, rhs);

  // 6. Posterior Σ = Σ + inv(M).
  //    The covariance is updated additively — the posterior is more
  //    uncertain than the prior because views inject uncertainty.
  const posteriorSigma = matAdd(Sigma, Minv);

  return { posteriorMu, posteriorSigma };
}

/**
 * Convenience wrapper that turns a list of `AssetSignal` entries into
 * BL inputs and runs the model. Handles:
 *   - filtering signals whose asset is not in `assets`
 *   - filtering signals with confidence ≤ 0 (no view)
 *   - building P (K×N) as one-hot rows per signal
 *   - building Ω diagonal as `viewVariance / confidence`, where
 *     `viewVariance` defaults to the asset's diagonal of Σ (the
 *     simplest reasonable scale tying view uncertainty to prior
 *     uncertainty)
 *
 * If no signals survive filtering, returns the prior unchanged.
 */
export function blackLittermanFromSignals(args: {
  assets: readonly string[];
  pi: number[];
  Sigma: number[][];
  signals: readonly AssetSignal[];
  tau?: number;
  epsilon?: number;
}): BlackLittermanResult {
  const { assets, pi, Sigma, signals, tau, epsilon } = args;
  const tauUsed = tau ?? DEFAULT_TAU;
  const indexOf = new Map<string, number>();
  for (let i = 0; i < assets.length; i++) indexOf.set(assets[i]!, i);

  const usable: Array<{ idx: number; signal: number; confidence: number }> = [];
  for (const s of signals) {
    const idx = indexOf.get(s.asset);
    if (idx === undefined) continue; // signal for unknown asset → drop
    if (!Number.isFinite(s.confidence) || s.confidence <= 0) continue;
    if (!Number.isFinite(s.signal)) continue;
    usable.push({
      idx,
      signal: s.signal,
      // Clamp confidence to (0, 1] so Ω never produces 0 or negative.
      confidence: Math.min(1, s.confidence),
    });
  }

  const K = usable.length;
  if (K === 0) {
    return blackLitterman({
      assets,
      pi,
      Sigma,
      P: [],
      Q: [],
      Omega: [],
      tau,
      epsilon,
    });
  }

  const N = assets.length;
  const P: number[][] = Array.from({ length: K }, () =>
    new Array<number>(N).fill(0),
  );
  const Q: number[] = new Array<number>(K);
  const omegaDiag: number[] = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    const u = usable[k]!;
    P[k]![u.idx] = 1;
    Q[k] = u.signal;
    // He-Litterman / Meucci convention: view variance scales as τ·σ²
    // so the view sits in the same scale as the prior's effective
    // covariance (τ·Σ). confidence=1 → ω = τ·σ² (view as uncertain as
    // the scaled prior); confidence=0.1 → ω = 10·τ·σ² (much wider
    // band, view contributes little). Audit W3/W4: previously used
    // bare σ², which under-weighted views vs. textbook BL by ~1/τ.
    const sigma2 = Sigma[u.idx]?.[u.idx] ?? 0;
    const variance = sigma2 > 0 ? sigma2 : 1;
    omegaDiag[k] = (tauUsed * variance) / u.confidence;
  }
  const Omega = diagMatrix(omegaDiag);

  return blackLitterman({
    assets,
    pi,
    Sigma,
    P,
    Q,
    Omega,
    tau,
    epsilon,
  });
}

/**
 * Reverse-optimize equilibrium returns from market weights:
 *   π = δ · Σ · w_market
 *
 * Used to build the BL prior when the operator can supply market-cap
 * weights but doesn't have an explicit equilibrium-return forecast.
 *
 * @param weights        market-cap weights (length N, non-negative, sum~1)
 * @param Sigma          covariance matrix (N×N)
 * @param riskAversion   δ scalar; common range 1-5, default 2.5
 */
export function equilibriumReturnsReverse(
  weights: number[],
  Sigma: number[][],
  riskAversion: number = 2.5,
): number[] {
  if (weights.length === 0) {
    throw new Error("equilibriumReturnsReverse: empty weights");
  }
  if (Sigma.length !== weights.length) {
    throw new Error(
      `equilibriumReturnsReverse: Sigma rows (${Sigma.length}) != weights length (${weights.length})`,
    );
  }
  if (!Number.isFinite(riskAversion) || riskAversion <= 0) {
    // Utility theory requires δ > 0; negative δ silently flips the sign
    // of π and produces a meaningless equilibrium. Audit W8.
    throw new Error(
      `equilibriumReturnsReverse: riskAversion must be a positive finite number, got ${riskAversion}`,
    );
  }
  const sw = matVecMul(Sigma, weights);
  return sw.map((x) => riskAversion * x);
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit tests / inspection
// ---------------------------------------------------------------------------

function deepCopyMatrix(M: number[][]): number[][] {
  return M.map((row) => [...row]);
}

function scaleMatrix(M: number[][], k: number): number[][] {
  return M.map((row) => row.map((v) => v * k));
}

function vecAdd(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`vecAdd: length mismatch ${a.length} vs ${b.length}`);
  }
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + b[i]!;
  return out;
}

/**
 * Element-wise diagonal-matrix inverse. Throws on non-square or
 * non-diagonal input (any off-diagonal value above EPSILON is rejected).
 *
 * Exported for tests.
 */
export function invertDiagonal(M: number[][]): number[][] {
  const n = M.length;
  if (n === 0) throw new Error("invertDiagonal: empty matrix");
  const epsilon = 1e-12;
  const out: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i++) {
    if (M[i]!.length !== n) {
      throw new Error(`invertDiagonal: row ${i} not length ${n}`);
    }
    for (let j = 0; j < n; j++) {
      const v = M[i]![j]!;
      if (i === j) {
        if (Math.abs(v) < epsilon) {
          throw new Error(
            `invertDiagonal: diagonal element [${i}] is ~0 (${v}); singular`,
          );
        }
        out[i]![i] = 1 / v;
      } else if (Math.abs(v) > epsilon) {
        throw new Error(
          `invertDiagonal: off-diagonal element [${i}][${j}] = ${v} (matrix not diagonal)`,
        );
      }
    }
  }
  return out;
}
