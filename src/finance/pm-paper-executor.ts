/**
 * F8.1b — Polymarket paper-trading rebalance executor.
 *
 * Consumes `pm_alpha_latest` weights, sizes each active token by
 * `|weight| × total_equity`, diffs vs current holdings, generates orders
 * (sells-first), executes via the injected adapter, persists a
 * `trade_theses` row with `entry_signal='pm_weekly_rebalance'`.
 *
 * Parallel to F8's equity `paper-executor.ts` but keyed on
 * (marketId, outcome) rather than symbol. v1 handles positive weights only;
 * negative weights (shorting YES = buying NO from zero) are deferred to
 * F8.1b.2 — current behavior: negative weight on a held YES sells what's
 * there, zero-opens NO side.
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
import {
  insertPmPortfolioThesis,
  linkPmFillsToThesis,
} from "./pm-paper-persist.js";

const SHARES_PRECISION = 1e4;
const DUST_MIN_NOTIONAL = 10; // $10 USDC — don't churn on sub-threshold deltas
// Leave a small cash buffer to absorb slip + rounding on buys; parallels
// F8's paper-executor.ts. 20 bps ≈ 2× default PM slippage.
const TARGET_CASH_BUFFER_BPS = 20;

function roundShares(x: number): number {
  return Math.round(x * SHARES_PRECISION) / SHARES_PRECISION;
}

export interface PmTokenTarget {
  marketId: string;
  outcome: string;
  /** Signed weight from pm_alpha_latest. |weight| × equity = target notional. */
  weight: number;
}

export interface PmRebalanceOpts {
  adapter: VenueAdapter;
  /** Per-token target weights (signed). */
  targets: PmTokenTarget[];
  /** Logical link to the pm_alpha run that produced these weights. */
  pmAlphaRunId: string | null;
  /**
   * True when the operator explicitly overrode the ship-gate. v1 has no
   * PM ship-gate; flag is threaded through for future F8.1c compatibility
   * and audit trail.
   */
  shipOverride: boolean;
  /** Free-form notes persisted with the thesis. */
  notes?: string;
  /** Account override; defaults to adapter's account if it exposes one. */
  account?: string;
  /**
   * When true, skip the pre-trade abort on stale positions. Operator opts in
   * explicitly. Defaults to false — stale marks make sizing untrustworthy.
   */
  allowStale?: boolean;
}

export interface PmRebalanceSummary {
  thesisId: number;
  fills: Fill[];
  rejects: OrderReject[];
  totalEquityBefore: number;
  totalEquityAfter: number;
  cashBefore: number;
  cashAfter: number;
  ordersPlanned: number;
  ordersSkipped: number;
  /** Tokens whose pre-trade mark-to-market was stale. */
  staleMarkets: string[];
  /**
   * True when pre-trade aborted because one or more positions had stale
   * marks AND opts.allowStale !== true. No orders were placed; thesis is
   * still persisted for audit.
   */
  stalePositionsAborted: boolean;
}

function resolveAccount(opts: PmRebalanceOpts): string {
  if (opts.account) return opts.account;
  const adapterAny = opts.adapter as unknown as { account?: string };
  return adapterAny.account ?? "default";
}

/** Token symbol format used by PolymarketPaperAdapter. */
function tokenSymbol(marketId: string, outcome: string): string {
  return `${marketId}:${outcome}`;
}

