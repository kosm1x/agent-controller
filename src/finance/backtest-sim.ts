/**
 * F7.5 Strategy Backtester — P&L simulator.
 *
 * Pure function. Takes per-bar returns + a weights schedule and produces a
 * per-bar P&L curve including transaction costs.
 *
 * P&L convention (D-G in `20-f7.5-impl-plan.md`):
 *
 *   P&L(bar t) = Σ_i w(i, t-1) × R(i, t) − cost × Σ_i |w(i, t) − w(i, t-1)|
 *
 * Read: weights decided at bar t-1 earn bar-t returns; rebalance to new
 * targets at bar t incurs cost on the L1 turnover. First bar has no prior
 * weights, so w(-1) = 0 — all positions opened at bar 0 count as turnover.
 *
 * Costs are expressed in basis points round-trip. `costBps = 5` → cost
 * fraction = 5 / 10_000 = 5e-4 applied to L1 turnover.
 *
 * Weekly-first (operator lock, 2026-04-18): no interval semantics live in
 * this module. Bars are whatever the caller feeds — the annualization factor
 * is applied upstream in `backtest-walkforward.ts` / `backtest-cpcv.ts`.
 *
 * No I/O. No deps. No mutation of caller inputs.
 */

const DEFAULT_INITIAL_EQUITY = 1.0;
const BPS_DIVISOR = 10_000;

/** Simple return at (timestamp, symbol). Sparse: a symbol may not appear every bar. */
export interface BarReturnRow {
  timestamp: string;
  symbol: string;
  ret: number;
}

/** Weights in effect starting at `timestamp`, held until the next entry. */
export interface WeightsAtBar {
  timestamp: string;
  /** symbol → target weight. Symbols not present are implicitly 0. */
  weights: Record<string, number>;
}

export interface PnLStep {
  timestamp: string;
  /** Gross P&L: Σ w(t-1) × R(t). Zero at the very first bar. */
  gross: number;
  /** Cost fraction: (cost_bps / 10_000) × Σ |Δw|. */
  cost: number;
  /** Net P&L = gross − cost. */
  net: number;
  /** Running equity after this bar's P&L applied multiplicatively. */
  equity: number;
}

export interface SimulateResult {
  steps: PnLStep[];
  finalEquity: number;
  cumReturn: number;
  /** Number of bars at which any weight changed (turnover>0). Includes open at bar 0. */
  totalTrades: number;
}

/**
 * Simulate P&L for a given weights schedule against a return series.
 *
 * Inputs:
 *   bars              — return rows; only rows whose timestamp matches a
 *                       weights-schedule timestamp contribute to P&L.
 *   weightsSchedule   — must be sorted ascending by timestamp. Gaps allowed
 *                       (implicit "hold previous weights").
 *   costBps           — round-trip basis points. 5 → 0.05%.
 *   initialEquity     — starting equity. Default 1.0.
 *
 * Invariants:
 *   - Empty `weightsSchedule` → empty `steps`, `finalEquity === initialEquity`.
 *   - First bar has cost proportional to |Σ w(0)| (opening positions).
 *   - Timestamps in `weightsSchedule` must be strictly ascending — otherwise throws.
 *   - Symbols absent from a weights entry default to 0 on both sides of Δw.
 *   - NaN returns (sparse bars without data for a held symbol) throw — caller
 *     must pre-filter. Silent zeroing would mask data gaps.
 */
export function simulatePnL(opts: {
  bars: BarReturnRow[];
  weightsSchedule: WeightsAtBar[];
  costBps: number;
  initialEquity?: number;
}): SimulateResult {
  const { bars, weightsSchedule, costBps } = opts;
  const initialEquity = opts.initialEquity ?? DEFAULT_INITIAL_EQUITY;

  if (costBps < 0) {
    throw new Error(`simulatePnL: costBps must be >= 0, got ${costBps}`);
  }
  if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
    throw new Error(
      `simulatePnL: initialEquity must be finite positive, got ${initialEquity}`,
    );
  }

  if (weightsSchedule.length === 0) {
    return {
      steps: [],
      finalEquity: initialEquity,
      cumReturn: 0,
      totalTrades: 0,
    };
  }

  // Validate weights timestamps are strictly ascending.
  for (let i = 1; i < weightsSchedule.length; i++) {
    if (weightsSchedule[i]!.timestamp <= weightsSchedule[i - 1]!.timestamp) {
      throw new Error(
        `simulatePnL: weights schedule not strictly ascending at index ${i}: ${weightsSchedule[i - 1]!.timestamp} >= ${weightsSchedule[i]!.timestamp}`,
      );
    }
  }

  // Index returns by timestamp for O(1) lookup.
  const returnsByTs = new Map<string, Map<string, number>>();
  for (const row of bars) {
    if (!Number.isFinite(row.ret)) {
      throw new Error(
        `simulatePnL: non-finite return at ${row.timestamp} ${row.symbol}`,
      );
    }
    let inner = returnsByTs.get(row.timestamp);
    if (!inner) {
      inner = new Map();
      returnsByTs.set(row.timestamp, inner);
    }
    inner.set(row.symbol, row.ret);
  }

  const costFraction = costBps / BPS_DIVISOR;
  const steps: PnLStep[] = [];
  let equity = initialEquity;
  let prevWeights: Record<string, number> = {};
  let totalTrades = 0;

  for (const entry of weightsSchedule) {
    const returnsAtBar =
      returnsByTs.get(entry.timestamp) ?? new Map<string, number>();

    // Gross P&L earned by PREVIOUS weights on THIS bar's returns.
    let gross = 0;
    for (const [sym, w] of Object.entries(prevWeights)) {
      if (w === 0) continue;
      const r = returnsAtBar.get(sym);
      if (r === undefined) {
        throw new Error(
          `simulatePnL: missing return for held symbol ${sym} at ${entry.timestamp}`,
        );
      }
      gross += w * r;
    }

    // Turnover = Σ |new − old|, over union of symbols.
    const allSymbols = new Set<string>([
      ...Object.keys(prevWeights),
      ...Object.keys(entry.weights),
    ]);
    let turnover = 0;
    for (const sym of allSymbols) {
      const wNew = entry.weights[sym] ?? 0;
      const wOld = prevWeights[sym] ?? 0;
      turnover += Math.abs(wNew - wOld);
    }
    const cost = costFraction * turnover;
    if (turnover > 0) totalTrades += 1;

    const net = gross - cost;
    equity = equity * (1 + net);

    steps.push({
      timestamp: entry.timestamp,
      gross,
      cost,
      net,
      equity,
    });

    prevWeights = { ...entry.weights };
  }

  return {
    steps,
    finalEquity: equity,
    cumReturn: equity / initialEquity - 1,
    totalTrades,
  };
}
