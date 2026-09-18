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
