/**
 * F7 Alpha Combination Engine — 11-step pipeline orchestrator.
 *
 * See `docs/V7-ALPHA-COMBINATION-EQUATIONS.md` for the formal spec, and
 * `docs/planning/phase-beta/19-f7-impl-plan.md` for implementation decisions.
 *
 * The pipeline takes F3 market_signals firings + F1 market_data bars as
 * input, builds a return matrix R, runs the 11 FLAM steps, and produces
 * per-signal weights + Ingredient Signal Quality dimensions.
 *
 * Exclusion order (signals may be dropped at any stage, cascading):
 *   1. missing_data   — >5% flagged entries in R (premature)
 *   2. ic_le_zero     — rolling IC ≤ 0 (per addendum 8.4)
 *   3. flat_variance  — σ(i) ≤ 1e-6 after Step 3
 *   4. correlated     — max-correlation guard iteration
 *
 * Probability mode is stubbed: the column + schema exist, but the pipeline
 * throws NotImplementedError until F6.5.x ships probability time-series
 * persistence. Returns mode remain the default.
 */

import { randomUUID } from "node:crypto";
import {
  buildReturnMatrix,
  signalKey,
  parseSignalKey,
  type BarRow,
  type FiringRow,
} from "./alpha-matrix.js";
import {
  correlationMatrix,
  maxOffDiagonal,
  sampleMean,
  sampleVarianceBessel,
  scalarOlsNoIntercept,
} from "./alpha-linalg.js";
import {
  computeIsqAll,
  computePerSignalIC,
  todayInNewYork,
  type IsqDimensions,
} from "./alpha-isq.js";

// ---------------------------------------------------------------------------
// Config + defaults
// ---------------------------------------------------------------------------

