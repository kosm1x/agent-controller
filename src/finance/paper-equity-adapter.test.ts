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
import { PaperEquityAdapter } from "./paper-equity-adapter.js";
import type { DataLayer } from "./data-layer.js";
import type { MarketBar } from "./types.js";
import { isFill, isOrderReject, isEquityPosition } from "./venue-types.js";

/** Build a mock DataLayer whose getWeekly returns a synthetic bar. */
function mockDataLayer(
  quotesBySymbol: Record<string, { close: number; asOf: string }>,
): DataLayer {
  return {
    async getWeekly(
      symbol: string,
    ): Promise<{ bars: MarketBar[]; provider: "alpha_vantage" }> {
      const q = quotesBySymbol[symbol];
      if (!q) return { bars: [], provider: "alpha_vantage" };
      const bar: MarketBar = {
        symbol,
        timestamp: q.asOf,
        open: q.close,
        high: q.close,
        low: q.close,
        close: q.close,
        volume: 1,
        provider: "alpha_vantage",
        interval: "weekly",
      };
      return { bars: [bar], provider: "alpha_vantage" };
    },
  } as unknown as DataLayer;
}

const NOW = new Date("2026-04-20T16:00:00Z");
const LAST_BAR = "2026-04-17T16:00:00-04:00";

describe("PaperEquityAdapter construction + balance", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("initializes account with default $100K cash", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({}),
    });
    const bal = await adapter.getBalance();
    expect(bal.cash).toBe(100_000);
    expect(bal.totalEquity).toBe(100_000);
    expect(bal.positionsValue).toBe(0);
  });

  it("supports custom initial cash on first construction", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({}),
      initialCash: 500_000,
    });
    expect((await adapter.getBalance()).cash).toBe(500_000);
  });
});

describe("PaperEquityAdapter.getMarketData", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns weekly close as the quote", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const quote = await adapter.getMarketData("AAPL");
    expect(quote.price).toBe(200);
    expect(quote.source).toBe("weekly_close");
    expect(quote.symbol).toBe("AAPL");
  });

  it("errors when no bars available", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({}),
    });
    await expect(adapter.getMarketData("AAPL")).rejects.toThrow(
      /no weekly bars/,
    );
  });

  it("errors when last bar is stale (>5 weeks)", async () => {
    // Bar is 60 days old — well past PAPER_QUOTE_STALE_MS of 35 days.
    const staleBar = "2026-02-13T16:00:00-05:00";
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: staleBar } }),
    });
    await expect(adapter.getMarketData("AAPL")).rejects.toThrow(/stale/);
  });
});

describe("PaperEquityAdapter.placeOrder (buy)", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fills a buy at close × (1 + slippage), deducts cash, records position", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    expect(isFill(result)).toBe(true);
    if (!isFill(result)) return; // type narrowing
    expect(result.price).toBeCloseTo(200 * (1 + 5e-4), 10);
    expect(result.grossNotional).toBeCloseTo(200 * 1.0005 * 10, 10);
    expect(result.commission).toBe(0);

    const bal = await adapter.getBalance();
    expect(bal.cash).toBeCloseTo(100_000 - result.grossNotional, 10);

    const positions = await adapter.getPositions();
    expect(positions.length).toBe(1);
    const pos0 = positions[0]!;
    expect(isEquityPosition(pos0)).toBe(true);
    if (!isEquityPosition(pos0)) throw new Error("expected equity position");
    expect(pos0.symbol).toBe("AAPL");
    expect(pos0.shares).toBe(10);
    expect(pos0.avgCost).toBeCloseTo(result.price, 10);
  });

  it("rejects a buy with insufficient cash", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
      initialCash: 1000, // only enough for 5 shares at 200, but we order 10
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("insufficient_cash");
    // Cash untouched
    const bal = await adapter.getBalance();
    expect(bal.cash).toBe(1000);
  });

  it("rejects a buy with zero quantity", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 0,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("zero_quantity");
  });

  it("rejects when quote is stale", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({
        AAPL: { close: 200, asOf: "2026-01-01T16:00:00-05:00" },
      }),
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("stale_price");
  });
});

describe("PaperEquityAdapter.placeOrder (sell)", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fills a sell at close × (1 − slippage), realizes P&L", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    // Buy first
    await adapter.placeOrder({
      clientOrderId: "buy-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    // Sell at higher price
    const adapter2 = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 220, asOf: LAST_BAR } }),
    });
    const result = await adapter2.placeOrder({
      clientOrderId: "sell-1",
      symbol: "AAPL",
      side: "sell",
      quantity: 5,
      type: "market",
      timeInForce: "day",
    });
    expect(isFill(result)).toBe(true);
    if (!isFill(result)) return;
    expect(result.price).toBeCloseTo(220 * (1 - 5e-4), 10);
    // 5 remaining shares
    const positions = await adapter2.getPositions();
    expect(positions[0]!.shares).toBe(5);
  });

  it("rejects a sell exceeding held shares", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const result = await adapter.placeOrder({
      clientOrderId: "coid-1",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    expect(isOrderReject(result)).toBe(true);
    if (isOrderReject(result)) expect(result.reason).toBe("short_sell");
  });

  it("full sell deletes the portfolio row", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    await adapter.placeOrder({
      clientOrderId: "buy-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    await adapter.placeOrder({
      clientOrderId: "sell-1",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    expect((await adapter.getPositions()).length).toBe(0);
  });
});

describe("PaperEquityAdapter.getPositions + getBalance", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("marks to market using latest quote", async () => {
    // Buy at 200, mark-to-market at 220 → +$200 unrealized P&L
    const adapterBuy = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    await adapterBuy.placeOrder({
      clientOrderId: "b-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    const adapterMtM = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 220, asOf: LAST_BAR } }),
    });
    const positions = await adapterMtM.getPositions();
    expect(positions[0]!.marketValue).toBeCloseTo(220 * 10, 10);
    expect(positions[0]!.unrealizedPnl).toBeGreaterThan(0);
  });

  it("getFills round-trips", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    await adapter.placeOrder({
      clientOrderId: "b-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    const fills = await adapter.getFills();
    expect(fills.length).toBe(1);
    expect(fills[0]!.symbol).toBe("AAPL");
    expect(fills[0]!.side).toBe("buy");
  });
});
