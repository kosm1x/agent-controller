/**
 * F7.5 Strategy Backtester — Combinatorial Purged Cross-Validation.
 *
 * Reference: de Prado, "Advances in Financial Machine Learning" ch.12.
 *
 * Partition the available bar history into N contiguous groups of roughly
 * equal length. For each combination of k test groups, the remaining N-k
 * form training. An embargo of `horizon` bars is purged on both sides of
 * every train-boundary adjacent to a test group, to prevent label leakage.
 *
 * Per (trial, fold):
 *   1. Compose train bars/firings from non-test groups (with embargo cut).
 *   2. Run F7 at asOf = last train bar → weights.
 *   3. IS Sharpe: apply weights over train bars.
 *   4. OOS Sharpe: apply same weights over test bars (concatenated).
 *
 * The engine never "retrains" inside a fold — F7's one-shot run on the
 * training observations IS the "predictor produced from non-test data".
 *
 * Weekly-first semantics (operator lock, 2026-04-18): bars are weekly,
 * Sharpe annualized by √52. embargo defaults to `horizon` weekly bars.
 */

import {
  F7_DEFAULTS,
  F7CorrelatedSignalsError,
  F7ConfigError,
  runAlphaCombination,
  type AlphaRunResult,
} from "./alpha-combination.js";
import type { BarRow, FiringRow } from "./alpha-matrix.js";
import { computeBarReturns } from "./backtest-walkforward.js";
import { parseSignalKey } from "./alpha-matrix.js";
import {
  simulatePnL,
  type BarReturnRow,
  type WeightsAtBar,
} from "./backtest-sim.js";
import { sampleMean, sampleStd } from "./stats.js";

export interface TrialConfig {
  windowM: number;
  windowD: number;
  correlationThreshold: number;
}

export interface FoldResult {
  foldIndex: number;
  testGroups: [number, number];
  isSharpe: number | null;
  oosSharpe: number | null;
  oosCumReturn: number | null;
  oosNBars: number;
  aborted: boolean;
  abortReason: string | null;
}

export interface TrialResult {
  trialIndex: number;
  config: TrialConfig;
  folds: FoldResult[];
}

export interface CpcvResult {
  trials: TrialResult[];
  nTrialsTotal: number;
  nFoldsPerTrial: number;
  /** Mean OOS Sharpe over all non-aborted (trial,fold) pairs. */
  aggregateSharpeMean: number;
  /** Stdev OOS Sharpe over same. */
  aggregateSharpeStd: number;
  nAborted: number;
}

export interface CpcvOpts {
  bars: BarRow[];
  firings: FiringRow[];
  watchlistSize: number;
  trialGrid: TrialConfig[];
  /** Number of contiguous groups. Default 6. */
  nGroups?: number;
  /** Number of test groups per fold. Default 2. */
  kTestGroups?: number;
  /** Bars purged on both sides of each test-train boundary. Default F7 horizon=1. */
  embargoBars?: number;
  costBps?: number;
  /**
   * Test injection for deterministic fold runs. Defaults to production F7.
   * Signature mirrors `runAlphaCombination`'s input (minus `mode`/`regime`
   * which are filled internally).
   */
  alphaRunner?: (
    input: Parameters<typeof runAlphaCombination>[0],
  ) => AlphaRunResult;
}

// ---------------------------------------------------------------------------
// Default trial grid (per §2 D-B, 2026-04-18 weekly-first amendment)
// ---------------------------------------------------------------------------

