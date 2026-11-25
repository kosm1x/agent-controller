/**
 * DataLayer tests — cache, dispatch, fallback, dedup, watchlist CRUD.
 *
 * Uses an in-memory SQLite seeded with the F1 subset of schema.sql so the
 * persist/query paths run against real SQL, not a mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { __resetForTests, canCall, recordCall } from "./rate-limit.js";
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

  it("stats() counters track L1/L2/fetch breakdown for hit-ratio observability", async () => {
    // E4 audit instrumentation: cache efficiency must be measurable.
    // First call: fetch (miss). Second call: L1 hit. Third: simulated L1 expiry -> L2 hit.
    const fresh = new Date().toISOString();
    const bars = [makeBar({ timestamp: fresh })];
    const av = makeAvStub(bars);
    const layer = new DataLayer(av, null, null);

    await layer.getDaily("SPY", { lookback: 1 }); // fetch
    await layer.getDaily("SPY", { lookback: 1 }); // L1 hit
    // New instance picks up the fresh DB row (L2 hit without going to AV).
    const av2 = makeAvStub([]);
    const layer2 = new DataLayer(av2, null, null);
    await layer2.getDaily("SPY", { lookback: 1 }); // L2 hit

    expect(layer.stats()).toEqual(
      expect.objectContaining({
        l1Hits: 1,
        l2Hits: 0,
        fetches: 1,
      }),
    );
    expect(layer2.stats()).toEqual(
      expect.objectContaining({
        l1Hits: 0,
        l2Hits: 1,
        fetches: 0,
      }),
    );
    // Combined ratio 2 hits / 3 accesses = 0.666...
    const combinedHits = layer.stats().l1Hits + layer2.stats().l2Hits;
    const combinedTotal =
      layer.stats().l1Hits +
      layer.stats().l2Hits +
      layer.stats().fetches +
      layer2.stats().l1Hits +
      layer2.stats().l2Hits +
      layer2.stats().fetches;
    expect(combinedHits / combinedTotal).toBeCloseTo(2 / 3, 3);
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

  it("Polygon is primary — AV is not called when Polygon serves", async () => {
    const avBars = [makeBar({ provider: "alpha_vantage" })];
    const av = makeAvStub(avBars);
    const polyBars = [makeBar({ provider: "polygon" })];
    const poly = makePolyStub(polyBars);
    const layer = new DataLayer(av, poly, null);
    const result = await layer.getDaily("SPY", { lookback: 1 });
    expect(result.provider).toBe("polygon");
    expect((av.fetchDaily as any).mock.calls.length).toBe(0);
  });

  it("primary→fallback on Polygon RateLimitedError", async () => {
    const poly = Object.create(PolygonAdapter.prototype);
    poly.provider = "polygon";
    poly.fetchDaily = vi
      .fn()
      .mockRejectedValue(new RateLimitedError("polygon"));
    const avBars = [makeBar({ provider: "alpha_vantage" })];
    const av = makeAvStub(avBars);
    const layer = new DataLayer(av, poly as PolygonAdapter, null);
    const result = await layer.getDaily("SPY", { lookback: 1 });
    expect(result.provider).toBe("alpha_vantage");
    expect(av.fetchDaily).toHaveBeenCalled();
  });

  it("primary→fallback on Polygon 5xx-like error", async () => {
    const poly = Object.create(PolygonAdapter.prototype);
    poly.provider = "polygon";
    poly.fetchDaily = vi
      .fn()
      .mockRejectedValue(new Error("Polygon 503: service unavailable"));
    const avBars = [makeBar({ provider: "alpha_vantage" })];
    const av = makeAvStub(avBars);
    const layer = new DataLayer(av, poly as PolygonAdapter, null);
    const result = await layer.getDaily("SPY", { lookback: 1 });
    expect(result.provider).toBe("alpha_vantage");
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

  describe("the fallback flag on a repeat call", () => {
    const seedOldRow = () =>
      db
        .prepare(
          `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "SPY",
          "alpha_vantage",
          "daily",
          "2020-01-01T16:00:00-05:00",
          100,
          110,
          95,
          105,
          1000,
        );
    const downAv = () => makeAvStub(() => Promise.reject(new Error("AV down")));

    it("a cache hit after a fallback to stored rows still carries the flag", async () => {
      seedOldRow();
      const av = downAv();
      const layer = new DataLayer(av, null, null);
      const first = await layer.getDaily("SPY", { lookback: 1 });
      const second = await layer.getDaily("SPY", { lookback: 1 });
      expect(first.stale).toBe(true);
      expect(second.stale).toBe(true);
      expect(second.bars).toEqual(first.bars);
      // The second answer is the cache, not a new attempt.
      expect((av.fetchDaily as any).mock.calls.length).toBe(1);
      expect(layer.stats().l1Hits).toBe(1);
    });

    it("a caller that joins a fetch in progress gets that fetch's flag", async () => {
      seedOldRow();
      let rejectFn: (e: Error) => void = () => {};
      const pending = new Promise<MarketBar[]>((_, rej) => (rejectFn = rej));
      const av = makeAvStub(() => pending);
      const layer = new DataLayer(av, null, null);
      const p1 = layer.getDaily("SPY", { lookback: 1 });
      const p2 = layer.getDaily("SPY", { lookback: 1 });
      rejectFn(new Error("AV down"));
      const [r1, r2] = await Promise.all([p1, p2]);
      expect((av.fetchDaily as any).mock.calls.length).toBe(1);
      expect(layer.stats().inflightDedups).toBe(1);
      expect(r1.stale).toBe(true);
      expect(r2.stale).toBe(true);
    });

    it("a cache hit after a fresh fetch carries no flag", async () => {
      const av = makeAvStub([
        makeBar({ timestamp: "2026-04-17T16:00:00-04:00" }),
      ]);
      const layer = new DataLayer(av, null, null);
      const first = await layer.getDaily("SPY", { lookback: 1 });
      const second = await layer.getDaily("SPY", { lookback: 1 });
      expect((av.fetchDaily as any).mock.calls.length).toBe(1);
      expect(first.stale).toBeUndefined();
      expect(second.stale).toBeUndefined();
    });
  });

  it("L2 returns one bar per session when both providers stored it (polygon T00:00 vs AV T16:00)", async () => {
    const ins = db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    // 2020-01-02 only AV · 01-03 and 01-06 both · 01-07 only polygon
    for (const [provider, day, close] of [
      ["alpha_vantage", "2020-01-02T16:00:00-05:00", 101],
      ["alpha_vantage", "2020-01-03T16:00:00-05:00", 102],
      ["polygon", "2020-01-03T00:00:00-05:00", 102],
      ["alpha_vantage", "2020-01-06T16:00:00-05:00", 103],
      ["polygon", "2020-01-06T00:00:00-05:00", 103],
      ["polygon", "2020-01-07T00:00:00-05:00", 104],
    ] as [string, string, number][]) {
      ins.run("SPY", provider, "daily", day, close, close, close, close, 1000);
    }
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchDaily = vi.fn().mockRejectedValue(new Error("AV down"));
    const layer = new DataLayer(av as AlphaVantageAdapter, null, null);
    const result = await layer.getDaily("SPY", { lookback: 4 });
    expect(result.bars.map((b) => b.timestamp.slice(0, 10))).toEqual([
      "2020-01-02",
      "2020-01-03",
      "2020-01-06",
      "2020-01-07",
    ]);
    expect(result.bars.map((b) => b.provider)).toEqual([
      "alpha_vantage",
      "polygon",
      "polygon",
      "polygon",
    ]);
  });

  it("L2 'enough history' gate counts sessions — two fresh rows of ONE session do not satisfy lookback 2", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ins = db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    ins.run("SPY", "polygon", "daily", `${day}T00:00:00.000Z`, 1, 1, 1, 1, 1);
    ins.run(
      "SPY",
      "alpha_vantage",
      "daily",
      `${day}T00:00:01.000Z`,
      1,
      1,
      1,
      1,
      1,
    );
    const av = makeAvStub([
      makeBar(),
      makeBar({ timestamp: `${day}T00:00:02.000Z` }),
    ]);
    const layer = new DataLayer(av, null, null);
    await layer.getDaily("SPY", { lookback: 2 });
    // Row-counting L2 would have hit (2 rows, fresh) and never fetched.
    expect((av.fetchDaily as any).mock.calls.length).toBe(1);
    expect(layer.stats().l2Hits).toBe(0);
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
    // Seed 46 active symbols (each costs ~100 calls/day → 4,600 at the
    // Polygon free-tier practical ceiling of 4,608). +1 more pushes over.
    const layer = new DataLayer(null, null, null);
    for (let i = 0; i < 46; i++) {
      layer.addToWatchlist({ symbol: `SYM${i}A`, assetClass: "equity" });
    }
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

// Weekly dispatch since 2026-09-18: Polygon refreshes, AV only seeds depth.
describe("DataLayer.getWeekly — Polygon weekly", () => {
  // Wed 2026-04-22 → the last completed week closed Fri 04-17.
  const NOW = new Date("2026-04-22T15:00:00Z");
  const friday = (day: string, provider: MarketBar["provider"], close = 500) =>
    makeBar({
      timestamp: `${day}T16:00:00-04:00`,
      interval: "weekly",
      provider,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
    });
  const insertWeekly = (b: MarketBar) =>
    db
      .prepare(
        `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
         VALUES (?, ?, 'weekly', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.symbol,
        b.provider,
        b.timestamp,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
      );
  const stubs = (polyBars: MarketBar[], avBars: MarketBar[] | Error) => {
    const av = Object.create(AlphaVantageAdapter.prototype);
    av.provider = "alpha_vantage";
    av.fetchWeekly =
      avBars instanceof Error
        ? vi.fn().mockRejectedValue(avBars)
        : vi.fn().mockResolvedValue(avBars);
    const poly = Object.create(PolygonAdapter.prototype);
    poly.provider = "polygon";
    poly.fetchWeekly = vi.fn().mockResolvedValue(polyBars);
    return { av, poly };
  };

  beforeEach(() => {
    __resetForTests();
    db = freshDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("a request that fits 2y goes to Polygon, never AV, and comes back one row per week", async () => {
    insertWeekly(friday("2026-04-02", "alpha_vantage", 655.83)); // Good Friday week, AV dates it Thu
    insertWeekly(friday("2026-04-08", "alpha_vantage", 670)); // mid-week partial
    insertWeekly(friday("2026-04-10", "alpha_vantage", 679.46));
    const { av, poly } = stubs(
      [
        friday("2026-04-03", "polygon", 655.83),
        friday("2026-04-10", "polygon", 679.46),
        friday("2026-04-17", "polygon", 710.14),
      ],
      [],
    );
    const layer = new DataLayer(av, poly, null);
    const res = await layer.getWeekly("SPY", { lookback: 10 });
    expect(av.fetchWeekly).not.toHaveBeenCalled();
    expect(res.bars.map((b) => [b.timestamp.slice(0, 10), b.provider])).toEqual(
      [
        ["2026-04-03", "polygon"],
        ["2026-04-10", "polygon"],
        ["2026-04-17", "polygon"],
      ],
    );
  });

  it("a deeper lookback keeps the AV-seeded history behind the Polygon tail", async () => {
    // 110 seeded AV weeks ending 04-10: deep history present, tail stale.
    const last = Date.parse("2026-04-10T12:00:00Z");
    for (let i = 0; i < 110; i++) {
      const day = new Date(last - i * 7 * 86400000).toISOString().slice(0, 10);
      insertWeekly(friday(day, "alpha_vantage", 400 + i));
    }
    const { av, poly } = stubs([friday("2026-04-17", "polygon", 710.14)], []);
    const layer = new DataLayer(av, poly, null);
    const res = await layer.getWeekly("SPY", { lookback: 520 });
    expect(av.fetchWeekly).not.toHaveBeenCalled();
    expect(res.bars).toHaveLength(111);
    expect(res.bars.at(-1)!.timestamp.slice(0, 10)).toBe("2026-04-17");
    expect(res.bars[0]!.provider).toBe("alpha_vantage");
  });

  it("AV raw history is rescaled onto Polygon's split-adjusted basis — prices, not just close", async () => {
    // AV stored RAW closes (a later 2:1 split): 04-03 = 100, 04-10 = 104.
    for (const [day, close] of [
      ["2026-04-03", 100],
      ["2026-04-10", 104],
    ] as const) {
      insertWeekly(friday(day, "alpha_vantage", close));
      db.prepare(
        `UPDATE market_data SET adjusted_close = ? WHERE provider='alpha_vantage' AND timestamp LIKE ?`,
      ).run(close / 2, `${day}%`);
    }
    const { av, poly } = stubs(
      [
        friday("2026-04-10", "polygon", 52),
        friday("2026-04-17", "polygon", 53),
      ],
      [],
    );
    const res = await new DataLayer(av, poly, null).getWeekly("SPY", {
      lookback: 3,
    });
    expect(res.bars.map((b) => b.close)).toEqual([50, 52, 53]);
    expect(res.bars[0]).toMatchObject({
      provider: "alpha_vantage",
      open: 49.5,
      high: 51,
      low: 49,
    });
  });

  it("an EMPTY Polygon answer is a failed attempt: AV is tried, and stale rows stay flagged stale", async () => {
    insertWeekly(friday("2026-04-03", "alpha_vantage", 500));
    // Polygon answers 200 with no results for a ticker it does not carry.
    const first = stubs([], [friday("2026-04-17", "alpha_vantage", 510)]);
    const res = await new DataLayer(first.av, first.poly, null).getWeekly(
      "SPY",
      { lookback: 10 },
    );
    expect(first.av.fetchWeekly).toHaveBeenCalledTimes(1);
    expect(res.bars.at(-1)!.timestamp.slice(0, 10)).toBe("2026-04-17");
    expect(res.stale).toBeUndefined();

    // Both providers empty → the stored series, flagged stale.
    const both = stubs([], []);
    const stale = await new DataLayer(both.av, both.poly, null)
      .getWeekly("QQQ", { lookback: 10 })
      .catch((e) => e);
    expect(stale).toBeInstanceOf(DataUnavailableError);
    insertWeekly({
      ...friday("2026-04-03", "alpha_vantage", 400),
      symbol: "QQQ",
    });
    const kept = await new DataLayer(both.av, both.poly, null).getWeekly(
      "QQQ",
      { lookback: 10 },
    );
    expect(kept.stale).toBe(true);
    expect(kept.bars).toHaveLength(1);
  });

  it("a cached weekly fallback answer keeps the flag on the next call", async () => {
    insertWeekly(friday("2026-04-03", "alpha_vantage", 400));
    const both = stubs([], []);
    const layer = new DataLayer(both.av, both.poly, null);
    const first = await layer.getWeekly("SPY", { lookback: 10 });
    const second = await layer.getWeekly("SPY", { lookback: 10 });
    expect(first.stale).toBe(true);
    expect(second.stale).toBe(true);
    expect(both.poly.fetchWeekly).toHaveBeenCalledTimes(1);
  });

  it("a weekly caller that joins a fetch in progress gets that fetch's flag", async () => {
    insertWeekly(friday("2026-04-03", "alpha_vantage", 400));
    const down = stubs([], new Error("AV down"));
    let rejectFn: (e: Error) => void = () => {};
    const pending = new Promise<MarketBar[]>((_, rej) => (rejectFn = rej));
    down.poly.fetchWeekly = vi.fn().mockImplementation(() => pending);
    const layer = new DataLayer(down.av, down.poly, null);
    const p1 = layer.getWeekly("SPY", { lookback: 10 });
    const p2 = layer.getWeekly("SPY", { lookback: 10 });
    rejectFn(new Error("Polygon down"));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(down.poly.fetchWeekly).toHaveBeenCalledTimes(1);
    expect(down.av.fetchWeekly).toHaveBeenCalledTimes(1);
    expect(r1.stale).toBe(true);
    expect(r2.stale).toBe(true);
    expect(r2.bars).toHaveLength(1);
  });

  it("the AV leg answers from the stitched DB read too — never the adapter's raw closes", async () => {
    const raw = {
      ...friday("2026-04-17", "alpha_vantage", 100),
      adjustedClose: 50,
    };
    const { av } = stubs([], [raw]);
    const res = await new DataLayer(av, null, null).getWeekly("SPY", {
      lookback: 5,
    });
    expect(res.bars.map((b) => b.close)).toEqual([50]);
  });

  it("a Polygon refetch REPLACES stored weeks (post-split re-basing) and always asks for the full window", async () => {
    insertWeekly(friday("2026-04-10", "polygon", 100));
    const { av, poly } = stubs(
      [
        friday("2026-04-10", "polygon", 50),
        friday("2026-04-17", "polygon", 51),
      ],
      [],
    );
    const res = await new DataLayer(av, poly, null).getWeekly("SPY", {
      lookback: 1,
    });
    expect(poly.fetchWeekly).toHaveBeenCalledWith("SPY", { lookback: 104 });
    expect(res.bars.map((b) => b.close)).toEqual([51]);
    const stored = db
      .prepare(
        `SELECT close FROM market_data WHERE provider='polygon' ORDER BY timestamp`,
      )
      .all() as Array<{ close: number }>;
    expect(stored.map((r) => r.close)).toEqual([50, 51]);
  });

  it("the week in progress is not a weekly bar: lookback 1 is fresh on the completed week, no refetch", async () => {
    insertWeekly(friday("2026-04-17", "polygon", 510));
    insertWeekly({ ...friday("2026-04-21", "alpha_vantage", 515) }); // Tuesday partial
    const { av, poly } = stubs([], []);
    const res = await new DataLayer(av, poly, null).getWeekly("SPY", {
      lookback: 1,
    });
    expect(poly.fetchWeekly).not.toHaveBeenCalled();
    expect(av.fetchWeekly).not.toHaveBeenCalled();
    expect(res.bars.map((b) => b.timestamp.slice(0, 10))).toEqual([
      "2026-04-17",
    ]);
  });

  it("a first deep seed goes to AV (one call, full history); Polygon is the fallback", async () => {
    const seeded = stubs([], [friday("2026-04-17", "alpha_vantage")]);
    await new DataLayer(seeded.av, seeded.poly, null).getWeekly("SPY", {
      lookback: 520,
    });
    expect(seeded.av.fetchWeekly).toHaveBeenCalledTimes(1);
    expect(seeded.poly.fetchWeekly).not.toHaveBeenCalled();

    db = freshDb();
    const down = stubs(
      [friday("2026-04-17", "polygon", 710.14)],
      new Error("AV 500"),
    );
    const res = await new DataLayer(down.av, down.poly, null).getWeekly("QQQ", {
      lookback: 520,
    });
    expect(down.poly.fetchWeekly).toHaveBeenCalledTimes(1);
    expect(res.bars.at(-1)!.close).toBe(710.14);
  });

  it("fresh means the last completed week is stored — not that the newest row is young", async () => {
    // Newest row is 1 day old (a partial of the week in progress); 04-17 is missing.
    insertWeekly(friday("2026-04-10", "alpha_vantage"));
    insertWeekly(friday("2026-04-21", "alpha_vantage"));
    const { av, poly } = stubs([friday("2026-04-17", "polygon", 710.14)], []);
    const layer = new DataLayer(av, poly, null);
    await layer.getWeekly("SPY", { lookback: 2 });
    expect(poly.fetchWeekly).toHaveBeenCalledTimes(1);

    // A second layer (cold L1) now finds 04-17 in the DB and does not fetch.
    const again = stubs([], []);
    await new DataLayer(again.av, again.poly, null).getWeekly("SPY", {
      lookback: 2,
    });
    expect(again.poly.fetchWeekly).not.toHaveBeenCalled();
    expect(again.av.fetchWeekly).not.toHaveBeenCalled();
  });

  it("a cached series still missing the completed week is retried, but not more than every 6h", async () => {
    insertWeekly(friday("2026-04-10", "alpha_vantage"));
    // Provider has not published 04-17 yet.
    const { av, poly } = stubs([friday("2026-04-10", "polygon")], []);
    const layer = new DataLayer(av, poly, null);
    await layer.getWeekly("SPY", { lookback: 2 });
    await layer.getWeekly("SPY", { lookback: 2 });
    expect(poly.fetchWeekly).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 60 * 60 * 1000));
    await layer.getWeekly("SPY", { lookback: 2 });
    expect(poly.fetchWeekly).toHaveBeenCalledTimes(2);
  });
});

// Every provider a stored bar may carry, each exactly once: a value added to or
// removed from the stored-bar type without this list fails the test typecheck.
const STORED_BAR_PROVIDERS = {
  alpha_vantage: true,
  polygon: true,
  fmp: true,
  fred: true,
  manual: true,
} satisfies Record<MarketBar["provider"], true>;

describe("market_data.provider — the stored-bar type and the schema rule agree", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("a bar of every stored-bar provider is persisted and read back with its provider", async () => {
    const providers = Object.keys(STORED_BAR_PROVIDERS) as Array<
      MarketBar["provider"]
    >;
    const bars = providers.map((provider, i) =>
      makeBar({
        provider,
        timestamp: `2020-01-0${i + 2}T16:00:00-05:00`,
        close: 520 + i,
      }),
    );
    await new DataLayer(makeAvStub(bars), null, null).getDaily("SPY", {
      lookback: providers.length,
    });
    // persistBars inserts with OR IGNORE, which swallows a CHECK refusal: the
    // rows themselves are the evidence.
    expect(
      db
        .prepare(
          "SELECT provider, timestamp, close FROM market_data ORDER BY timestamp",
        )
        .all(),
    ).toEqual(
      bars.map((b) => ({
        provider: b.provider,
        timestamp: b.timestamp,
        close: b.close,
      })),
    );
  });

  it("the schema rule lists exactly the stored-bar providers and refuses any other", () => {
    const tableSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'market_data'",
        )
        .get() as { sql: string }
    ).sql;
    const rule = tableSql.match(/CHECK\(provider IN \(([^)]*)\)\)/);
    expect(rule).not.toBeNull();
    expect(
      rule![1]
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""))
        .sort(),
    ).toEqual(Object.keys(STORED_BAR_PROVIDERS).sort());

    // The budget-only providers of the wide type, and an empty name.
    const insert = db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const provider of [
      "polymarket",
      "alternative_me",
      "coinmarketcap",
      "binance",
      "",
    ]) {
      expect(() =>
        insert.run("SPY", provider, "daily", "2020-01-02T16:00:00-05:00", 1, 1, 1, 1, 1),
      ).toThrow(/CHECK constraint failed/);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM market_data").get()).toEqual({
      n: 0,
    });
  });
});

// A daily request when our limiter refuses Polygon: AV first, then a bounded
// wait for a Polygon slot, then the stored rows. Also how long an answer is
// reused from memory. Fake clock and timers; the stubs ask our limiter and
// record the call before answering, as the adapters do.
describe("DataLayer.getDaily — the Polygon slot wait and memory reuse", () => {
  // Wed 2026-04-22 11:00 New York → the previous trading day is Tue 04-21.
  const NOW = Date.parse("2026-04-22T15:00:00Z");
  const MINUTE = 60_000;
  const SYMBOLS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];
  type DailyProvider = "polygon" | "alpha_vantage";
  let calls: { provider: DailyProvider; at: number }[] = [];

  /** Puts `n` calls into our limiter at time `at`, as another caller would. */
  const seedCalls = (provider: DailyProvider, at: number, n = 1) => {
    const back = Date.now();
    vi.setSystemTime(at);
    for (let i = 0; i < n; i++) {
      recordCall(provider);
      calls.push({ provider, at });
    }
    vi.setSystemTime(back);
  };
  const freshBar = (symbol: string, provider: DailyProvider) =>
    makeBar({ symbol, provider, timestamp: new Date(Date.now()).toISOString() });
  const stub = (
    provider: DailyProvider,
    answer: (symbol: string) => MarketBar[] | Error = (symbol) => [
      freshBar(symbol, provider),
    ],
  ) => {
    const a = Object.create(
      provider === "polygon"
        ? PolygonAdapter.prototype
        : AlphaVantageAdapter.prototype,
    );
    a.provider = provider;
    a.fetchDaily = vi.fn((symbol: string) => {
      if (!canCall(provider)) {
        return Promise.reject(new RateLimitedError(provider));
      }
      recordCall(provider);
      calls.push({ provider, at: Date.now() });
      const out = answer(symbol);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    });
    return a;
  };
  /** Most calls to `provider` inside any closed 60-second span. */
  const maxPerMinute = (provider: DailyProvider) => {
    const ts = calls.filter((c) => c.provider === provider).map((c) => c.at);
    return Math.max(
      0,
      ...ts.map((t) => ts.filter((u) => u >= t - MINUTE && u <= t).length),
    );
  };
  const seedOldRow = (symbol: string) =>
    db
      .prepare(
        `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(symbol, "alpha_vantage", "daily", "2020-01-01T16:00:00-05:00", 100, 110, 95, 105, 1000);
  /** Settles in the background, so a case can look at it while timers are held. */
  function track<T>(p: Promise<T>) {
    const s: { done: boolean; value?: T; error?: unknown; at?: number } = {
      done: false,
    };
    p.then(
      (value) => Object.assign(s, { done: true, value, at: Date.now() }),
      (error) => Object.assign(s, { done: true, error, at: Date.now() }),
    );
    return s;
  }
  const walk = async (layer: DataLayer) => {
    const out: Awaited<ReturnType<DataLayer["getDaily"]>>[] = [];
    for (const s of SYMBOLS) out.push(await layer.getDaily(s, { lookback: 1 }));
    return out;
  };

  beforeEach(() => {
    __resetForTests();
    db = freshDb();
    calls = [];
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("a walk of ten with both providers free ends in ten fresh answers, no minute above either ceiling", async () => {
    const layer = new DataLayer(stub("alpha_vantage"), stub("polygon"), null);
    const run = track(walk(layer));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(run.error).toBeUndefined();
    expect(
      run.value!.map((r) => [r.bars[0]?.symbol, r.bars.length, r.stale]),
    ).toEqual(SYMBOLS.map((s) => [s, 1, undefined]));
    expect(maxPerMinute("polygon")).toBeLessThanOrEqual(4);
    expect(maxPerMinute("alpha_vantage")).toBeLessThanOrEqual(4);
    expect(run.at! - NOW).toBe(MINUTE + 1);
  });

  it("with AV's daily ceiling full, Polygon alone serves the walk of ten, AV is never called, two waits", async () => {
    for (let i = 0; i < 22; i++) {
      seedCalls("alpha_vantage", NOW - (22 - i) * 5 * MINUTE);
    }
    const av = stub("alpha_vantage");
    const layer = new DataLayer(av, stub("polygon"), null);
    const run = track(walk(layer));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(run.error).toBeUndefined();
    expect(
      run.value!.map((r) => [r.bars[0]?.symbol, r.provider, r.stale]),
    ).toEqual(SYMBOLS.map((s) => [s, "polygon", undefined]));
    expect(av.fetchDaily).not.toHaveBeenCalled();
    expect(maxPerMinute("polygon")).toBeLessThanOrEqual(4);
    expect(maxPerMinute("alpha_vantage")).toBeLessThanOrEqual(4);
    // Two waits for a window to free; a call leaves the window 60 001 ms after it.
    expect(run.at! - NOW).toBe(2 * MINUTE + 2);
  });

  it("two callers waiting for one freed slot: the second waits again, both get Polygon answers, no fifth call in a minute", async () => {
    seedCalls("polygon", NOW - 30_000);
    seedCalls("polygon", NOW, 3);
    const poly = stub("polygon");
    const layer = new DataLayer(null, poly, null);
    const a = track(layer.getDaily("AAA", { lookback: 1 }));
    const b = track(layer.getDaily("BBB", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect([a.error, b.error]).toEqual([undefined, undefined]);
    expect([a.value?.provider, a.value?.stale, b.value?.provider, b.value?.stale]).toEqual(
      ["polygon", undefined, "polygon", undefined],
    );
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
    expect(maxPerMinute("polygon")).toBeLessThanOrEqual(4);
  });

  it("a Polygon window that never frees ends within 65 seconds in the stored rows, flagged, Polygon not called", async () => {
    seedOldRow("AAA");
    seedCalls("polygon", NOW, 4);
    // Another caller takes every slot the moment it frees (created first, so
    // at an equal time it runs before the wait's timer).
    const filler = setInterval(() => {
      while (canCall("polygon")) recordCall("polygon");
    }, MINUTE + 1);
    const poly = stub("polygon");
    const run = track(new DataLayer(null, poly, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(65_000);
    clearInterval(filler);
    expect(run.done).toBe(true);
    expect(run.at! - NOW).toBeGreaterThan(60_001);
    expect(run.at! - NOW).toBeLessThanOrEqual(65_000);
    expect(run.value?.stale).toBe(true);
    expect(run.value?.bars.map((b) => b.close)).toEqual([105]);
    expect(poly.fetchDaily).not.toHaveBeenCalled();
  });

  it("AV free while Polygon's window is full: AV answers at once, no wait", async () => {
    seedCalls("polygon", NOW, 4);
    const poly = stub("polygon");
    const run = track(
      new DataLayer(stub("alpha_vantage"), poly, null).getDaily("AAA", { lookback: 1 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.at).toBe(NOW);
    expect([run.value?.provider, run.value?.stale]).toEqual(["alpha_vantage", undefined]);
    expect(poly.fetchDaily).not.toHaveBeenCalled();
  });

  it("a Polygon call that was made and failed is neither waited for nor made twice", async () => {
    seedOldRow("AAA");
    const poly = stub("polygon", () => new Error("Polygon 503: service unavailable"));
    const run = track(new DataLayer(null, poly, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.at).toBe(NOW);
    expect(run.value?.stale).toBe(true);
    expect(poly.fetchDaily).toHaveBeenCalledTimes(1);
  });

  it("AV refuses a call our limiter allowed: the request waits, then Polygon answers", async () => {
    seedCalls("polygon", NOW, 4);
    const av = stub("alpha_vantage", () => new RateLimitedError("alpha_vantage"));
    const poly = stub("polygon");
    const run = track(new DataLayer(av, poly, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.error).toBeUndefined();
    expect([run.value?.provider, run.value?.stale]).toEqual(["polygon", undefined]);
    expect(run.at! - NOW).toBe(MINUTE + 1);
    expect(av.fetchDaily).toHaveBeenCalledTimes(1);
    expect(poly.fetchDaily).toHaveBeenCalledTimes(1);
  });

  it("Polygon fails after the wait: the stored rows come back, flagged", async () => {
    seedOldRow("AAA");
    seedCalls("polygon", NOW, 4);
    const poly = stub("polygon", () => new Error("Polygon 503: service unavailable"));
    const run = track(new DataLayer(null, poly, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.at! - NOW).toBe(MINUTE + 1);
    expect(run.value?.stale).toBe(true);
    expect(run.value?.bars.map((b) => b.close)).toEqual([105]);
    expect(poly.fetchDaily).toHaveBeenCalledTimes(1);
  });

  it("Polygon fails after the wait with nothing stored: the existing error, its attempts naming both providers", async () => {
    seedCalls("polygon", NOW, 4);
    const poly = stub("polygon", () => new Error("Polygon 503: service unavailable"));
    const run = track(new DataLayer(null, poly, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.error).toBeInstanceOf(DataUnavailableError);
    expect((run.error as DataUnavailableError).attempts).toEqual([
      { provider: "polygon", reason: "rate limited" },
      { provider: "alpha_vantage", reason: "not configured" },
      { provider: "polygon", reason: "Polygon 503: service unavailable" },
    ]);
  });

  it("no Polygon configured: no wait, even with our limiter's Polygon window full", async () => {
    seedOldRow("AAA");
    seedCalls("polygon", NOW, 4);
    const run = track(new DataLayer(null, null, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.at).toBe(NOW);
    expect(run.value?.stale).toBe(true);
  });

  it("an answer made of stored rows is reused for 10 minutes, then asked again", async () => {
    seedOldRow("AAA");
    const av = stub("alpha_vantage", () => new Error("AV down"));
    const layer = new DataLayer(av, null, null);
    expect((await layer.getDaily("AAA", { lookback: 1 })).stale).toBe(true);
    vi.setSystemTime(NOW + 10 * MINUTE);
    expect((await layer.getDaily("AAA", { lookback: 1 })).stale).toBe(true);
    expect(av.fetchDaily).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 10 * MINUTE + 1);
    expect((await layer.getDaily("AAA", { lookback: 1 })).stale).toBe(true);
    expect(av.fetchDaily).toHaveBeenCalledTimes(2);
  });

  // Polygon stamps a daily bar 00:00 New York on its session date. Bars of
  // 04-21 and 04-22 are current on 04-22; 04-17 is behind.
  const sessionBar = (symbol: string, day: string) =>
    makeBar({ symbol, provider: "polygon", timestamp: `${day}T00:00:00-04:00` });

  it("a current answer is reused from memory, no call made: six hours later for a bar dated the previous trading day or today, and up to a day for a bar dated today, then fetched again", async () => {
    const poly = stub("polygon", (symbol) => [
      sessionBar(symbol, symbol === "AAA" ? "2026-04-21" : "2026-04-22"),
    ]);
    const layer = new DataLayer(null, poly, null);
    await layer.getDaily("AAA", { lookback: 1 });
    await layer.getDaily("BBB", { lookback: 1 });
    vi.setSystemTime(NOW + 6 * 60 * MINUTE);
    await layer.getDaily("AAA", { lookback: 1 });
    await layer.getDaily("BBB", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
    expect(layer.stats().l1Hits).toBe(2);
    // Thu 04-23 11:00 New York: 04-22 is still the previous trading day.
    vi.setSystemTime(NOW + 24 * 60 * MINUTE);
    await layer.getDaily("BBB", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW + 24 * 60 * MINUTE + 1);
    await layer.getDaily("BBB", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(3);
  });

  it("a behind answer (newest bar before the previous trading day) is reused inside the hour and fetched again after it", async () => {
    const poly = stub("polygon", (symbol) => [sessionBar(symbol, "2026-04-17")]);
    const layer = new DataLayer(null, poly, null);
    await layer.getDaily("AAA", { lookback: 1 });
    vi.setSystemTime(NOW + 60 * MINUTE);
    await layer.getDaily("AAA", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 60 * MINUTE + 1);
    const again = await layer.getDaily("AAA", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
    expect(again.stale).toBeUndefined();
  });

  it("the choice follows the clock: an answer current on 04-22 is behind on 04-23 and is fetched again", async () => {
    const poly = stub("polygon", (symbol) => [sessionBar(symbol, "2026-04-21")]);
    const layer = new DataLayer(null, poly, null);
    await layer.getDaily("AAA", { lookback: 1 });
    // Thu 04-23 10:00 New York, 23 hours later: the previous trading day is 04-22.
    vi.setSystemTime(Date.parse("2026-04-23T14:00:00Z"));
    await layer.getDaily("AAA", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
  });

  it("a newest bar whose date cannot be read counts as behind: no throw, reused inside the hour, fetched again after it", async () => {
    const poly = stub("polygon", (symbol) => [
      makeBar({ symbol, provider: "polygon", timestamp: "unreadable" }),
    ]);
    const layer = new DataLayer(null, poly, null);
    await layer.getDaily("AAA", { lookback: 1 });
    vi.setSystemTime(NOW + 60 * MINUTE);
    await expect(layer.getDaily("AAA", { lookback: 1 })).resolves.toBeDefined();
    expect(poly.fetchDaily).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 60 * MINUTE + 1);
    await layer.getDaily("AAA", { lookback: 1 });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
  });

  it("an empty Polygon answer in leg one is a failed attempt: stored rows come back flagged; with none, the reason is 'no bars'", async () => {
    seedOldRow("AAA");
    const poly = stub("polygon", () => []);
    const layer = new DataLayer(null, poly, null);
    const r = await layer.getDaily("AAA", { lookback: 1 });
    expect([r.stale, r.bars.map((b) => b.close)]).toEqual([true, [105]]);
    await expect(layer.getDaily("BBB", { lookback: 1 })).rejects.toMatchObject({
      attempts: [
        { provider: "polygon", reason: "no bars" },
        { provider: "alpha_vantage", reason: "not configured" },
      ],
    });
    expect(poly.fetchDaily).toHaveBeenCalledTimes(2);
  });

  it("an empty AV answer in leg two is a failed attempt: stored rows come back flagged", async () => {
    seedOldRow("AAA");
    const av = stub("alpha_vantage", () => []);
    const r = await new DataLayer(av, null, null).getDaily("AAA", { lookback: 1 });
    expect([r.stale, r.bars.map((b) => b.close)]).toEqual([true, [105]]);
    expect(av.fetchDaily).toHaveBeenCalledTimes(1);
  });

  it("an empty Polygon answer after the wait is a failed attempt: stored rows come back flagged", async () => {
    seedOldRow("AAA");
    seedCalls("polygon", NOW, 4);
    const poly = stub("polygon", () => []);
    const run = track(new DataLayer(null, poly, null).getDaily("AAA", { lookback: 1 }));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.at! - NOW).toBe(MINUTE + 1);
    expect([run.value?.stale, run.value?.bars.map((b) => b.close)]).toEqual([true, [105]]);
    expect(poly.fetchDaily).toHaveBeenCalledTimes(1);
  });
});