export const F7_DEFAULTS = {
  windowM: 250,
  windowD: 20,
  horizon: 1,
  /** σ below this is considered flat → exclude from pipeline. */
  flatVarianceEpsilon: 1e-6,
  /** Max pair |correlation| allowed; above → iterative exclusion. */
  correlationThreshold: 0.95,
  /** Max correlation-guard exclusion iterations before aborting. */
  maxCorrelationIters: 3,
  /** Sum-of-squared-weights floor: protect N_effective = 1/Σw² denominator. */
  nEffectiveEpsilon: 1e-12,
  /** Minimum firings required for a signal's IC to be non-null. */
  minFiringsForIc: 30,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunAlphaOpts {
  mode: "returns" | "probability";
  firings: FiringRow[];
  bars: BarRow[];
  /** Watchlist size (denominator for ISQ coverage). */
  watchlistSize: number;
  /** F5 regime label at run time, or null. */
  regime: string | null;
  /** YYYY-MM-DD end of window (last period, inclusive). */
  asOf: string;
  windowM?: number;
  windowD?: number;
  horizon?: number;
  correlationThreshold?: number;
  flatVarianceEpsilon?: number;
  minFiringsForIc?: number;
  /** Optional UUID; auto-generated if not provided. */
  runId?: string;
  /** Injected for determinism in tests (today-in-NY computation). */
  now?: Date;
}

export interface AlphaRunSignalResult {
  signalKey: string;
  signalType: string;
  symbol: string;
  weight: number;
  epsilon: number | null;
  sigma: number | null;
  eNorm: number | null;
  ic30d: number | null;
  excluded: boolean;
  excludeReason:
    | "missing_data"
    | "ic_le_zero"
    | "flat_variance"
    | "correlated"
    | "singular"
    | null;
  isq: IsqDimensions | null;
}

export interface AlphaRunResult {
  runId: string;
  runTimestamp: string;
  mode: "returns" | "probability";
  regime: string | null;
  /** Total signals considered (before exclusion). */
  N: number;
  /** Excluded count. */
  NExcluded: number;
  /** Effective N from 1/Σw² (inverse participation ratio). */
  NEffective: number;
  /** Per-signal breakdown, one entry per signal (active + excluded). */
  signals: AlphaRunSignalResult[];
  /** Matrix-builder diagnostic flags, attached to the nearest signal_key. */
  flags: Array<{ signalKey: string; s: number; reason: string }>;
  durationMs: number;
}

export class F7CorrelatedSignalsError extends Error {
  readonly excluded: string[];
  constructor(excluded: string[]) {
    super(
      `F7 pipeline: correlation guard exhausted after ${excluded.length} iterations — remaining signals still exceed threshold`,
    );
    this.name = "F7CorrelatedSignalsError";
    this.excluded = excluded;
  }
}

export class F7ConfigError extends Error {
  constructor(msg: string) {
    super(`F7 pipeline: ${msg}`);
    this.name = "F7ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runAlphaCombination(opts: RunAlphaOpts): AlphaRunResult {
  const t0 = Date.now();

  if (opts.mode === "probability") {
    throw new Error(
      "F7 probability mode: not implemented in v1. Requires F6.5.x probability-timeseries persistence layer. See 19-f7-impl-plan.md §12.",
    );
  }

  const windowM = opts.windowM ?? F7_DEFAULTS.windowM;
  const windowD = opts.windowD ?? F7_DEFAULTS.windowD;
  const horizon = opts.horizon ?? F7_DEFAULTS.horizon;
  const correlationThreshold =
    opts.correlationThreshold ?? F7_DEFAULTS.correlationThreshold;
  const flatVarianceEpsilon =
    opts.flatVarianceEpsilon ?? F7_DEFAULTS.flatVarianceEpsilon;
  const minFiringsForIc = opts.minFiringsForIc ?? F7_DEFAULTS.minFiringsForIc;

  if (windowM < 3) {
    throw new F7ConfigError(
      `windowM must be >= 3 (got ${windowM}). Pipeline needs at least 2 post-truncation periods.`,
    );
  }
  if (windowD < 1 || windowD > windowM) {
    throw new F7ConfigError(
      `windowD must be in [1, windowM] (got ${windowD} for M=${windowM}).`,
    );
  }

  const runId = opts.runId ?? randomUUID();
  const runTimestamp = new Date().toISOString();

  // ---- Resolve M periods ending at asOf ----
  const periods = resolveTradingPeriods(opts.bars, opts.asOf, windowM);
  if (periods.length === 0) {
    return emptyResult({
      runId,
      runTimestamp,
      mode: opts.mode,
      regime: opts.regime,
      t0,
    });
  }

  // ---- Step 1: collect — build R matrix ----
  const matrix = buildReturnMatrix({
    firings: opts.firings,
    bars: opts.bars,
    periods,
    horizon,
  });
  const { R, N, M, signalKeys, symbolOfKey, typeOfKey } = matrix;

  if (N === 0) {
    return emptyResult({
      runId,
      runTimestamp,
      mode: opts.mode,
      regime: opts.regime,
      t0,
    });
  }

  // ---- Track active vs excluded signals ----
  const excludeReason: AlphaRunSignalResult["excludeReason"][] = new Array(
    N,
  ).fill(null);
  for (const i of matrix.excludePremature) {
    excludeReason[i] = "missing_data";
  }

  // ---- Build firingPeriods sets per signal ----
  const firingPeriods: Set<number>[] = Array.from(
    { length: N },
    () => new Set<number>(),
  );
  const periodIndex = new Map<string, number>();
  for (let s = 0; s < M; s++) periodIndex.set(periods[s]!, s);
  // Use indexOf once per unique signal_key by caching the mapping. At
  // production scale this avoids O(N × firings) indexOf sweeps (audit R7).
  const keyToIndex = new Map<string, number>();
  for (let i = 0; i < N; i++) keyToIndex.set(signalKeys[i]!, i);
  for (const f of opts.firings) {
    const key = signalKey(f.signal_type, f.symbol);
    const sIdx = periodIndex.get(f.triggered_at.slice(0, 10));
    if (sIdx == null) continue;
    const i = keyToIndex.get(key);
    if (i != null) firingPeriods[i]!.add(sIdx);
  }

  // Flagged periods per signal (audit W8 round 1) — so IC doesn't dilute
  // when a firing's forward close was missing or out-of-window.
  const flaggedPeriods: Set<number>[] = Array.from(
    { length: N },
    () => new Set<number>(),
  );
  for (const f of matrix.flags) {
    flaggedPeriods[f.i]!.add(f.s);
  }

  // ---- Compute IC filter ----
  const ic = computePerSignalIC({
    R,
    N,
    M,
    firingPeriods,
    flaggedPeriods,
    minFirings: minFiringsForIc,
  });
  for (let i = 0; i < N; i++) {
    if (excludeReason[i] != null) continue;
    const icI = ic[i];
    if (icI != null && icI <= 0) {
      excludeReason[i] = "ic_le_zero";
    }
  }

  // ---- Build active index list ----
  const initialActive = activeIndices(excludeReason);

  // ---- Step 2: serial demean on active signals ----
  // Also: Step 3: variance → exclude flat signals
  const sigmaArr: (number | null)[] = new Array(N).fill(null);
  const X: Record<number, number[]> = {}; // i → M-length row of demeaned R
  for (const i of initialActive) {
    const row = extractRow(R, i, M);
    const mean = sampleMean(row);
    const demeaned = row.map((v) => v - mean);
    X[i] = demeaned;
    const variance = sampleVarianceBessel(row); // equivalent to variance of demeaned
    const sigma = Math.sqrt(variance);
    sigmaArr[i] = sigma;
    if (sigma <= flatVarianceEpsilon) {
      excludeReason[i] = "flat_variance";
    }
  }

  // ---- Correlation guard iteration ----
  // Work on a mutable snapshot of still-active indices.
  let activeIdx = activeIndices(excludeReason);
  for (let iter = 0; iter < F7_DEFAULTS.maxCorrelationIters; iter++) {
    if (activeIdx.length < 2) break;
    const rows = activeIdx.map((i) => extractRow(R, i, M));
    const corr = correlationMatrix(rows);
    const worst = maxOffDiagonal(corr);
    if (!worst || Math.abs(worst.value) <= correlationThreshold) break;
    // Choose which of the pair to drop: lower-IC signal (or lexicographically-later key if tied)
    const iLocal = worst.i;
    const jLocal = worst.j;
    const iIdx = activeIdx[iLocal]!;
    const jIdx = activeIdx[jLocal]!;
    const icI = ic[iIdx];
    const icJ = ic[jIdx];
    // Normalize nulls to -Infinity so null-IC signals are preferred for dropping
    const scoreI = icI == null ? -Infinity : icI;
    const scoreJ = icJ == null ? -Infinity : icJ;
    let toDrop: number;
    if (scoreI < scoreJ) toDrop = iIdx;
    else if (scoreJ < scoreI) toDrop = jIdx;
    else {
      // Tie: drop the lexicographically-later signal_key
      toDrop = signalKeys[iIdx]! > signalKeys[jIdx]! ? iIdx : jIdx;
    }
    excludeReason[toDrop] = "correlated";
    activeIdx = activeIndices(excludeReason);
  }

  // One final check — if we're still above threshold after max iterations, abort
  if (activeIdx.length >= 2) {
    const rows = activeIdx.map((i) => extractRow(R, i, M));
    const corr = correlationMatrix(rows);
    const worst = maxOffDiagonal(corr);
    if (worst && Math.abs(worst.value) > correlationThreshold) {
      const excluded = Object.entries(excludeReason)
        .filter(([, r]) => r === "correlated")
        .map(([i]) => signalKeys[Number(i)]!);
      throw new F7CorrelatedSignalsError(excluded);
    }
  }

  // ---- Step 4: normalize Y = X/σ ----
  const Y: Record<number, number[]> = {};
  for (const i of activeIdx) {
    const sigma = sigmaArr[i]!;
    Y[i] = X[i]!.map((v) => v / sigma);
  }

  // ---- Step 5: drop most recent observation → length M-1 ----
  // ---- Step 6: cross-sectional demean at each period → Λ ----
  const M1 = M - 1;
  if (M1 < 1) {
    // Degenerate window — no periods remain after truncation
    return buildResult({
      runId,
      runTimestamp,
      mode: opts.mode,
      regime: opts.regime,
      signalKeys,
      symbolOfKey,
      typeOfKey,
      N,
      NEffective: 0,
      activeIdx: [],
      weights: new Map(),
      epsilons: new Map(),
      sigmas: sigmaArr,
      eNorms: new Map(),
      ic,
      excludeReason,
      isqList: [],
      flags: matrix.flags.map((f) => ({
        signalKey: signalKeys[f.i]!,
        s: f.s,
        reason: f.reason,
      })),
      t0,
    });
  }
  const Lambda: Record<number, number[]> = {};
  for (const i of activeIdx) Lambda[i] = Y[i]!.slice(0, M1);
  // Cross-sectional demean — at each s ∈ [0..M1), subtract mean across active signals
  for (let s = 0; s < M1; s++) {
    let sum = 0;
    for (const i of activeIdx) sum += Lambda[i]![s]!;
    const mean = sum / activeIdx.length;
    for (const i of activeIdx) Lambda[i]![s] = Lambda[i]![s]! - mean;
  }

  // ---- Step 7: cross-sectional zero-sum invariant check ----
  // After Step 6's cross-sectional demean, Σ_i Λ(i,s) = 0 must hold for every
  // period s across active signals. A trivial `length === M1` check would
  // always pass by construction of Λ = Y.slice(0, M1); this check catches
  // cases where an excluded signal's row leaked into cross-section computation
  // (caught by audit C2 round 1).
  const INVARIANT_TOL = 1e-9 * Math.max(activeIdx.length, 1);
  for (let s = 0; s < M1; s++) {
    let sum = 0;
    for (const i of activeIdx) sum += Lambda[i]![s]!;
    if (Math.abs(sum) > INVARIANT_TOL) {
      throw new Error(
        `Step 7 invariant violated: cross-sectional sum at period ${s} is ${sum.toExponential(3)} (tol ${INVARIANT_TOL.toExponential(3)})`,
      );
    }
  }

  // ---- Step 8: forward expected return E(i) over last d periods ----
  const eNorm: Map<number, number> = new Map();
  for (const i of activeIdx) {
    const row = extractRow(R, i, M);
    const tail = row.slice(Math.max(0, M - windowD));
    const eRaw = sampleMean(tail);
    eNorm.set(i, eRaw / sigmaArr[i]!);
  }

  // ---- Step 9: Fama-MacBeth scalar-β OLS → ε(i) ----
  const lambdaBar = activeIdx.map((i) => sampleMean(Lambda[i]!));
  const eNormVec = activeIdx.map((i) => eNorm.get(i)!);
  const olsRes = scalarOlsNoIntercept(lambdaBar, eNormVec);
  const epsilons = new Map<number, number>();
  for (let k = 0; k < activeIdx.length; k++) {
    epsilons.set(activeIdx[k]!, olsRes.residuals[k]!);
  }

  // ---- Step 10: w_raw(i) = ε(i) / σ(i) ----
  const wRaw: Map<number, number> = new Map();
  for (const i of activeIdx) {
    wRaw.set(i, epsilons.get(i)! / sigmaArr[i]!);
  }

  // ---- Step 11: normalize Σ|w| = 1 ----
  let sumAbs = 0;
  for (const w of wRaw.values()) sumAbs += Math.abs(w);
  const weights = new Map<number, number>();
  if (sumAbs > 0) {
    for (const [i, w] of wRaw) weights.set(i, w / sumAbs);
  } else {
    // All residuals zero — distribute equal weight across active signals
    const equal = activeIdx.length > 0 ? 1 / activeIdx.length : 0;
    for (const i of activeIdx) weights.set(i, equal);
  }

  // ---- N_effective = 1 / Σw² ----
  let sumSq = 0;
  for (const w of weights.values()) sumSq += w * w;
  const NEffective = sumSq > F7_DEFAULTS.nEffectiveEpsilon ? 1 / sumSq : 0;

  // ---- ISQ per active signal ----
  const firedTodayFlag = new Array<boolean>(N).fill(false);
  const today = todayInNewYork(opts.now);
  for (const f of opts.firings) {
    if (f.triggered_at.slice(0, 10) === today) {
      const key = signalKey(f.signal_type, f.symbol);
      const i = keyToIndex.get(key);
      if (i != null) firedTodayFlag[i] = true;
    }
  }
  // Coverage dimension: per signal_type, count distinct symbols that survived
  // exclusion. Audit W4: counting ALL firings (including excluded signals) would
  // inflate coverage when a type's firings were dropped for missing_data.
  const activeSignalKeys = new Set(activeIdx.map((i) => signalKeys[i]!));
  const typeSymbolCounts = new Map<string, number>();
  {
    const typeSymbols = new Map<string, Set<string>>();
    for (const f of opts.firings) {
      if (!periodIndex.has(f.triggered_at.slice(0, 10))) continue;
      const key = signalKey(f.signal_type, f.symbol);
      if (!activeSignalKeys.has(key)) continue;
      if (!typeSymbols.has(f.signal_type)) {
        typeSymbols.set(f.signal_type, new Set());
      }
      typeSymbols.get(f.signal_type)!.add(f.symbol);
    }
    for (const [t, syms] of typeSymbols) typeSymbolCounts.set(t, syms.size);
  }
  const epsFull: number[] = new Array(N).fill(0);
  const sigFull: number[] = new Array(N).fill(0);
  for (const i of activeIdx) {
    epsFull[i] = epsilons.get(i) ?? 0;
    sigFull[i] = sigmaArr[i] ?? 0;
  }
  const allIsq = computeIsqAll({
    N,
    R,
    M,
    epsilon: epsFull,
    sigma: sigFull,
    ic,
    firingPeriods,
    firedToday: firedTodayFlag,
    typeSymbolCounts,
    typeOfSignal: typeOfKey,
    watchlistSize: opts.watchlistSize,
  });
  // Excluded signals get ISQ = null
  const isqList: (IsqDimensions | null)[] = new Array(N).fill(null);
  for (const i of activeIdx) isqList[i] = allIsq[i]!;

  return buildResult({
    runId,
    runTimestamp,
    mode: opts.mode,
    regime: opts.regime,
    signalKeys,
    symbolOfKey,
    typeOfKey,
    N,
    NEffective,
    activeIdx,
    weights,
    epsilons,
    sigmas: sigmaArr,
    eNorms: eNorm,
    ic,
    excludeReason,
    isqList,
    flags: matrix.flags.map((f) => ({
      signalKey: signalKeys[f.i]!,
      s: f.s,
      reason: f.reason,
    })),
    t0,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRow(R: Float64Array, i: number, M: number): number[] {
  const out = new Array<number>(M);
  for (let s = 0; s < M; s++) out[s] = R[i * M + s]!;
  return out;
}

function activeIndices(
  excludeReason: AlphaRunSignalResult["excludeReason"][],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < excludeReason.length; i++) {
    if (excludeReason[i] == null) out.push(i);
  }
  return out;
}

function resolveTradingPeriods(
  bars: BarRow[],
  asOf: string,
  M: number,
): string[] {
  const asOfDay = asOf.slice(0, 10);
  const set = new Set<string>();
  for (const b of bars) {
    const d = b.timestamp.slice(0, 10);
    if (d <= asOfDay) set.add(d);
  }
  const sorted = Array.from(set).sort();
  return sorted.length <= M ? sorted : sorted.slice(sorted.length - M);
}

function emptyResult(o: {
  runId: string;
  runTimestamp: string;
  mode: "returns" | "probability";
  regime: string | null;
  t0: number;
}): AlphaRunResult {
  return {
    runId: o.runId,
    runTimestamp: o.runTimestamp,
    mode: o.mode,
    regime: o.regime,
    N: 0,
    NExcluded: 0,
    NEffective: 0,
    signals: [],
    flags: [],
    durationMs: Date.now() - o.t0,
  };
}

function buildResult(args: {
  runId: string;
  runTimestamp: string;
  mode: "returns" | "probability";
  regime: string | null;
  signalKeys: string[];
  symbolOfKey: string[];
  typeOfKey: string[];
  N: number;
  NEffective: number;
  activeIdx: number[];
  weights: Map<number, number>;
  epsilons: Map<number, number>;
  sigmas: (number | null)[];
  eNorms: Map<number, number>;
  ic: (number | null)[];
  excludeReason: AlphaRunSignalResult["excludeReason"][];
  isqList: (IsqDimensions | null)[];
  flags: Array<{ signalKey: string; s: number; reason: string }>;
  t0: number;
}): AlphaRunResult {
  const signals: AlphaRunSignalResult[] = [];
  let excludedCount = 0;
  for (let i = 0; i < args.N; i++) {
    const parsed = parseSignalKey(args.signalKeys[i]!);
    const reason = args.excludeReason[i];
    const excluded = reason != null;
    if (excluded) excludedCount++;
    signals.push({
      signalKey: args.signalKeys[i]!,
      signalType: parsed.type,
      symbol: parsed.symbol,
      weight: excluded ? 0 : (args.weights.get(i) ?? 0),
      epsilon: excluded ? null : (args.epsilons.get(i) ?? null),
      sigma:
        excluded && reason !== "flat_variance"
          ? null
          : (args.sigmas[i] ?? null),
      eNorm: excluded ? null : (args.eNorms.get(i) ?? null),
      ic30d: args.ic[i] ?? null,
      excluded,
      excludeReason: reason,
      isq: args.isqList[i] ?? null,
    });
  }
  return {
    runId: args.runId,
    runTimestamp: args.runTimestamp,
    mode: args.mode,
    regime: args.regime,
    N: args.N,
    NExcluded: excludedCount,
    NEffective: args.NEffective,
    signals,
    flags: args.flags,
    durationMs: Date.now() - args.t0,
  };
}
