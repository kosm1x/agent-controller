/**
 * F6 Whale Tracker — reads Polymarket trade history + transforms to WhaleTrade
 * records. SEC EDGAR Form 4 insider filings deferred (impl plan §1).
 */

import { getDatabase } from "../db/index.js";
import type { PolymarketTrade } from "./prediction-markets.js";

export interface WhaleTrade {
  source: "polymarket" | "sec_edgar";
  wallet: string;
  marketId?: string;
  side: "buy" | "sell" | "long" | "short";
  sizeUsd: number;
  price?: number;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

/** Default "clearly not retail" threshold. Override per-call. */
export const DEFAULT_WHALE_USD = 5_000;

/**
 * Filter Polymarket trades above the USD threshold and transform to
 * normalized WhaleTrade. The `wallet` we attribute to is the TAKER — it's
 * the active side that moved the market.
 */
export function extractWhalesFromTrades(
  trades: PolymarketTrade[],
  minSizeUsd: number = DEFAULT_WHALE_USD,
): WhaleTrade[] {
  const out: WhaleTrade[] = [];
  for (const t of trades) {
    if (t.size < minSizeUsd) continue;
    out.push({
      source: "polymarket",
      wallet: t.takerAddress,
      marketId: t.marketId,
      side: t.side === "BUY" ? "buy" : "sell",
      sizeUsd: t.size,
      price: t.price,
      occurredAt: t.timestamp,
      metadata: {
        tradeId: t.id,
        maker: t.makerAddress,
        outcomeToken: t.outcomeTokenId,
      },
    });
  }
  return out;
}

/**
 * Append whale trades to the whale_trades table. No dedup (allows historical
 * re-fetch to surface trades missed earlier); F9 ritual will do periodic
 * `DELETE FROM whale_trades WHERE occurred_at < datetime('now','-90 days')`.
 */
export function persistWhaleTrades(trades: WhaleTrade[]): number {
  if (trades.length === 0) return 0;
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO whale_trades
      (source, wallet, market_id, side, size_usd, price, occurred_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction((all: WhaleTrade[]) => {
    for (const w of all) {
      insert.run(
        w.source,
        w.wallet,
        w.marketId ?? null,
        w.side,
        w.sizeUsd,
        w.price ?? null,
        w.occurredAt,
        w.metadata ? JSON.stringify(w.metadata) : null,
      );
      inserted++;
    }
  });
  tx(trades);
  return inserted;
}

export interface WhaleQueryOpts {
  marketId?: string;
  minSizeUsd?: number;
  hours?: number;
  limit?: number;
}

/**
 * Query recent whale activity. Default: last 24h, >=$5k, 20 results.
 * Returns newest-first.
 */
export function queryRecentWhales(opts: WhaleQueryOpts = {}): WhaleTrade[] {
  const db = getDatabase();
  const minSize = opts.minSizeUsd ?? DEFAULT_WHALE_USD;
  const hours = opts.hours ?? 24;
  const limit = Math.min(opts.limit ?? 20, 200);
  const rows = (
    opts.marketId
      ? db
          .prepare(
            `SELECT source, wallet, market_id, side, size_usd, price, occurred_at, metadata
             FROM whale_trades
             WHERE size_usd >= ?
               AND market_id = ?
               AND occurred_at > datetime('now', ?)
             ORDER BY occurred_at DESC
             LIMIT ?`,
          )
          .all(minSize, opts.marketId, `-${hours} hours`, limit)
      : db
          .prepare(
            `SELECT source, wallet, market_id, side, size_usd, price, occurred_at, metadata
             FROM whale_trades
             WHERE size_usd >= ?
               AND occurred_at > datetime('now', ?)
             ORDER BY occurred_at DESC
             LIMIT ?`,
          )
          .all(minSize, `-${hours} hours`, limit)
  ) as Array<{
    source: WhaleTrade["source"];
    wallet: string;
    market_id: string | null;
    side: WhaleTrade["side"];
    size_usd: number;
    price: number | null;
    occurred_at: string;
    metadata: string | null;
  }>;
  return rows.map((r) => ({
    source: r.source,
    wallet: r.wallet,
    marketId: r.market_id ?? undefined,
    side: r.side,
    sizeUsd: r.size_usd,
    price: r.price ?? undefined,
    occurredAt: r.occurred_at,
    metadata: r.metadata ? safeParse(r.metadata) : undefined,
  }));
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
