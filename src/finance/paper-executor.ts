/**
 * F8 Paper Trading — rebalance executor.
 *
 * Orchestrates a single weekly rebalance:
 *   1. Read current equity from adapter.getBalance().
 *   2. For each symbol in targetWeights ∪ current positions:
 *      target_shares = floor(totalEquity × weight / lastPrice, 4dp)
 *   3. Diff vs current shares → Order list.
 *   4. Sort orders: SELLS first (free up cash), BUYS last.
 *   5. Execute serially via adapter.placeOrder.
 *   6. Insert a `trade_theses` row tagging this rebalance.
 *   7. Return structured summary.
 *
 * No SQL here — pure orchestration over the `VenueAdapter` surface. Tests
 * inject mock adapters. Production passes PaperEquityAdapter.
 *
 * Weekly-first (operator lock): this module has no cadence logic built in;
 * the caller (tool handler) decides when to invoke. Typically once per week.
 */

import { randomUUID } from "node:crypto";
import type {
  Fill,
  Order,
  OrderReject,
  OrderResult,
  VenueAdapter,
} from "./venue-types.js";
import { isFill, isOrderReject } from "./venue-types.js";
import { insertPortfolioThesis, linkFillsToThesis } from "./paper-persist.js";

/** Shares precision: 4 decimal places. Brokers commonly support 1e-4 fractional. */
const SHARES_PRECISION = 1e4;
/**
 * Target-weight delta below this fraction of current equity → skip (no
 * micro-trades). Set slightly larger than `TARGET_CASH_BUFFER` so that a
 * re-balance whose only delta is the buffer itself (i.e. portfolio already
 * matches the derated target) does NOT trigger dust-trades.
 */
const MIN_REBALANCE_FRACTION = 2.5e-3;
/**
 * Buy-side cash buffer: derate target notional by 20 bps so buy orders still
 * fit after 5 bps round-trip slippage is applied at fill time. Without this,
 * target_shares at 100% equity misses by exactly slippage × notional and the
 * last buy gets rejected for insufficient cash. 20 bps leaves 4× the overhead.
 */
const TARGET_CASH_BUFFER = 2e-3;

function roundShares(x: number): number {
  return Math.round(x * SHARES_PRECISION) / SHARES_PRECISION;
}

export interface RebalanceOpts {
  adapter: VenueAdapter;
  /** { symbol → weight }. Weights should sum to ≤ 1 (cash is the complement). */
  targetWeights: Record<string, number>;
  /** Logical link to the alpha run that produced these weights. */
  alphaRunId: string | null;
  /** Logical link to the backtest run whose ship_gate was checked. */
  backtestRunId: string | null;
  /** F5 regime at run time (or null). */
  regime: string | null;
  /** True when caller is overriding a ship_blocked gate. */
  overrideShip: boolean;
  /** True when the caller has verified ship_blocked was false. */
  shipBlocked: boolean;
  /** Free-form notes persisted with the thesis. */
  notes?: string;
  /** Account override (defaults to adapter.account if PaperEquityAdapter). */
  account?: string;
  /**
   * Allow the rebalance to proceed even when pre-trade positions have stale
   * quotes. Default false — staleness distorts totalEquity and would produce
   * mis-sized target shares. Operator must explicitly opt in. Audit W2.
   */
  allowStale?: boolean;
}

export interface RebalanceSummary {
  thesisId: number;
  fills: Fill[];
  rejects: OrderReject[];
  totalEquityBefore: number;
  totalEquityAfter: number;
  cashBefore: number;
  cashAfter: number;
  ordersPlanned: number;
  ordersSkipped: number;
  /** Positions whose pre-rebalance mark-to-market used stale prices. */
  staleSymbols: string[];
  /** True when rebalance refused to proceed due to stale positions. */
  stalePositionsAborted: boolean;
}

/** Resolve account name for persistence: explicit wins, else adapter's name. */
function resolveAccount(opts: RebalanceOpts): string {
  if (opts.account) return opts.account;
  const adapterAny = opts.adapter as unknown as { account?: string };
  return adapterAny.account ?? "default";
}

/**
 * Build the order list from current state and target weights.
 *
 * Pure function — no I/O. Exposed for testability.
 */
