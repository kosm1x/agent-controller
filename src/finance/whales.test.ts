/**
 * Whale tracker tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

import {
  extractWhalesFromTrades,
  persistWhaleTrades,
  queryRecentWhales,
  DEFAULT_WHALE_USD,
  type WhaleTrade,
} from "./whales.js";
import type { PolymarketTrade } from "./prediction-markets.js";

function trade(overrides: Partial<PolymarketTrade> = {}): PolymarketTrade {
  return {
    id: "t1",
    marketId: "m1",
    makerAddress: "0xMAKER",
    takerAddress: "0xTAKER",
    side: "BUY",
    size: 10_000,
    price: 0.45,
    timestamp: "2026-04-17T14:30:00Z",
    outcomeTokenId: "tok-yes",
    ...overrides,
  };
}

describe("extractWhalesFromTrades", () => {
  it("filters out trades below default threshold", () => {
    const out = extractWhalesFromTrades([
      trade({ id: "small", size: 100 }),
      trade({ id: "big", size: 20_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sizeUsd).toBe(20_000);
  });

  it("default threshold is 5000", () => {
    expect(DEFAULT_WHALE_USD).toBe(5_000);
    const out = extractWhalesFromTrades([trade({ size: 5_000 })]);
    expect(out).toHaveLength(1);
    const out2 = extractWhalesFromTrades([trade({ size: 4_999 })]);
    expect(out2).toHaveLength(0);
  });

  it("respects custom threshold", () => {
    const out = extractWhalesFromTrades([trade({ size: 6_000 })], 10_000);
    expect(out).toHaveLength(0);
  });

  it("attributes wallet to taker and maps side", () => {
    const out = extractWhalesFromTrades([
      trade({ side: "SELL", size: 20_000, takerAddress: "0xABC" }),
    ]);
    expect(out[0].wallet).toBe("0xABC");
    expect(out[0].side).toBe("sell");
  });

  it("empty input returns empty output", () => {
    expect(extractWhalesFromTrades([])).toEqual([]);
  });
});

describe("persistWhaleTrades + queryRecentWhales", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts + queries back with metadata roundtrip", () => {
    const whales: WhaleTrade[] = [
      {
        source: "polymarket",
        wallet: "0xAAA",
        marketId: "mkt-A",
        side: "buy",
        sizeUsd: 42_500,
        price: 0.45,
        occurredAt: new Date().toISOString(),
        metadata: { tradeId: "t123", outcomeToken: "yes" },
      },
    ];
    expect(persistWhaleTrades(whales)).toBe(1);
    const rows = queryRecentWhales({ hours: 48 });
    expect(rows).toHaveLength(1);
    expect(rows[0].sizeUsd).toBe(42_500);
    expect(rows[0].metadata).toEqual({
      tradeId: "t123",
      outcomeToken: "yes",
    });
  });

  it("filters by market_id when provided", () => {
    const baseTs = new Date().toISOString();
    persistWhaleTrades([
      {
        source: "polymarket",
        wallet: "0xA",
        marketId: "m1",
        side: "buy",
        sizeUsd: 10_000,
        occurredAt: baseTs,
      },
      {
        source: "polymarket",
        wallet: "0xB",
        marketId: "m2",
        side: "sell",
        sizeUsd: 12_000,
        occurredAt: baseTs,
      },
    ]);
    const m1only = queryRecentWhales({ marketId: "m1" });
    expect(m1only).toHaveLength(1);
    expect(m1only[0].wallet).toBe("0xA");
  });

  it("filters by min size and hours window", () => {
    const now = new Date().toISOString();
    const weekAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    persistWhaleTrades([
      {
        source: "polymarket",
        wallet: "0x1",
        side: "buy",
        sizeUsd: 6_000,
        occurredAt: now,
      },
      {
        source: "polymarket",
        wallet: "0x2",
        side: "buy",
        sizeUsd: 50_000,
        occurredAt: weekAgo,
      },
    ]);
    // Default 24h + 5k threshold → only the fresh one
    const rows = queryRecentWhales();
    expect(rows).toHaveLength(1);
    expect(rows[0].wallet).toBe("0x1");
  });

  it("empty persist input returns 0", () => {
    expect(persistWhaleTrades([])).toBe(0);
  });
});