export async function runPmRebalance(
  opts: PmRebalanceOpts,
): Promise<PmRebalanceSummary> {
  const { adapter } = opts;
  const account = resolveAccount(opts);
  const startedAtIso = adapter.clock.now().toISOString();

  // Snapshot pre-trade state.
  const balBefore = await adapter.getBalance();
  const posBefore = await adapter.getPositions();

  // Build (marketId, outcome) → shares map from current PM positions.
  const currentShares = new Map<string, number>();
  const staleMarkets: string[] = [];
  for (const p of posBefore) {
    if (p.kind !== "polymarket") continue;
    const key = tokenSymbol(p.marketId, p.outcome);
    currentShares.set(key, p.shares);
    if (p.stale) staleMarkets.push(key);
  }

  // Fetch quotes for every target. No-quote tokens skip cleanly.
  const quotes = new Map<string, number>();
  const skipped: string[] = [];
  const targetByKey = new Map<string, PmTokenTarget>();
  for (const t of opts.targets) {
    const key = tokenSymbol(t.marketId, t.outcome);
    targetByKey.set(key, t);
    try {
      const q = await adapter.getMarketData(key);
      quotes.set(key, q.price);
    } catch {
      skipped.push(`${key}:no_quote`);
    }
  }

  // Also fetch quotes for holdings that aren't in targets — needed for sizing.
  for (const key of currentShares.keys()) {
    if (quotes.has(key)) continue;
    try {
      const q = await adapter.getMarketData(key);
      quotes.set(key, q.price);
    } catch {
      skipped.push(`${key}:no_quote_for_hold`);
    }
  }

  // Stale-position abort: if any held position has a stale mark and the
  // operator did not opt into allowStale, refuse to trade. Sizing uses
  // totalEquity = cash + Σ(shares × mark); a stale mark skews the target.
  // Thesis is still written for audit via the tail block.
  const stalePositionsAborted = staleMarkets.length > 0 && !opts.allowStale;

  // Plan orders. Union of (target tokens + held tokens).
  const allKeys = new Set<string>([
    ...currentShares.keys(),
    ...targetByKey.keys(),
  ]);
  const orders: Order[] = [];
  if (!stalePositionsAborted) {
    // Derate targets by a small cash buffer so slip + rounding on buys can't
    // push cash negative. Buffer intentionally tiny — PM spreads are much
    // wider than the 20 bps used here and already absorb most friction.
    const cashBufferFactor = 1 - TARGET_CASH_BUFFER_BPS / 10_000;
    for (const key of allKeys) {
      const price = quotes.get(key);
      if (price === undefined || !(price > 0)) continue;
      const held = currentShares.get(key) ?? 0;
      const target = targetByKey.get(key);
      const weight = target?.weight ?? 0;
      // |weight| × equity = target notional. Negative weight → target 0 on YES
      // side; pure exit at v1 (shorting-via-NO-side deferred to F8.1b.2).
      const effectiveWeight = Math.max(0, weight);
      const targetNotional =
        balBefore.totalEquity * cashBufferFactor * effectiveWeight;
      const targetShares = roundShares(targetNotional / price);
      const delta = roundShares(targetShares - held);
      if (delta === 0) continue;
      const absNotional = Math.abs(delta) * price;
      // Dust filter: skip sub-threshold rebalances UNLESS this is a full exit
      // (target 0 with held > 0) — closing a dust position should always
      // clear. Without this carve-out, penny-priced stranded shares would
      // accrete forever.
      const isFullExit = targetShares === 0 && held > 0;
      if (absNotional < DUST_MIN_NOTIONAL && !isFullExit) continue;
      orders.push({
        clientOrderId: randomUUID(),
        symbol: key,
        side: delta > 0 ? "buy" : "sell",
        quantity: Math.abs(delta),
        type: "market",
        timeInForce: "day",
      });
    }
  }

  // Sort: sells first (free up cash), then buys. Stable by symbol within side.
  orders.sort((a, b) => {
    if (a.side !== b.side) return a.side === "sell" ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

  // Execute serially.
  const fills: Fill[] = [];
  const rejects: OrderReject[] = [];
  for (const order of orders) {
    const res: OrderResult = await adapter.placeOrder(order);
    if (isFill(res)) fills.push(res);
    else if (isOrderReject(res)) rejects.push(res);
  }

  // Persist thesis after trades.
  const nowIso = adapter.clock.now().toISOString();
  const targetWeightsDump: Record<string, { outcome: string; weight: number }> =
    {};
  for (const t of opts.targets) {
    targetWeightsDump[t.marketId] = { outcome: t.outcome, weight: t.weight };
  }
  // Annotate thesis when aborted so downstream audit queries can distinguish
  // "intentionally flat" from "stale-abort". Mirrors F8 equity's pattern.
  const notesWithAbort = stalePositionsAborted
    ? [opts.notes, `aborted: stale markets: ${staleMarkets.join(", ")}`]
        .filter((s): s is string => !!s)
        .join(" | ")
    : opts.notes;

  const thesisId = insertPmPortfolioThesis(
    {
      account,
      pmAlphaRunId: opts.pmAlphaRunId,
      shipOverride: opts.shipOverride,
      targetWeights: targetWeightsDump,
      notes: notesWithAbort,
      aborted: stalePositionsAborted,
    },
    nowIso,
  );

  // Back-link PM fills to thesis by fill_id — concurrent-safe pattern from F8.
  const fillIds = fills.map((f) => f.fillId);
  linkPmFillsToThesis(thesisId, fillIds);
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
    stalePositionsAborted,
    ordersPlanned: orders.length,
    ordersSkipped: skipped.length,
    staleMarkets,
  };
}