export const F75_DEFAULT_GRID: TrialConfig[] = (() => {
  const windowMs = [52, 78, 104, 156];
  const windowDs = [4, 8, 12];
  const corrThresholds = [0.9, 0.95];
  const out: TrialConfig[] = [];
  for (const m of windowMs) {
    for (const d of windowDs) {
      for (const c of corrThresholds) {
        out.push({ windowM: m, windowD: d, correlationThreshold: c });
      }
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Enumerate C(n, k) — all k-subsets of {0, ..., n-1} as sorted tuples. */
export function combinations(n: number, k: number): number[][] {
  if (k < 0 || k > n) return [];
  const out: number[][] = [];
  const combo = new Array<number>(k);
  function rec(start: number, depth: number): void {
    if (depth === k) {
      out.push([...combo]);
      return;
    }
    for (let i = start; i <= n - (k - depth); i++) {
      combo[depth] = i;
      rec(i + 1, depth + 1);
    }
  }
  rec(0, 0);
  return out;
}

/** Partition a sorted distinct-date list into N contiguous groups of near-equal length. */
export function partitionGroups(dates: string[], n: number): number[][] {
  if (n <= 0) throw new Error(`partitionGroups: n must be > 0, got ${n}`);
  const L = dates.length;
  const base = Math.floor(L / n);
  const extras = L - base * n;
  const groups: number[][] = [];
  let idx = 0;
  for (let g = 0; g < n; g++) {
    const size = base + (g < extras ? 1 : 0);
    const indices: number[] = [];
    for (let i = 0; i < size; i++) indices.push(idx++);
    groups.push(indices);
  }
  return groups;
}

function distinctDates(bars: BarRow[]): string[] {
  const set = new Set<string>();
  for (const b of bars) set.add(b.timestamp.slice(0, 10));
  return Array.from(set).sort();
}

/** Weights from AlphaRunResult, aggregated to per-symbol notional. */
function weightsBySymbol(result: AlphaRunResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of result.signals) {
    if (s.excluded || s.weight === 0) continue;
    const { symbol } = parseSignalKey(s.signalKey);
    out[symbol] = (out[symbol] ?? 0) + s.weight;
  }
  return out;
}

/**
 * Build a sparse bar/firing set whose indices lie in `keepIndices`.
 * `keepIndices` is the sorted union of train-group indices after embargo.
 */
function subsetByDateIndex<
  T extends { timestamp?: string; triggered_at?: string },
>(
  rows: T[],
  dateToIndex: Map<string, number>,
  keep: Set<number>,
  tsField: "timestamp" | "triggered_at",
): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const ts = ((r[tsField] as string | undefined) ?? "").slice(0, 10);
    const idx = dateToIndex.get(ts);
    if (idx !== undefined && keep.has(idx)) out.push(r);
  }
  return out;
}

function applyEmbargo(
  trainIndices: number[],
  testGroups: number[][],
  embargoBars: number,
): number[] {
  if (embargoBars <= 0) return trainIndices;
  const kept: number[] = [];
  for (const idx of trainIndices) {
    let purge = false;
    for (const testGroup of testGroups) {
      if (testGroup.length === 0) continue;
      const testMin = testGroup[0]!;
      const testMax = testGroup[testGroup.length - 1]!;
      if (idx >= testMin - embargoBars && idx <= testMax + embargoBars) {
        purge = true;
        break;
      }
    }
    if (!purge) kept.push(idx);
  }
  return kept;
}

/** Sharpe over a set of per-bar returns, annualized by √52. Empty/flat → null. */
function sharpeWeekly(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mu = sampleMean(returns);
  const sigma = sampleStd(returns);
  if (!(sigma > 0)) return null;
  return (mu / sigma) * Math.sqrt(52);
}

/** Apply constant weights over a list of bar dates; return net returns per bar + cum. */
function applyWeightsStaticToDates(
  weights: Record<string, number>,
  dates: string[],
  returnsByDate: Map<string, Map<string, number>>,
  costBps: number,
): { netReturns: number[]; cumReturn: number } {
  if (dates.length === 0) return { netReturns: [], cumReturn: 0 };

  // Convert Map<string, number> of returns-at-date to a BarReturnRow[]. Only
  // include symbols the weights need.
  const neededSymbols = Object.keys(weights).filter((s) => weights[s] !== 0);
  const bars: BarReturnRow[] = [];
  for (const d of dates) {
    const inner = returnsByDate.get(d);
    if (!inner) continue;
    for (const sym of neededSymbols) {
      const r = inner.get(sym);
      if (r !== undefined) bars.push({ timestamp: d, symbol: sym, ret: r });
    }
  }

  // Build a schedule that holds the same weights across every date.
  const schedule: WeightsAtBar[] = dates.map((d) => ({
    timestamp: d,
    weights,
  }));

  try {
    const sim = simulatePnL({
      bars,
      weightsSchedule: schedule,
      costBps,
    });
    return {
      netReturns: sim.steps.map((s) => s.net),
      cumReturn: sim.cumReturn,
    };
  } catch (err) {
    // Only swallow the "missing return for held symbol" degeneracy — that's an
    // expected edge case for synthetic folds whose test dates may lack a bar
    // for every held symbol. Rethrow contract violations (non-ascending
    // schedule, non-finite returns, negative cost) so bugs in the algorithm
    // layer surface instead of being hidden.
    if (err instanceof Error && /missing return/.test(err.message)) {
      return { netReturns: [], cumReturn: 0 };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runCpcv(opts: CpcvOpts): CpcvResult {
  const nGroups = opts.nGroups ?? 6;
  const kTestGroups = opts.kTestGroups ?? 2;
  const embargoBars = opts.embargoBars ?? F7_DEFAULTS.horizon;
  const costBps = opts.costBps ?? 5;
  const alphaRunner = opts.alphaRunner ?? runAlphaCombination;

  if (kTestGroups < 1 || kTestGroups >= nGroups) {
    throw new Error(
      `runCpcv: kTestGroups must be in [1, nGroups-1], got ${kTestGroups} (nGroups=${nGroups})`,
    );
  }
  if (opts.trialGrid.length === 0) {
    throw new Error(`runCpcv: trialGrid must be non-empty`);
  }

  const dates = distinctDates(opts.bars);
  const dateToIndex = new Map<string, number>();
  dates.forEach((d, i) => dateToIndex.set(d, i));

  // Pre-compute returnsByDate for fast fold-level Sharpe math.
  const returnRows = computeBarReturns(opts.bars);
  const returnsByDate = new Map<string, Map<string, number>>();
  for (const r of returnRows) {
    let inner = returnsByDate.get(r.timestamp);
    if (!inner) {
      inner = new Map();
      returnsByDate.set(r.timestamp, inner);
    }
    inner.set(r.symbol, r.ret);
  }

  const groups = partitionGroups(dates, nGroups);
  const foldSpecs = combinations(nGroups, kTestGroups);
  const nFolds = foldSpecs.length;

  const trials: TrialResult[] = [];
  const allOosSharpes: number[] = [];
  let nAborted = 0;

  for (let t = 0; t < opts.trialGrid.length; t++) {
    const cfg = opts.trialGrid[t]!;
    const folds: FoldResult[] = [];

    for (let f = 0; f < nFolds; f++) {
      const testGroupIndices = foldSpecs[f]!;
      const testGroups = testGroupIndices.map((g) => groups[g]!);
      const testIndices = testGroups.flat().sort((a, b) => a - b);

      const trainGroupsRaw = groups
        .map((_g, i) => i)
        .filter((i) => !testGroupIndices.includes(i))
        .map((i) => groups[i]!);
      const trainIndicesRaw = trainGroupsRaw.flat().sort((a, b) => a - b);
      const trainIndices = applyEmbargo(
        trainIndicesRaw,
        testGroups,
        embargoBars,
      );

      const trainSet = new Set(trainIndices);
      const testSet = new Set(testIndices);
      const trainDates = trainIndices.map((i) => dates[i]!);
      const testDates = testIndices.map((i) => dates[i]!);

      const foldLabel: [number, number] = [
        testGroupIndices[0]!,
        testGroupIndices[1] ?? testGroupIndices[0]!,
      ];

      if (trainIndices.length === 0 || testIndices.length < 2) {
        folds.push({
          foldIndex: f,
          testGroups: foldLabel,
          isSharpe: null,
          oosSharpe: null,
          oosCumReturn: null,
          oosNBars: testIndices.length,
          aborted: true,
          abortReason: "insufficient_bars",
        });
        nAborted += 1;
        continue;
      }

      // Subset firings/bars to train set only.
      const trainFirings = subsetByDateIndex(
        opts.firings,
        dateToIndex,
        trainSet,
        "triggered_at",
      );
      const trainBars = subsetByDateIndex(
        opts.bars,
        dateToIndex,
        trainSet,
        "timestamp",
      );
      const asOf = trainDates[trainDates.length - 1]!;

      let alpha: AlphaRunResult;
      try {
        alpha = alphaRunner({
          mode: "returns",
          firings: trainFirings,
          bars: trainBars,
          asOf,
          windowM: cfg.windowM,
          windowD: cfg.windowD,
          horizon: F7_DEFAULTS.horizon,
          correlationThreshold: cfg.correlationThreshold,
          watchlistSize: opts.watchlistSize,
          regime: null,
        });
      } catch (err) {
        const reason =
          err instanceof F7CorrelatedSignalsError
            ? "correlated_signals"
            : err instanceof F7ConfigError
              ? "f7_config_error"
              : "f7_error";
        folds.push({
          foldIndex: f,
          testGroups: foldLabel,
          isSharpe: null,
          oosSharpe: null,
          oosCumReturn: null,
          oosNBars: testIndices.length,
          aborted: true,
          abortReason: reason,
        });
        nAborted += 1;
        continue;
      }

      const weights = weightsBySymbol(alpha);
      const is = applyWeightsStaticToDates(
        weights,
        trainDates,
        returnsByDate,
        costBps,
      );
      const oos = applyWeightsStaticToDates(
        weights,
        testDates,
        returnsByDate,
        costBps,
      );

      const isSharpe = sharpeWeekly(is.netReturns);
      const oosSharpe = sharpeWeekly(oos.netReturns);

      if (oosSharpe !== null) allOosSharpes.push(oosSharpe);

      // Silence unused warning for testSet — retained for future dual-boundary
      // embargo sanity checks.
      void testSet;

      folds.push({
        foldIndex: f,
        testGroups: foldLabel,
        isSharpe,
        oosSharpe,
        oosCumReturn: oos.cumReturn,
        oosNBars: oos.netReturns.length,
        aborted: false,
        abortReason: null,
      });
    }

    trials.push({ trialIndex: t, config: cfg, folds });
  }

  const aggregateSharpeMean = sampleMean(allOosSharpes);
  const aggregateSharpeStd = sampleStd(allOosSharpes);

  return {
    trials,
    nTrialsTotal: opts.trialGrid.length,
    nFoldsPerTrial: nFolds,
    aggregateSharpeMean,
    aggregateSharpeStd,
    nAborted,
  };
}
