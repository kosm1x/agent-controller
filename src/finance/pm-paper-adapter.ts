/**
 * F8.1b — PolymarketPaperAdapter.
 *
 * Second concrete VenueAdapter (paired with F8's PaperEquityAdapter). Reads
 * cached midpoints from `prediction_markets.outcome_tokens` (populated by
 * the F6 `prediction_markets` tool + F8.1a's seeded data). Synthetic fills
 * at midpoint × (1 ± slip_bps/10000) — NO orderbook walking at v1. Atomic
 * cash + position + fill updates via `db.transaction`.
 *
 * Symbol format for this adapter: `"{marketId}:{outcome}"`. Callers use the
 * market_id / outcome pair directly when building orders; the concatenated
 * symbol threads through Fill / OrderReject audit fields.
 *
 * Slippage default: 20 bps (double F8's equity 5 bps — PM spreads are
 * wider). Operator overrides at construction or via tool param.
 *
 * Full orderbook walking + level-by-level fill simulation deferred to
 * F8.1b.2; the reference port lives in `reference_polymarket_paper_trader.md`.
 */

import { randomUUID } from "node:crypto";
import type {
  Balance,
  Fill,
  GetFillsOpts,
  MarketQuote,
  Order,
  OrderResult,
  Position,
  VenueAdapter,
} from "./venue-types.js";
import { type Clock, WallClock } from "./clock.js";
import {
  DEFAULT_PM_ACCOUNT,
  DEFAULT_PM_INITIAL_CASH,
  applyPmBuyToPortfolio,
  applyPmSellToPortfolio,
  initPmAccount,
  insertPmFill,
  readPmBalance,
  readPmFills,
  readPmPortfolio,
  readPmPosition,
  updatePmCash,
} from "./pm-paper-persist.js";
import { getDatabase } from "../db/index.js";

/** Default round-trip slippage: 20 bps (PM spreads wider than equity). */
export const PM_PAPER_DEFAULT_SLIPPAGE_BPS = 20;
/** Max quote age (5 days). Longer than equity because PM liquidity refresh is slower. */
export const PM_PAPER_QUOTE_STALE_MS = 5 * 24 * 60 * 60 * 1000;

export interface PolymarketPaperAdapterOpts {
  account?: string;
  clock?: Clock;
  slippageBps?: number;
  initialCash?: number;
}

/**
 * Parse the adapter's `{marketId}:{outcome}` symbol format. Throws on
 * malformed input rather than silently falling back — caller bugs should
 * surface loudly.
 */
function parseSymbol(symbol: string): { marketId: string; outcome: string } {
  const idx = symbol.indexOf(":");
  if (idx <= 0 || idx === symbol.length - 1) {
    throw new Error(
      `PolymarketPaperAdapter: symbol must be '{marketId}:{outcome}', got '${symbol}'`,
    );
  }
  return {
    marketId: symbol.slice(0, idx),
    outcome: symbol.slice(idx + 1),
  };
}

/**
 * Pull the cached outcome price from `prediction_markets.outcome_tokens`
 * JSON. Returns null if the market is absent or the outcome label doesn't
 * match any entry in the parsed token array.
 */
