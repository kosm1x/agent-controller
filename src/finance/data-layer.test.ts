/**
 * DataLayer tests — cache, dispatch, fallback, dedup, watchlist CRUD.
 *
 * Uses an in-memory SQLite seeded with the F1 subset of schema.sql so the
 * persist/query paths run against real SQL, not a mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  // Extract only the F1 section of the schema
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  // All six F1 table + index definitions are after the "F1 Data Layer" marker
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    alphaVantageApiKey: "test-av",
    polygonApiKey: "test-poly",
    polygonBaseUrl: "https://api.massive.com/v2",
    fredApiKey: "test-fred",
  }),
}));

import { DataLayer } from "./data-layer.js";
import { AlphaVantageAdapter } from "./adapters/alpha-vantage.js";
import { PolygonAdapter } from "./adapters/polygon.js";
import { FredAdapter } from "./adapters/fred.js";
import { __resetForTests } from "./rate-limit.js";
import { DataUnavailableError, RateLimitedError } from "./types.js";
import type { MarketBar } from "./types.js";

function makeBar(overrides: Partial<MarketBar> = {}): MarketBar {
  return {
    symbol: "SPY",
    timestamp: new Date().toISOString(),
    open: 520,
    high: 525,
    low: 518,
    close: 523,
    volume: 50_000_000,
    provider: "alpha_vantage",
    interval: "daily",
    ...overrides,
  };
}

function makeAvStub(bars: MarketBar[] | (() => Promise<MarketBar[]>)) {
  const av = Object.create(AlphaVantageAdapter.prototype);
  av.provider = "alpha_vantage";
  av.fetchDaily = vi
    .fn()
    .mockImplementation(() =>
      typeof bars === "function" ? bars() : Promise.resolve(bars),
    );
  return av as AlphaVantageAdapter;
}

function makePolyStub(bars: MarketBar[]) {
  const p = Object.create(PolygonAdapter.prototype);
  p.provider = "polygon";
  p.fetchDaily = vi.fn().mockResolvedValue(bars);
  return p as PolygonAdapter;
}

describe("DataLayer", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("serves L1 cache on second identical call within TTL", async () => {
    const bars = [makeBar({ timestamp: "2026-04-17T16:00:00-04:00" })];
    const av = makeAvStub(bars);
    const layer = new DataLayer(av, null, null);
    await layer.getDaily("SPY", { lookback: 1 });
    await layer.getDaily("SPY", { lookback: 1 });
    // Second call should hit L1; fetchDaily invoked once total
    expect((av.fetchDaily as any).mock.calls.length).toBe(1);
  });

  it("falls back to L2 DB when L1 cleared but DB is fresh", async () => {
    const fresh = new Date().toISOString();
    const bars = [makeBar({ timestamp: fresh })];
    const av = makeAvStub(bars);
    const layer = new DataLayer(av, null, null);
    await layer.getDaily("SPY", { lookback: 1 }); // seeds DB + L1
    // Simulate new DataLayer instance (L1 empty) but DB still has the row
    const av2 = makeAvStub([]); // shouldn't be called
    const layer2 = new DataLayer(av2, null, null);
    const result = await layer2.getDaily("SPY", { lookback: 1 });
    expect(result.bars).toHaveLength(1);
    // AV should NOT have been called
    expect((av2.fetchDaily as any).mock.calls.length).toBe(0);
  });

  it("primary→fallback on AV RateLimitedError", async () => {
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchDaily = vi
      .fn()
      .mockRejectedValue(new RateLimitedError("alpha_vantage"));
    const polyBars = [makeBar({ provider: "polygon" })];
    const poly = makePolyStub(polyBars);
    const layer = new DataLayer(av as AlphaVantageAdapter, poly, null);
    const result = await layer.getDaily("SPY", { lookback: 1 });
    expect(result.provider).toBe("polygon");
    expect(poly.fetchDaily).toHaveBeenCalled();
  });

  it("primary→fallback on AV 5xx-like error", async () => {
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchDaily = vi
      .fn()
      .mockRejectedValue(new Error("AV 503: service unavailable"));
    const polyBars = [makeBar({ provider: "polygon" })];
    const poly = makePolyStub(polyBars);
    const layer = new DataLayer(av as AlphaVantageAdapter, poly, null);
    const result = await layer.getDaily("SPY", { lookback: 1 });
    expect(result.provider).toBe("polygon");
  });

  it("both-unavailable with stale DB rows returns stale:true", async () => {
    // Seed DB directly with an old row (outside TTL)
    const oldTs = "2020-01-01T16:00:00-05:00";
    db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("SPY", "alpha_vantage", "daily", oldTs, 100, 110, 95, 105, 1000);

    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchDaily = vi.fn().mockRejectedValue(new Error("AV down"));
    const poly = Object.create(PolygonAdapter.prototype);
    poly.provider = "polygon";
    poly.fetchDaily = vi.fn().mockRejectedValue(new Error("Polygon down"));
    const layer = new DataLayer(
      av as AlphaVantageAdapter,
      poly as PolygonAdapter,
      null,
    );
    const result = await layer.getDaily("SPY", { lookback: 1 });
    expect(result.bars).toHaveLength(1);
    expect(result.stale).toBe(true);
  });

  it("both-unavailable with no DB rows throws DataUnavailableError", async () => {
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchDaily = vi.fn().mockRejectedValue(new Error("AV down"));
    const poly = Object.create(PolygonAdapter.prototype);
    poly.provider = "polygon";
    poly.fetchDaily = vi.fn().mockRejectedValue(new Error("Polygon down"));
    const layer = new DataLayer(
      av as AlphaVantageAdapter,
      poly as PolygonAdapter,
      null,
    );
    await expect(layer.getDaily("XYZ", { lookback: 1 })).rejects.toBeInstanceOf(
      DataUnavailableError,
    );
  });

  it("in-flight dedup — two concurrent identical calls share one fetch", async () => {
    let resolveFn: (bars: MarketBar[]) => void = () => {};
    const pending = new Promise<MarketBar[]>((r) => (resolveFn = r));
    const av = makeAvStub(() => pending);
    const layer = new DataLayer(av, null, null);

    const p1 = layer.getDaily("SPY", { lookback: 1 });
    const p2 = layer.getDaily("SPY", { lookback: 1 });
    resolveFn([makeBar({ timestamp: new Date().toISOString() })]);
    await Promise.all([p1, p2]);
    // Only one fetch
    expect((av.fetchDaily as any).mock.calls.length).toBe(1);
  });

  it("getWeekly routes to AV fetchWeekly and persists bars with interval='weekly'", async () => {
    const weeklyBars = [
      makeBar({
        timestamp: "2026-04-10T16:00:00-04:00",
        interval: "weekly",
        close: 518.2,
      }),
      makeBar({
        timestamp: "2026-04-17T16:00:00-04:00",
        interval: "weekly",
        close: 523.45,
      }),
    ];
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchWeekly = vi.fn().mockResolvedValue(weeklyBars);
    const layer = new DataLayer(av as AlphaVantageAdapter, null, null);
    const res = await layer.getWeekly("SPY", { lookback: 2 });
    expect(res.bars).toHaveLength(2);
    expect(res.bars[0]!.interval).toBe("weekly");
    expect(res.bars[1]!.close).toBe(523.45);

    // Verify L2 persistence at interval='weekly'
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM market_data WHERE symbol='SPY' AND interval='weekly'",
      )
      .get() as { n: number };
    expect(rows.n).toBe(2);
    // Daily rows must not have been written
    const dailyRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM market_data WHERE symbol='SPY' AND interval='daily'",
      )
      .get() as { n: number };
    expect(dailyRows.n).toBe(0);
  });

  it("getWeekly throws DataUnavailable when AV has no fetchWeekly impl", async () => {
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    // Deliberately absent: av.fetchWeekly
    const layer = new DataLayer(av as AlphaVantageAdapter, null, null);
    await expect(
      layer.getWeekly("SPY", { lookback: 2 }),
    ).rejects.toBeInstanceOf(DataUnavailableError);
  });

  it("addToWatchlist normalizes symbol and persists asset_class", () => {
    const layer = new DataLayer(null, null, null);
    const row = layer.addToWatchlist({
      symbol: "  tsla ",
      assetClass: "equity",
      tags: ["growth", "ev"],
    });
    expect(row.symbol).toBe("TSLA");
    expect(row.assetClass).toBe("equity");
    expect(row.tags).toEqual(["growth", "ev"]);
    expect(row.active).toBe(true);
  });

  it("addToWatchlist rejects on projected budget overflow", () => {
    // Seed 864 active symbols (each costs ~100 calls/day → 86,400 at ceiling)
    // +1 more pushes over 80% of 108,000
    const layer = new DataLayer(null, null, null);
    for (let i = 0; i < 864; i++) {
      layer.addToWatchlist({ symbol: `SYM${i}A`, assetClass: "equity" });
    }
    // Next add should refuse (864 * 100 = 86400 = ceiling; +1 more = over)
    expect(() =>
      layer.addToWatchlist({ symbol: "OVER", assetClass: "equity" }),
    ).toThrow(/ceiling/);
  });

  it("getMacro routes VIXCLS to FRED, FEDFUNDS to AV", async () => {
    const fred = Object.create(FredAdapter.prototype);
    fred.provider = "fred";
    fred.fetchMacro = vi
      .fn()
      .mockResolvedValue([
        { series: "VIXCLS", date: "2026-04-17", value: 17.0, provider: "fred" },
      ]);
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchMacro = vi.fn().mockResolvedValue([
      {
        series: "FEDFUNDS",
        date: "2026-04-01",
        value: 5.25,
        provider: "alpha_vantage",
      },
    ]);
    const layer = new DataLayer(
      av as AlphaVantageAdapter,
      null,
      fred as FredAdapter,
    );
    const vix = await layer.getMacro("VIXCLS");
    expect(vix[0].value).toBe(17.0);
    expect(fred.fetchMacro).toHaveBeenCalled();
    expect(av.fetchMacro).not.toHaveBeenCalled();
    const ff = await layer.getMacro("FEDFUNDS");
    expect(ff[0].value).toBe(5.25);
    expect(av.fetchMacro).toHaveBeenCalled();
  });
});
