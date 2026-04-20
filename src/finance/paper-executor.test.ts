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
import { planOrders, runRebalance } from "./paper-executor.js";
import { PaperEquityAdapter } from "./paper-equity-adapter.js";
import type { DataLayer } from "./data-layer.js";
import type { MarketBar } from "./types.js";

function mockDataLayer(
  quotes: Record<string, { close: number; asOf: string }>,
): DataLayer {
  return {
    async getWeekly(
      symbol: string,
    ): Promise<{ bars: MarketBar[]; provider: "alpha_vantage" }> {
      const q = quotes[symbol];
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

describe("planOrders", () => {
  it("no current positions, single-symbol target → one buy order", () => {
    const { orders } = planOrders({
      currentShares: {},
      quotes: { AAPL: 200 },
      targetWeights: { AAPL: 0.5 },
      totalEquity: 100_000,
    });
    expect(orders.length).toBe(1);
    expect(orders[0]!.side).toBe("buy");
    expect(orders[0]!.symbol).toBe("AAPL");
    // target = 50_000 × (1 − TARGET_CASH_BUFFER 20bps) / 200 = 249.5 shares
    expect(orders[0]!.quantity).toBe(249.5);
  });

  it("sells are ordered before buys", () => {
    const { orders } = planOrders({
      currentShares: { AAPL: 100, MSFT: 0 },
      quotes: { AAPL: 200, MSFT: 300 },
      targetWeights: { AAPL: 0, MSFT: 0.5 },
      totalEquity: 100_000,
    });
    expect(orders[0]!.side).toBe("sell");
    expect(orders[orders.length - 1]!.side).toBe("buy");
  });

  it("no-change symbols produce no orders (within buffer)", () => {
    // Already holding the derated target — no trades. Delta between current
    // (250) and derated target (249.5) is 0.1% equity, below MIN_REBALANCE.
    const { orders } = planOrders({
      currentShares: { AAPL: 250 },
      quotes: { AAPL: 200 },
      targetWeights: { AAPL: 0.5 },
      totalEquity: 100_000,
    });
    expect(orders.length).toBe(0);
  });

  it("exact-match to derated target produces no orders", () => {
    const { orders } = planOrders({
      currentShares: { AAPL: 249.5 },
      quotes: { AAPL: 200 },
      targetWeights: { AAPL: 0.5 },
      totalEquity: 100_000,
    });
    expect(orders.length).toBe(0);
  });

  it("skips symbols with no price (degrades gracefully)", () => {
    const { orders, skipped } = planOrders({
      currentShares: {},
      quotes: {},
      targetWeights: { AAPL: 0.5 },
      totalEquity: 100_000,
    });
    expect(orders.length).toBe(0);
    expect(skipped).toContain("AAPL:no_price");
  });

  it("skips dust trades below MIN_REBALANCE_FRACTION", () => {
    // Current=249.5 (exact derated target); weight barely off → dust delta.
    const { orders } = planOrders({
      currentShares: { AAPL: 249.5 },
      quotes: { AAPL: 200 },
      targetWeights: { AAPL: 0.4999999 },
      totalEquity: 100_000,
    });
    expect(orders.length).toBe(0);
  });

  it("weights summing to <1 leave cash (no buy for missing weight)", () => {
    const { orders } = planOrders({
      currentShares: {},
      quotes: { AAPL: 200, MSFT: 300 },
      targetWeights: { AAPL: 0.3, MSFT: 0.3 }, // 40% cash target
      totalEquity: 100_000,
    });
    expect(orders.length).toBe(2);
    expect(orders.every((o) => o.side === "buy")).toBe(true);
  });
});

describe("runRebalance (integration with PaperEquityAdapter)", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("first rebalance: empty portfolio → buys target weights", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({
        AAPL: { close: 200, asOf: LAST_BAR },
        MSFT: { close: 300, asOf: LAST_BAR },
      }),
    });
    const result = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.5, MSFT: 0.5 },
      alphaRunId: "alpha-1",
      backtestRunId: "bt-1",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    expect(result.fills.length).toBe(2);
    expect(result.rejects.length).toBe(0);
    // cashAfter ≈ 0 minus slippage; ordersPlanned=2
    expect(result.ordersPlanned).toBe(2);
    expect(result.thesisId).toBeGreaterThan(0);
    const positions = await adapter.getPositions();
    expect(positions.length).toBe(2);
  });

  it("second rebalance: rotates weights — sells first, buys after", async () => {
    const clock = new FixedClock(NOW);
    const adapter = new PaperEquityAdapter({
      clock,
      dataLayer: mockDataLayer({
        AAPL: { close: 200, asOf: LAST_BAR },
        MSFT: { close: 300, asOf: LAST_BAR },
      }),
    });
    await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.8, MSFT: 0.2 },
      alphaRunId: "alpha-1",
      backtestRunId: "bt-1",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    // Now rotate to MSFT-heavy
    const result = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.2, MSFT: 0.8 },
      alphaRunId: "alpha-1",
      backtestRunId: "bt-1",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    // Should have at least one sell + one buy. Sell first.
    expect(result.fills.length).toBeGreaterThanOrEqual(2);
    expect(result.fills[0]!.side).toBe("sell");
    expect(result.fills[result.fills.length - 1]!.side).toBe("buy");
  });

  it("persists a PORTFOLIO thesis row with override flag + run ids", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const res = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.3 },
      alphaRunId: "alpha-xyz",
      backtestRunId: "bt-xyz",
      regime: "risk_on",
      shipBlocked: true,
      overrideShip: true,
      notes: "smoke test",
    });
    const row = db
      .prepare(`SELECT * FROM trade_theses WHERE id = ?`)
      .get(res.thesisId) as {
      symbol: string;
      thesis_text: string;
      metadata: string;
    };
    expect(row.symbol).toBe("PORTFOLIO");
    const thesis = JSON.parse(row.thesis_text);
    expect(thesis.alpha_run_id).toBe("alpha-xyz");
    expect(thesis.override_ship).toBe(true);
    expect(thesis.regime).toBe("risk_on");
    expect(thesis.notes).toBe("smoke test");
  });

  it("empty target weights + empty portfolio → no-op thesis with 0 fills", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({}),
    });
    const result = await runRebalance({
      adapter,
      targetWeights: {},
      alphaRunId: null,
      backtestRunId: null,
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    expect(result.fills.length).toBe(0);
    expect(result.rejects.length).toBe(0);
    // Thesis row still written for audit continuity
    expect(result.thesisId).toBeGreaterThan(0);
  });

  it("includes rejects in summary if a symbol has no price", async () => {
    // AAPL has a price, MSFT doesn't → MSFT is skipped, AAPL fills.
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const result = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.5, MSFT: 0.5 },
      alphaRunId: "alpha-1",
      backtestRunId: "bt-1",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    expect(result.fills.some((f) => f.symbol === "AAPL")).toBe(true);
    expect(result.fills.some((f) => f.symbol === "MSFT")).toBe(false);
    expect(result.ordersSkipped).toBeGreaterThan(0);
  });

  it("propagates OrderReject from adapter into summary.rejects (audit W6)", async () => {
    // Mock adapter that rejects every order.
    const rejectingAdapter = {
      name: "reject-all",
      clock: new FixedClock(NOW),
      async getMarketData(symbol: string) {
        return {
          symbol,
          price: 100,
          asOf: LAST_BAR,
          source: "weekly_close" as const,
        };
      },
      async placeOrder(order: {
        clientOrderId: string;
        symbol: string;
      }): Promise<{
        clientOrderId: string;
        reason: string;
        rejectedAt: string;
      }> {
        return {
          clientOrderId: order.clientOrderId,
          reason: "insufficient_cash",
          rejectedAt: NOW.toISOString(),
        };
      },
      async getPositions() {
        return [];
      },
      async getBalance() {
        return { cash: 1000, positionsValue: 0, totalEquity: 1000 };
      },
      async getFills() {
        return [];
      },
    };
    const result = await runRebalance({
      // deliberately loose type — this is a stand-in for tests
      adapter: rejectingAdapter as unknown as Parameters<
        typeof runRebalance
      >[0]["adapter"],
      targetWeights: { AAPL: 0.5 },
      alphaRunId: "a",
      backtestRunId: "b",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    expect(result.rejects.length).toBeGreaterThan(0);
    expect(result.rejects[0]!.reason).toBe("insufficient_cash");
    expect(result.fills.length).toBe(0);
  });

  it("allowStale bypasses the stale-abort path (audit W-R2-3)", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    await adapter.placeOrder({
      clientOrderId: "b",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    // Rewire to empty → AAPL is stale
    (adapter as unknown as { dataLayer: unknown }).dataLayer = mockDataLayer(
      {},
    );
    const result = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.5 },
      alphaRunId: "a",
      backtestRunId: "b",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
      allowStale: true,
    });
    // Rebalance should attempt orders; even if they reject the abort flag
    // should NOT be set.
    expect(result.stalePositionsAborted).toBe(false);
    expect(result.staleSymbols).toContain("AAPL");
  });

  it("fills carry the thesis_id after linkFillsToThesis (audit W-R2-6)", async () => {
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    const result = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.5 },
      alphaRunId: "a",
      backtestRunId: "b",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    // result.fills should be non-empty with thesis linkage in DB
    expect(result.fills.length).toBeGreaterThan(0);
    const linked = db
      .prepare(`SELECT COUNT(*) AS n FROM paper_fills WHERE thesis_id = ?`)
      .get(result.thesisId) as { n: number };
    expect(linked.n).toBe(result.fills.length);
  });

  it("aborts when held positions have stale quotes (audit W2)", async () => {
    // Seed a position by doing one successful rebalance, then swap the
    // data layer so the next getMarketData returns no bars for the held
    // symbol → adapter marks position stale.
    const adapter = new PaperEquityAdapter({
      clock: new FixedClock(NOW),
      dataLayer: mockDataLayer({ AAPL: { close: 200, asOf: LAST_BAR } }),
    });
    await adapter.placeOrder({
      clientOrderId: "b",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      type: "market",
      timeInForce: "day",
    });
    // Rewire adapter's dataLayer to an empty one.
    (adapter as unknown as { dataLayer: unknown }).dataLayer = mockDataLayer(
      {},
    );
    const result = await runRebalance({
      adapter,
      targetWeights: { AAPL: 0.5 },
      alphaRunId: "a",
      backtestRunId: "b",
      regime: null,
      shipBlocked: false,
      overrideShip: false,
    });
    expect(result.stalePositionsAborted).toBe(true);
    expect(result.staleSymbols).toContain("AAPL");
    expect(result.fills.length).toBe(0);
  });
});