function readCachedPmQuote(
  marketId: string,
  outcome: string,
): { price: number; asOf: string } | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT outcome_tokens, fetched_at
         FROM prediction_markets
         WHERE market_id = ?
         ORDER BY fetched_at DESC
         LIMIT 1`,
    )
    .get(marketId) as
    | { outcome_tokens: string | null; fetched_at: string }
    | undefined;
  if (!row || !row.outcome_tokens) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.outcome_tokens);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.label === "string" &&
      e.label === outcome &&
      typeof e.price === "number" &&
      Number.isFinite(e.price)
    ) {
      return { price: e.price, asOf: row.fetched_at };
    }
  }
  return null;
}

export class PolymarketPaperAdapter implements VenueAdapter {
  public readonly name = "polymarket_paper";
  public readonly clock: Clock;
  public readonly account: string;
  private readonly slippageBps: number;

  constructor(opts: PolymarketPaperAdapterOpts = {}) {
    this.clock = opts.clock ?? new WallClock();
    this.account = opts.account ?? DEFAULT_PM_ACCOUNT;
    this.slippageBps = opts.slippageBps ?? PM_PAPER_DEFAULT_SLIPPAGE_BPS;
    // Idempotent — safe on repeated instantiation.
    initPmAccount(this.account, opts.initialCash ?? DEFAULT_PM_INITIAL_CASH);
  }

  async getMarketData(symbol: string): Promise<MarketQuote> {
    const { marketId, outcome } = parseSymbol(symbol);
    const cached = readCachedPmQuote(marketId, outcome);
    if (!cached) {
      throw new Error(
        `polymarket_paper: no cached quote for ${marketId}/${outcome}`,
      );
    }
    const asOfMs = Date.parse(cached.asOf);
    const age = this.clock.now().getTime() - asOfMs;
    if (age > PM_PAPER_QUOTE_STALE_MS) {
      throw new Error(
        `polymarket_paper: stale quote for ${marketId}/${outcome} (fetched ${cached.asOf}, age ${Math.round(age / 86400000)}d)`,
      );
    }
    return {
      symbol,
      price: cached.price,
      asOf: cached.asOf,
      source: "cache",
    };
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    const nowIso = this.clock.now().toISOString();
    if (order.type !== "market" || order.timeInForce !== "day") {
      return {
        clientOrderId: order.clientOrderId,
        reason: "unsupported_order_type",
        rejectedAt: nowIso,
      };
    }
    if (!(order.quantity > 0)) {
      return {
        clientOrderId: order.clientOrderId,
        reason: "zero_quantity",
        rejectedAt: nowIso,
      };
    }

    let marketId: string;
    let outcome: string;
    try {
      ({ marketId, outcome } = parseSymbol(order.symbol));
    } catch {
      return {
        clientOrderId: order.clientOrderId,
        reason: "malformed_symbol",
        rejectedAt: nowIso,
      };
    }

    let quote: MarketQuote;
    try {
      quote = await this.getMarketData(order.symbol);
    } catch (err) {
      return {
        clientOrderId: order.clientOrderId,
        reason:
          err instanceof Error && /stale quote/.test(err.message)
            ? "stale_price"
            : "no_quote",
        rejectedAt: nowIso,
      };
    }

    const slipFactor = this.slippageBps / 10_000;
    const fillPrice =
      order.side === "buy"
        ? quote.price * (1 + slipFactor)
        : quote.price * (1 - slipFactor);
    const grossNotional = fillPrice * order.quantity;

    // Pre-flight: PM share price is in [0, 1]; reject if fill math breaks that.
    if (!Number.isFinite(fillPrice) || fillPrice <= 0 || fillPrice >= 1) {
      return {
        clientOrderId: order.clientOrderId,
        reason: "invalid_fill_price",
        rejectedAt: nowIso,
      };
    }

    // Pre-flight validation against cash + existing position.
    if (order.side === "sell") {
      const pos = readPmPosition(this.account, marketId, outcome);
      if (!pos || pos.shares < order.quantity - 1e-9) {
        return {
          clientOrderId: order.clientOrderId,
          reason: "short_sell",
          rejectedAt: nowIso,
        };
      }
    } else {
      const bal = readPmBalance(this.account)!;
      if (bal.cash_usdc < grossNotional - 1e-9) {
        return {
          clientOrderId: order.clientOrderId,
          reason: "insufficient_cash",
          rejectedAt: nowIso,
        };
      }
    }

    const fillId = randomUUID();
    const db = getDatabase();
    let realizedPnl: number | null = null;

    // Atomic: portfolio + balance + fill commit together.
    const tx = db.transaction(() => {
      if (order.side === "buy") {
        applyPmBuyToPortfolio({
          account: this.account,
          marketId,
          outcome,
          tokenId: null, // v1 doesn't carry token_id through the Order — caller can persist separately
          slug: null,
          shares: order.quantity,
          fillPrice,
          nowIso,
        });
        const bal = readPmBalance(this.account)!;
        updatePmCash(this.account, bal.cash_usdc - grossNotional, nowIso);
      } else {
        const res = applyPmSellToPortfolio({
          account: this.account,
          marketId,
          outcome,
          shares: order.quantity,
          fillPrice,
          nowIso,
        });
        realizedPnl = res.realizedPnl;
        const bal = readPmBalance(this.account)!;
        updatePmCash(this.account, bal.cash_usdc + grossNotional, nowIso);
      }
      insertPmFill({
        fillId,
        thesisId: null,
        account: this.account,
        marketId,
        outcome,
        tokenId: null,
        side: order.side,
        shares: order.quantity,
        fillPrice,
        grossNotional,
        slippageBps: this.slippageBps,
        realizedPnl,
        filledAt: nowIso,
      });
    });
    tx();

    const fill: Fill = {
      fillId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: fillPrice,
      grossNotional,
      commission: 0,
      slippageBps: this.slippageBps,
      filledAt: nowIso,
    };
    return fill;
  }

  async getPositions(): Promise<Position[]> {
    const rows = readPmPortfolio(this.account);
    const out: Position[] = [];
    for (const row of rows) {
      let price = row.avg_cost;
      let marketValue = row.shares * row.avg_cost;
      let stale = false;
      try {
        const q = await this.getMarketData(`${row.market_id}:${row.outcome}`);
        price = q.price;
        marketValue = row.shares * price;
      } catch {
        stale = true;
      }
      void price;
      out.push({
        kind: "polymarket",
        marketId: row.market_id,
        outcome: row.outcome,
        slug: row.slug,
        tokenId: row.token_id,
        shares: row.shares,
        avgCost: row.avg_cost,
        marketValue,
        unrealizedPnl: marketValue - row.shares * row.avg_cost,
        stale,
      });
    }
    return out;
  }

  async getBalance(): Promise<Balance> {
    const bal = readPmBalance(this.account)!;
    const positions = await this.getPositions();
    const positionsValue = positions.reduce((s, p) => s + p.marketValue, 0);
    return {
      cash: bal.cash_usdc,
      positionsValue,
      totalEquity: bal.cash_usdc + positionsValue,
    };
  }

  async getFills(opts: GetFillsOpts = {}): Promise<Fill[]> {
    // `symbol` in GetFillsOpts is `{marketId}:{outcome}` for this adapter.
    let marketId: string | undefined;
    let outcome: string | undefined;
    if (opts.symbol) {
      try {
        ({ marketId, outcome } = parseSymbol(opts.symbol));
      } catch {
        // Malformed filter → return empty. Parallel to equity adapter's
        // strict symbol match; avoids silent broad match.
        return [];
      }
    }
    const rows = readPmFills({
      account: this.account,
      marketId,
      outcome,
      since: opts.since,
      limit: opts.limit,
    });
    return rows.map((r) => ({
      fillId: r.fill_id,
      clientOrderId: r.fill_id,
      symbol: `${r.market_id}:${r.outcome}`,
      side: r.side,
      quantity: r.shares,
      price: r.fill_price,
      grossNotional: r.gross_notional,
      commission: 0,
      slippageBps: r.slippage_bps,
      filledAt: r.filled_at,
    }));
  }
}
