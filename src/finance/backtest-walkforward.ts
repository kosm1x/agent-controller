/**
 * F7.5 Strategy Backtester — Walk-Forward engine.
 *
 * Replays the F7 FLAM strategy through history in a single pass:
 *
 *   For each weekly bar t from `warmupBars` onward:
 *     1. Earn returns on the weights produced at bar t-1.
 *     2. Run F7 using only data up to bar t (no lookahead).
 *     3. Rebalance to the new weights; incur turnover cost.
 *
 * Produces the operator-facing equity curve + annualized Sharpe, max
 * drawdown, Calmar, and win rate. Independent of CPCV — this is "how would
 * this have done running in production"; CPCV answers "is that P&L real".
 *
 * Weekly-first: annualization factor is √52. If `rebalanceBars` ever becomes
 * > 1 the effective factor is √(52/rebalanceBars); we expose both.
 *
 * Pure orchestration module — all math lives in alpha-combination (F7),
 * backtest-sim (P&L), stats (moments). No DB/HTTP here.
 */

import {
  F7_DEFAULTS,
  F7CorrelatedSignalsError,
  runAlphaCombination,
  type AlphaRunResult,
} from "./alpha-combination.js";
import type { BarRow, FiringRow } from "./alpha-matrix.js";
import { parseSignalKey } from "./alpha-matrix.js";
import {
  simulatePnL,
  type BarReturnRow,
  type PnLStep,
  type WeightsAtBar,
} from "./backtest-sim.js";
import { sampleMean, sampleStd } from "./stats.js";

export interface EquityPoint {
  timestamp: string;
  equity: number;
  /** Net return for the bar ending at `timestamp`. */
  return: number;
}

export interface WalkForwardResult {
  equityCurve: EquityPoint[];
  /** Annualized Sharpe using √(52 / rebalanceBars). */
  sharpe: number;
  cumReturn: number;
  /** Max drawdown magnitude; always non-negative. */
  maxDrawdown: number;
  /** annualized_return / |max_drawdown|. 0 if drawdown is 0. */
  calmar: number;
  /** Fraction of bars with net P&L > 0. */
  winRate: number;
  /** Count of bars that incurred turnover > 0. */
  totalTrades: number;
  /** Number of warmup bars skipped at the start. */
  nWarmupBars: number;
  /** Number of test bars used. */
  nTestBars: number;
  /** Number of F7 runs that aborted (correlation exhaustion, etc). */
  nAbortedRuns: number;
}

export interface WalkForwardOpts {
  bars: BarRow[];
  firings: FiringRow[];
  watchlistSize: number;
  /** F7 param — default F7_DEFAULTS.windowM. */
  windowM?: number;
  /** F7 param — default F7_DEFAULTS.windowD. */
  windowD?: number;
  /** F7 param — default F7_DEFAULTS.horizon. */
  horizon?: number;
  /** F7 param — default F7_DEFAULTS.correlationThreshold. */
  correlationThreshold?: number;
  /** Round-trip cost in bps. Default 5. */
  costBps?: number;
  /** How many bars between weight refreshes. Default 1 (every bar). */
  rebalanceBars?: number;
  /**
   * Test injection: alternate F7 runner. Defaults to production
   * `runAlphaCombination`. Enables deterministic unit tests without real F7.
   */
  alphaRunner?: (input: {
    mode: "returns" | "probability";
    firings: FiringRow[];
    bars: BarRow[];
    asOf: string;
    windowM: number;
    windowD: number;
    horizon: number;
    correlationThreshold: number;
    watchlistSize: number;
    regime: string | null;
  }) => AlphaRunResult;
}

/**
 * Produce a sorted distinct list of weekly-bar dates (YYYY-MM-DD) in the
 * caller's bar history. Uses the substring slice to be resilient to
 * timezone-suffixed timestamps.
 */
function distinctDates(bars: BarRow[]): string[] {
  const set = new Set<string>();
  for (const b of bars) set.add(b.timestamp.slice(0, 10));
  return Array.from(set).sort();
}

/** Weights from an AlphaRunResult → flat { symbol → w }. Excluded rows skipped. */
function weightsBySymbol(result: AlphaRunResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of result.signals) {
    if (s.excluded) continue;
    if (s.weight === 0) continue;
    // Aggregate by symbol when multiple signals fire on the same symbol:
    // F7 weights are per-signal; for P&L we need per-symbol notional.
    const { symbol } = parseSignalKey(s.signalKey);
    out[symbol] = (out[symbol] ?? 0) + s.weight;
  }
  return out;
}

/**
 * Compute per-bar simple returns per symbol from a bar history.
 * Output: rows with `timestamp` = the bar *at* which the return is realized
 * (i.e. return from bar-prev to bar-now).
 */
export function computeBarReturns(bars: BarRow[]): BarReturnRow[] {
  // Group bars by symbol, sort by timestamp, compute consecutive returns.
  const bySymbol = new Map<string, BarRow[]>();
  for (const b of bars) {
    let arr = bySymbol.get(b.symbol);
    if (!arr) {
      arr = [];
      bySymbol.set(b.symbol, arr);
    }
    arr.push(b);
  }

  const out: BarReturnRow[] = [];
  for (const [symbol, arr] of bySymbol.entries()) {
    arr.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!;
      const cur = arr[i]!;
      if (!Number.isFinite(prev.close) || prev.close <= 0) continue;
      if (!Number.isFinite(cur.close) || cur.close <= 0) continue;
      const ret = cur.close / prev.close - 1;
      out.push({
        timestamp: cur.timestamp.slice(0, 10),
        symbol,
        ret,
      });
    }
  }
  return out;
}