export function planOrders(opts: {
  currentShares: Record<string, number>;
  quotes: Record<string, number>;
  targetWeights: Record<string, number>;
  totalEquity: number;
}): { orders: Order[]; skipped: string[] } {
  const symbols = new Set<string>([
    ...Object.keys(opts.currentShares),
    ...Object.keys(opts.targetWeights),
  ]);
  const orders: Order[] = [];
  const skipped: string[] = [];
  const minNotional = opts.totalEquity * MIN_REBALANCE_FRACTION;
  // Derate target notional so buys still fit after slippage hits at fill time.
  const effectiveEquity = opts.totalEquity * (1 - TARGET_CASH_BUFFER);

  for (const sym of symbols) {
    const currentShares = opts.currentShares[sym] ?? 0;
    const weight = opts.targetWeights[sym] ?? 0;
    const price = opts.quotes[sym];
    if (price === undefined || !(price > 0)) {
      skipped.push(`${sym}:no_price`);
      continue;
    }
    const targetShares = roundShares((effectiveEquity * weight) / price);
    const delta = roundShares(targetShares - currentShares);
    if (delta === 0) continue;
    const absNotional = Math.abs(delta) * price;
    if (absNotional < minNotional) {
      // Too small to be worth trading; avoid cost/turnover on rounding dust.
      continue;
    }
    orders.push({
      clientOrderId: randomUUID(),
      symbol: sym,
      side: delta > 0 ? "buy" : "sell",
      quantity: Math.abs(delta),
      type: "market",
      timeInForce: "day",
    });
  }

  // Sort: sells first so their proceeds become available to buys in the same
  // pass. Stable within side by symbol for deterministic execution order.
  orders.sort((a, b) => {
    if (a.side !== b.side) return a.side === "sell" ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

  return { orders, skipped };
}

export async function runRebalance(
  opts: RebalanceOpts,
): Promise<RebalanceSummary> {
  const adapter = opts.adapter;
  const account = resolveAccount(opts);

  // Record the rebalance start time so we can later attribute any fills
  // produced during this run to the thesis row (audit W4 round 1).
  const startedAtIso = adapter.clock.now().toISOString();

  // Snapshot pre-trade state for the summary.
  const balBefore = await adapter.getBalance();
  const posBefore = await adapter.getPositions();

  // Audit W2 round 1: if any held position has a stale quote, refuse the
  // rebalance rather than size against a distorted totalEquity. The operator
  // must either refresh market data or drop the stale symbols.
  // F8.1b: paper-executor only handles equity positions — narrow via `kind`.
  const equityPositions = posBefore.filter(
    (p): p is import("./venue-types.js").EquityPosition => p.kind === "equity",
  );
  const staleSymbols = equityPositions
    .filter((p) => p.stale)
    .map((p) => p.symbol);
  if (staleSymbols.length > 0 && !opts.allowStale) {
    const nowIso = adapter.clock.now().toISOString();
    // Audit W-R2-5 round 2: mark aborted theses with `aborted=true` in
    // metadata so downstream queries can filter them out of "live" positions.
    const thesisId = insertPortfolioThesis(
      {
        account,
        alphaRunId: opts.alphaRunId,
        backtestRunId: opts.backtestRunId,
        regime: opts.regime,
        shipBlocked: opts.shipBlocked,
        overrideShip: opts.overrideShip,
        targetWeights: opts.targetWeights,
        notes: `aborted: stale positions ${staleSymbols.join(",")}`,
        aborted: true,
      },
      nowIso,
    );
    return {
      thesisId,
      fills: [],
      rejects: [],
      totalEquityBefore: balBefore.totalEquity,
      totalEquityAfter: balBefore.totalEquity,
      cashBefore: balBefore.cash,
      cashAfter: balBefore.cash,
      ordersPlanned: 0,
      ordersSkipped: 0,
      staleSymbols,
      stalePositionsAborted: true,
    };
  }

  // Build a {symbol → shares} map from current positions.
  const currentShares: Record<string, number> = {};
  for (const p of equityPositions) currentShares[p.symbol] = p.shares;

  // Fetch quotes for every symbol we might trade. Cache misses surface as
  // "no_price" skips so the rebalance degrades gracefully rather than aborts.
  const symbols = new Set<string>([
    ...Object.keys(currentShares),
    ...Object.keys(opts.targetWeights),
  ]);
  const quotes: Record<string, number> = {};
  for (const sym of symbols) {
    try {
      const q = await adapter.getMarketData(sym);
      quotes[sym] = q.price;
    } catch {
      // Skipped below in planOrders via the "no_price" path.
    }
  }

  const { orders, skipped } = planOrders({
    currentShares,
    quotes,
    targetWeights: opts.targetWeights,
    totalEquity: balBefore.totalEquity,
  });

  const fills: Fill[] = [];
  const rejects: OrderReject[] = [];
  for (const order of orders) {
    const res: OrderResult = await adapter.placeOrder(order);
    if (isFill(res)) fills.push(res);
    else if (isOrderReject(res)) rejects.push(res);
  }

  // Persist thesis row after trades so fills+thesis are closely timestamped.
  const nowIso = adapter.clock.now().toISOString();
  const thesisId = insertPortfolioThesis(
    {
      account,
      alphaRunId: opts.alphaRunId,
      backtestRunId: opts.backtestRunId,
      regime: opts.regime,
      shipBlocked: opts.shipBlocked,
      overrideShip: opts.overrideShip,
      targetWeights: opts.targetWeights,
      notes: opts.notes,
    },
    nowIso,
  );

  // Back-link fills to this thesis by fill UUID (audit W-R2-4 round 2).
  // Earlier impl matched by `filled_at ≥ startedAt` which could misattribute
  // fills from a concurrent rebalance. fill_id list is authoritative.
  const fillIds = fills.map((f) => f.fillId);
  linkFillsToThesis(thesisId, fillIds);
  // Silence unused — kept as a comment anchor for the startedAtIso paradigm
  // until we replace it with DB-level rebalance_id for concurrent runs.
  void startedAtIso;

  const balAfter = await adapter.getBalance();

  return {
    thesisId,
    fills,
    rejects,
    totalEquityBefore: balBefore.totalEquity,
    totalEquityAfter: balAfter.totalEquity,
    cashBefore: balBefore.cash,
    cashAfter: balAfter.cash,
    ordersPlanned: orders.length,
    ordersSkipped: skipped.length,
    staleSymbols,
    stalePositionsAborted: false,
  };
}
