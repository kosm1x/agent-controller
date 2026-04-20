/**
 * F8 Paper Trading — PaperEquityAdapter.
 *
 * First concrete VenueAdapter. AV-backed market data (last weekly close),
 * synthetic fills at close × slippage, single-transaction atomic cash +
 * portfolio updates. Commission defaults to 0 bps (equity brokers are
 * commission-free in retail equity); configurable per adapter construction.
 *
 * Slippage is a fixed 5 bps per side, matching F7.5's default cost model
 * so backtest-to-paper divergence is minimized.
 *
 * This is paper — every fill is synthetic. No external order submission, no
 * venue risk, no settlement delay. But the domain model matches what live
 * F11 adapters will see.
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
import { getDataLayer, type DataLayer } from "./data-layer.js";
import {
  DEFAULT_ACCOUNT,
  DEFAULT_INITIAL_CASH,
  applyBuyToPortfolio,
  applySellToPortfolio,
  initAccount,
  insertFill,
  readBalance,
  readFills,
  readPortfolio,
  readPosition,
  updateCash,
} from "./paper-persist.js";
import { getDatabase } from "../db/index.js";

/** Default round-trip slippage: 5 bps, matching F7.5's cost model. */
export const PAPER_DEFAULT_SLIPPAGE_BPS = 5;
/** Commission — equity retail brokers are commission-free in 2026. */
export const PAPER_DEFAULT_COMMISSION_BPS = 0;
/** Max bar age accepted as a valid price quote. 5 weeks = stale. */
export const PAPER_QUOTE_STALE_MS = 35 * 24 * 60 * 60 * 1000;

export interface PaperEquityAdapterOpts {
  account?: string;
  clock?: Clock;
  slippageBps?: number;
  commissionBps?: number;
  initialCash?: number;
  /** Injected for tests. Defaults to `getDataLayer()`. */
  dataLayer?: DataLayer;
}

export class PaperEquityAdapter implements VenueAdapter {
  public readonly name = "paper_equity";
  public readonly clock: Clock;
  public readonly account: string;
  private readonly slippageBps: number;
  private readonly commissionBps: number;
  private readonly dataLayer: DataLayer;

  constructor(opts: PaperEquityAdapterOpts = {}) {
    this.clock = opts.clock ?? new WallClock();
    this.account = opts.account ?? DEFAULT_ACCOUNT;
    this.slippageBps = opts.slippageBps ?? PAPER_DEFAULT_SLIPPAGE_BPS;
    this.commissionBps = opts.commissionBps ?? PAPER_DEFAULT_COMMISSION_BPS;
    this.dataLayer = opts.dataLayer ?? getDataLayer();
    // Idempotent — safe on repeated instantiation.
    initAccount(this.account, opts.initialCash ?? DEFAULT_INITIAL_CASH);
  }

  async getMarketData(symbol: string): Promise<MarketQuote> {
    const result = await this.dataLayer.getWeekly(symbol, { lookback: 1 });
    const last = result.bars[result.bars.length - 1];
    if (!last) {
      throw new Error(`paper_equity: no weekly bars available for ${symbol}`);
    }
    const asOfMs = Date.parse(last.timestamp);
    const age = this.clock.now().getTime() - asOfMs;
    if (age > PAPER_QUOTE_STALE_MS) {
      throw new Error(
        `paper_equity: stale quote for ${symbol} (last bar ${last.timestamp}, age ${Math.round(age / 86400000)}d)`,
      );
    }
    return {
      symbol,
      price: last.close,
      asOf: last.timestamp,
      source: "weekly_close",
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
    const commission = (this.commissionBps / 10_000) * grossNotional;

    // Pre-flight validation against portfolio + cash — before opening the
    // transaction so we don't leave partial state on reject.
    if (order.side === "sell") {
      const pos = readPosition(this.account, order.symbol);
      if (!pos || pos.shares < order.quantity - 1e-9) {
        return {
          clientOrderId: order.clientOrderId,
          reason: "short_sell",
          rejectedAt: nowIso,
        };
      }
    } else {
      const bal = readBalance(this.account)!;
      if (bal.cash < grossNotional + commission - 1e-9) {
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

    // Atomic commit: portfolio row + balance + fills row either all succeed
    // or all roll back. Without this, a crash between writes would leave the
    // portfolio out of sync with cash.
    const tx = db.transaction(() => {
      if (order.side === "buy") {
        applyBuyToPortfolio({
          account: this.account,
          symbol: order.symbol,
          shares: order.quantity,
          fillPrice,
          nowIso,
        });
        const bal = readBalance(this.account)!;
        updateCash(this.account, bal.cash - grossNotional - commission, nowIso);
      } else {
        const res = applySellToPortfolio({
          account: this.account,
          symbol: order.symbol,
          shares: order.quantity,
          fillPrice,
          nowIso,
        });
        realizedPnl = res.realizedPnl;
        const bal = readBalance(this.account)!;
        updateCash(this.account, bal.cash + grossNotional - commission, nowIso);
      }
      insertFill({
        fillId,
        thesisId: null, // caller may link via a follow-up UPDATE if needed
        account: this.account,
        symbol: order.symbol,
        side: order.side,
        shares: order.quantity,
        fillPrice,
        grossNotional,
        commission,
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
      commission,
      slippageBps: this.slippageBps,
      filledAt: nowIso,
    };
    return fill;
  }

  async getPositions(): Promise<Position[]> {
    const rows = readPortfolio(this.account);
    const out: Position[] = [];
    for (const row of rows) {
      let price = row.avg_cost;
      let marketValue = row.shares * row.avg_cost;
      let stale = false;
      try {
        const q = await this.getMarketData(row.symbol);
        price = q.price;
        marketValue = row.shares * price;
      } catch {
        // Stale / missing quote: fall back to avg_cost so positions surface
        // rather than crash. Marked `stale=true` (audit W2 round 1) so callers
        // can refuse to size new trades against a distorted totalEquity.
        stale = true;
      }
      // Silence unused — kept as a clear local var for the `price === avg_cost`
      // path above; future intraday_quote handling may diverge.
      void price;
      out.push({
        kind: "equity",
        symbol: row.symbol,
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
    const bal = readBalance(this.account)!;
    const positions = await this.getPositions();
    const positionsValue = positions.reduce((s, p) => s + p.marketValue, 0);
    return {
      cash: bal.cash,
      positionsValue,
      totalEquity: bal.cash + positionsValue,
    };
  }

  async getFills(opts: GetFillsOpts = {}): Promise<Fill[]> {
    const rows = readFills({
      account: this.account,
      symbol: opts.symbol,
      since: opts.since,
      limit: opts.limit,
    });
    return rows.map((r) => ({
      fillId: r.fill_id,
      clientOrderId: r.fill_id, // we don't persist clientOrderId — use fillId as the echo
      symbol: r.symbol,
      side: r.side,
      quantity: r.shares,
      price: r.fill_price,
      grossNotional: r.gross_notional,
      commission: r.commission,
      slippageBps: r.slippage_bps,
      filledAt: r.filled_at,
    }));
  }
}
