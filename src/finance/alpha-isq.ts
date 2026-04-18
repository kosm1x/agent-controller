/**
 * F7 — Ingredient Signal Quality (ISQ) dimensions.
 *
 * Per signal, per run, five quality dimensions in [0, 1] (higher = better):
 *
 *   efficiency   — share of raw weight that survived normalization
 *   timeliness   — 1.0 if signal fired today (NY), 0.5 otherwise
 *   coverage     — fraction of watchlist the signal's type has fired on
 *   stability    — 1 − (std(IC) / |mean(IC)|) measured across sub-windows
 *   forward_ic   — IC remapped from [−0.15, +0.15] → [0, 1]
 *
 * IC in this module is a simplified realized-edge metric:
 *
 *   IC_signal(i) = mean(R(i, s) for firing days s)
 *
 * where R is already direction-adjusted by the matrix builder (positive →
 * signal was correct about next-bar direction). Values are typically in
 * [-0.10, +0.10] for real signals; we clamp at ±0.15 to cap the forward_ic
 * dimension at 0 or 1.
 *
 * Rationale for the simplified IC definition: classical IC requires a
 * cross-sectional ranking universe and continuous signal scores. Our
 * signals are binary events tied to individual symbols, so we use the
 * mean direction-adjusted realized return on firing days as a stand-in.
 * Formal Pearson IC can be layered on later if F7.5 backtester needs it.
 *
 * All functions pure. No I/O.
 */

import {
  clamp,
  correlation,
  sampleMean,
  sampleVarianceBessel,
} from "./alpha-linalg.js";

const IC_CLAMP_BOUND = 0.15;

// ---------------------------------------------------------------------------
// Date helpers — America/New_York
// ---------------------------------------------------------------------------

