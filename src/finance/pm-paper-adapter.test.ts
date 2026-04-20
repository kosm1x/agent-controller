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

import { FixedClock } from "./clock.js";
import { PolymarketPaperAdapter } from "./pm-paper-adapter.js";
import { isFill, isOrderReject, isPolymarketPosition } from "./venue-types.js";

/** Seed a prediction_markets row with a 2-outcome JSON token array. */
function seedMarket(opts: {
  marketId: string;
  yesPrice: number;
  fetchedAt?: string;
}) {
  const outcomes = JSON.stringify([
    { id: `${opts.marketId}-yes`, label: "Yes", price: opts.yesPrice },
    { id: `${opts.marketId}-no`, label: "No", price: 1 - opts.yesPrice },
  ]);
  db.prepare(
    `INSERT OR REPLACE INTO prediction_markets
      (source, market_id, slug, question, outcome_tokens, liquidity_usd,
       is_neg_risk, fetched_at)
     VALUES ('polymarket', ?, ?, ?, ?, 50000, 0, ?)`,
  ).run(
    opts.marketId,
    opts.marketId.replace(/[^a-z0-9]/gi, "-"),
    `test market ${opts.marketId}`,
    outcomes,
    opts.fetchedAt ?? "2026-04-20T00:00:00Z",
  );
}

const NOW = new Date("2026-04-20T16:00:00Z");

describe("PolymarketPaperAdapter construction + balance", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("initializes default account with $10K USDC", async () => {
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const bal = await adapter.getBalance();
    expect(bal.cash).toBe(10_000);
    expect(bal.totalEquity).toBe(10_000);
    expect(bal.positionsValue).toBe(0);
  });

  it("supports custom initial cash on first construction", async () => {
    const adapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
      initialCash: 50_000,
    });
    expect((await adapter.getBalance()).cash).toBe(50_000);
  });
});

describe("PolymarketPaperAdapter.getMarketData", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns cached midpoint from prediction_markets", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const q = await adapter.getMarketData("0xm1:Yes");
    expect(q.price).toBe(0.4);
    expect(q.source).toBe("cache");
  });

  it("errors when market not cached", async () => {
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await expect(adapter.getMarketData("0xmissing:Yes")).rejects.toThrow(
      /no cached quote/,
    );
  });

  it("errors when outcome label doesn't match cached tokens", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await expect(adapter.getMarketData("0xm1:NonExistent")).rejects.toThrow(
      /no cached quote/,
    );
  });

  it("errors on malformed symbol", async () => {
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await expect(adapter.getMarketData("malformed-no-colon")).rejects.toThrow(
      /symbol must be/,
    );
  });

  it("errors when cached quote is stale (>5 days)", async () => {
    seedMarket({
      marketId: "0xm1",
      yesPrice: 0.4,
      fetchedAt: "2026-04-10T00:00:00Z", // 10 days old
    });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await expect(adapter.getMarketData("0xm1:Yes")).rejects.toThrow(/stale/);
  });
});

describe("PolymarketPaperAdapter.placeOrder (buy)", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fills a buy at midpoint × (1 + 20bps), deducts cash, records position", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    expect(isFill(result)).toBe(true);
    if (!isFill(result)) return;
    expect(result.price).toBeCloseTo(0.4 * (1 + 20e-4), 10);
    expect(result.grossNotional).toBeCloseTo(0.4008 * 100, 6);
    expect(result.slippageBps).toBe(20);

    const bal = await adapter.getBalance();
    expect(bal.cash).toBeCloseTo(10_000 - result.grossNotional, 6);

    const positions = await adapter.getPositions();
    expect(positions.length).toBe(1);
    const p = positions[0]!;
    expect(isPolymarketPosition(p)).toBe(true);
    if (!isPolymarketPosition(p)) return;
    expect(p.marketId).toBe("0xm1");
    expect(p.outcome).toBe("Yes");
    expect(p.shares).toBe(100);
  });

  it("rejects a buy with insufficient cash", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
      initialCash: 10, // not enough for 100 shares at ~$0.40 each
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("insufficient_cash");
  });

  it("rejects zero-quantity order", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 0,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("zero_quantity");
  });

  it("rejects stale-price order", async () => {
    seedMarket({
      marketId: "0xm1",
      yesPrice: 0.4,
      fetchedAt: "2026-01-01T00:00:00Z",
    });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 1,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("stale_price");
  });

  it("rejects malformed symbol", async () => {
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "no-colon",
      side: "buy",
      quantity: 1,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("malformed_symbol");
  });

  it("rejects invalid_fill_price when slippage pushes price out of [0, 1]", async () => {
    // yesPrice=0.995 + 20 bps slippage → ~0.997; still < 1. Need yesPrice=0.9995 or huge slip
    seedMarket({ marketId: "0xm1", yesPrice: 0.9995 });
    const adapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
      slippageBps: 60, // 0.9995 × 1.006 ≈ 1.0055 > 1
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 1,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("invalid_fill_price");
  });
});

describe("PolymarketPaperAdapter.placeOrder (sell)", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fills a sell at midpoint × (1 − slippage), realizes P&L", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await adapter.placeOrder({
      clientOrderId: "buy-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    // Simulate price movement — re-seed with higher yesPrice
    seedMarket({ marketId: "0xm1", yesPrice: 0.55 });
    const result = await adapter.placeOrder({
      clientOrderId: "sell-1",
      symbol: "0xm1:Yes",
      side: "sell",
      quantity: 50,
      type: "market",
      timeInForce: "day",
    });
    expect(isFill(result)).toBe(true);
    if (!isFill(result)) return;
    expect(result.price).toBeCloseTo(0.55 * (1 - 20e-4), 10);
    const positions = await adapter.getPositions();
    expect(positions[0]!.shares).toBe(50);
  });

  it("rejects a sell exceeding held shares", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await adapter.placeOrder({
      clientOrderId: "sell-1",
      symbol: "0xm1:Yes",
      side: "sell",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("short_sell");
  });

  it("full sell deletes the position row", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await adapter.placeOrder({
      clientOrderId: "buy-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    await adapter.placeOrder({
      clientOrderId: "sell-1",
      symbol: "0xm1:Yes",
      side: "sell",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    expect((await adapter.getPositions()).length).toBe(0);
  });
});

describe("PolymarketPaperAdapter.getPositions + getFills", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("marks positions to market using latest midpoint", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await adapter.placeOrder({
      clientOrderId: "b-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 100,
      type: "market",
      timeInForce: "day",
    });
    // Re-seed with a higher price
    seedMarket({ marketId: "0xm1", yesPrice: 0.55 });
    const positions = await adapter.getPositions();
    expect(positions[0]!.marketValue).toBeCloseTo(0.55 * 100, 6);
    expect(positions[0]!.unrealizedPnl).toBeGreaterThan(0);
  });

  it("getFills filters by symbol {marketId}:{outcome}", async () => {
    seedMarket({ marketId: "0xm1", yesPrice: 0.4 });
    seedMarket({ marketId: "0xm2", yesPrice: 0.3 });
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await adapter.placeOrder({
      clientOrderId: "b-1",
      symbol: "0xm1:Yes",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    await adapter.placeOrder({
      clientOrderId: "b-2",
      symbol: "0xm2:Yes",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    expect((await adapter.getFills()).length).toBe(2);
    expect((await adapter.getFills({ symbol: "0xm1:Yes" })).length).toBe(1);
    // Malformed filter → empty result (not all-fills)
    expect((await adapter.getFills({ symbol: "malformed" })).length).toBe(0);
  });
});