/**
 * Slice firings/bars to "information available at asOf" — i.e. timestamp ≤ asOf.
 * No windowM truncation here; F7's internal window selection handles that.
 */
function sliceUpTo<T extends { timestamp?: string; triggered_at?: string }>(
  rows: T[],
  asOf: string,
  tsField: "timestamp" | "triggered_at",
): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const ts = (r[tsField] as string | undefined) ?? "";
    if (ts.slice(0, 10) <= asOf) out.push(r);
  }
  return out;
}

/**
 * Max drawdown magnitude for an equity curve.
 * dd_t = max over s ≤ t of (peak_s - equity_t) / peak_s
 */
function computeMaxDrawdown(steps: PnLStep[], initialEquity: number): number {
  let peak = initialEquity;
  let maxDd = 0;
  for (const s of steps) {
    if (s.equity > peak) peak = s.equity;
    if (peak > 0) {
      const dd = (peak - s.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

export function runWalkForward(opts: WalkForwardOpts): WalkForwardResult {
  const windowM = opts.windowM ?? F7_DEFAULTS.windowM;
  const windowD = opts.windowD ?? F7_DEFAULTS.windowD;
  const horizon = opts.horizon ?? F7_DEFAULTS.horizon;
  const correlationThreshold =
    opts.correlationThreshold ?? F7_DEFAULTS.correlationThreshold;
  const costBps = opts.costBps ?? 5;
  const rebalanceBars = Math.max(1, Math.floor(opts.rebalanceBars ?? 1));
  const alphaRunner = opts.alphaRunner ?? runAlphaCombination;

  const dates = distinctDates(opts.bars);
  // Warmup = windowM bars of F7 history. First usable asOf is dates[windowM-1].
  const warmupBars = windowM;
  if (dates.length <= warmupBars) {
    return {
      equityCurve: [],
      sharpe: 0,
      cumReturn: 0,
      maxDrawdown: 0,
      calmar: 0,
      winRate: 0,
      totalTrades: 0,
      nWarmupBars: warmupBars,
      nTestBars: 0,
      nAbortedRuns: 0,
    };
  }

  // Build weights schedule. Iterate over test bars; at each rebalance step
  // run F7 asOf=prior bar, apply weights to that test bar onward.
  const weightsSchedule: WeightsAtBar[] = [];
  let currentWeights: Record<string, number> = {};
  let lastRefreshedAt = -Infinity;
  let nAbortedRuns = 0;

  for (let i = warmupBars; i < dates.length; i++) {
    const barDate = dates[i]!;
    const asOf = dates[i - 1]!;

    const sinceLastRefresh = i - lastRefreshedAt;
    const shouldRefresh = sinceLastRefresh >= rebalanceBars;

    if (shouldRefresh) {
      const slicedFirings = sliceUpTo(opts.firings, asOf, "triggered_at");
      const slicedBars = sliceUpTo(opts.bars, asOf, "timestamp");
      try {
        const alpha = alphaRunner({
          mode: "returns",
          firings: slicedFirings,
          bars: slicedBars,
          asOf,
          windowM,
          windowD,
          horizon,
          correlationThreshold,
          watchlistSize: opts.watchlistSize,
          regime: null,
        });
        currentWeights = weightsBySymbol(alpha);
      } catch (err) {
        if (err instanceof F7CorrelatedSignalsError) {
          // Hold prior weights; record abort.
          nAbortedRuns += 1;
        } else {
          throw err;
        }
      }
      lastRefreshedAt = i;
    }

    weightsSchedule.push({
      timestamp: barDate,
      weights: { ...currentWeights },
    });
  }

  if (weightsSchedule.length === 0) {
    return {
      equityCurve: [],
      sharpe: 0,
      cumReturn: 0,
      maxDrawdown: 0,
      calmar: 0,
      winRate: 0,
      totalTrades: 0,
      nWarmupBars: warmupBars,
      nTestBars: 0,
      nAbortedRuns,
    };
  }

  const returns = computeBarReturns(opts.bars);
  const initialEquity = 1;
  const sim = simulatePnL({
    bars: returns,
    weightsSchedule,
    costBps,
    initialEquity,
  });

  // Sharpe — annualized by √(52 / rebalanceBars). For weekly-first we use √52.
  const netReturns = sim.steps.map((s) => s.net);
  const mu = sampleMean(netReturns);
  const sigma = sampleStd(netReturns);
  const annFactor = Math.sqrt(52 / rebalanceBars);
  const sharpe = sigma > 0 ? (mu / sigma) * annFactor : 0;

  const cumReturn = sim.cumReturn;
  const maxDrawdown = computeMaxDrawdown(sim.steps, initialEquity);
  const nBars = netReturns.length;
  const annualizedReturn =
    nBars > 0 ? Math.pow(1 + cumReturn, 52 / (nBars * rebalanceBars)) - 1 : 0;
  const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;
  const winRate =
    nBars > 0 ? netReturns.filter((r) => r > 0).length / nBars : 0;

  const equityCurve: EquityPoint[] = sim.steps.map((s) => ({
    timestamp: s.timestamp,
    equity: s.equity,
    return: s.net,
  }));

  return {
    equityCurve,
    sharpe,
    cumReturn,
    maxDrawdown,
    calmar,
    winRate,
    totalTrades: sim.totalTrades,
    nWarmupBars: warmupBars,
    nTestBars: nBars,
    nAbortedRuns,
  };
}