/** Return today's YYYY-MM-DD in America/New_York. DST-safe via Intl.DateTimeFormat. */
export function todayInNewYork(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Per-signal IC
// ---------------------------------------------------------------------------

export interface PerSignalIcInput {
  /** Flat N*M return matrix from buildReturnMatrix. */
  R: Float64Array;
  N: number;
  M: number;
  /**
   * Per-signal set of period indices where the signal actually fired.
   * Length N; each inner set contains s-indices for signal i.
   */
  firingPeriods: Set<number>[];
  /**
   * Per-signal set of period indices that were FLAGGED in R (stored as 0
   * because the forward close was missing or out-of-window). These are firing
   * days that the matrix builder could not produce a realized return for.
   * Length N. Optional — defaults to empty sets (audit W8, round 1).
   */
  flaggedPeriods?: Set<number>[];
  /** Minimum number of firings required to compute IC; below this returns null. */
  minFirings?: number;
}

/**
 * Compute IC per signal as the mean of direction-adjusted returns on firing
 * days, EXCLUDING flagged-zero cells (missing-close / out-of-window). Flagged
 * cells carry no signal — including them as zeros dilutes IC toward 0 and can
 * flip borderline-positive signals into the ic_le_zero exclusion bucket
 * (audit W8, round 1).
 *
 * Returns `null` for signals with fewer than `minFirings` (default 30) valid
 * firings in the window — these signals are admitted without an IC-filter
 * verdict per the addendum's "benefit of the doubt" window.
 */
export function computePerSignalIC(input: PerSignalIcInput): (number | null)[] {
  const minFirings = input.minFirings ?? 30;
  const { R, N, M, firingPeriods } = input;
  const flagged = input.flaggedPeriods;
  const out: (number | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    const fires = firingPeriods[i];
    if (!fires) {
      out[i] = null;
      continue;
    }
    const flaggedI = flagged?.[i];
    let sum = 0;
    let count = 0;
    for (const s of fires) {
      if (s < 0 || s >= M) continue;
      if (flaggedI && flaggedI.has(s)) continue; // skip flagged-zero cells
      const v = R[i * M + s]!;
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count < minFirings) {
      out[i] = null;
      continue;
    }
    out[i] = sum / count;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ISQ per signal
// ---------------------------------------------------------------------------

export interface IsqInputs {
  N: number;
  /** Flat N*M return matrix. Used for stability sub-window IC. */
  R: Float64Array;
  M: number;
  /** Per-signal residuals ε from Step 9. Length N. */
  epsilon: number[];
  /** Per-signal σ from Step 3. Length N. Zero or null for excluded signals. */
  sigma: number[];
  /** Per-signal IC; null = insufficient data. Length N. */
  ic: (number | null)[];
  /** Per-signal firing period indices. Length N. */
  firingPeriods: Set<number>[];
  /** Did signal i fire "today"? Length N. */
  firedToday: boolean[];
  /**
   * Per-signal_type count of DISTINCT symbols that have fired within the
   * window. Used to compute coverage. Key = signal_type, value = count.
   */
  typeSymbolCounts: Map<string, number>;
  /** Parallel to signals: the type each signal belongs to. Length N. */
  typeOfSignal: string[];
  /** Total number of watchlist symbols (for coverage denominator). */
  watchlistSize: number;
}

export interface IsqDimensions {
  efficiency: number;
  timeliness: number;
  coverage: number;
  stability: number;
  forward_ic: number;
}

/**
 * Compute ISQ for all N signals. Returns length-N array of dimension bags.
 * All dimensions are clamped to [0, 1].
 */
export function computeIsqAll(inputs: IsqInputs): IsqDimensions[] {
  const { N, epsilon, sigma, ic, firingPeriods, firedToday } = inputs;

  // Σ|ε| — denominator for efficiency
  let sumAbsEpsilon = 0;
  for (let i = 0; i < N; i++) sumAbsEpsilon += Math.abs(epsilon[i] ?? 0);

  const out: IsqDimensions[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const epsI = epsilon[i] ?? 0;
    const sigI = sigma[i] ?? 0;
    const wRaw = sigI > 0 ? epsI / sigI : 0;

    const efficiency =
      sumAbsEpsilon > 0 ? clamp(Math.abs(wRaw) / sumAbsEpsilon, 0, 1) : 0;

    const timeliness = firedToday[i] ? 1.0 : 0.5;

    const type = inputs.typeOfSignal[i] ?? "";
    const symbolsForType = inputs.typeSymbolCounts.get(type) ?? 0;
    const coverage =
      inputs.watchlistSize > 0
        ? clamp(symbolsForType / inputs.watchlistSize, 0, 1)
        : 0;

    const stability = computeStability(
      inputs.R,
      i,
      inputs.M,
      firingPeriods[i] ?? new Set<number>(),
    );

    const icI = ic[i];
    const forward_ic =
      icI == null
        ? 0.5 // null/benefit-of-doubt midpoint
        : clamp((icI + IC_CLAMP_BOUND) / (2 * IC_CLAMP_BOUND), 0, 1);

    out[i] = { efficiency, timeliness, coverage, stability, forward_ic };
  }
  return out;
}

/**
 * Stability sub-metric: divide the window into 3 equal sub-windows, compute
 * the mean direction-adjusted return on firing days in each, then score
 * `1 - std/|mean|` (capped). Returns 0.5 when firings are too sparse to
 * judge (no information, not a penalty).
 */
function computeStability(
  R: Float64Array,
  i: number,
  M: number,
  firings: Set<number>,
): number {
  if (M < 3 || firings.size < 3) return 0.5;
  const third = Math.floor(M / 3);
  const subMeans: number[] = [];
  for (let w = 0; w < 3; w++) {
    const lo = w * third;
    const hi = w === 2 ? M : (w + 1) * third;
    let sum = 0;
    let count = 0;
    for (const s of firings) {
      if (s >= lo && s < hi) {
        sum += R[i * M + s]!;
        count++;
      }
    }
    if (count > 0) subMeans.push(sum / count);
  }
  if (subMeans.length < 2) return 0.5;
  const mean = sampleMean(subMeans);
  const std = Math.sqrt(sampleVarianceBessel(subMeans));
  const denom = Math.max(Math.abs(mean), 0.01);
  return clamp(1 - std / denom, 0, 1);
}

// Re-export from alpha-linalg for any caller that wants the same helper family.
export { correlation };
