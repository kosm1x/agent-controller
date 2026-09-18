/**
 * watchlist-seed tests — idempotent skip, fetch + persist happy path,
 * error surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const mockGetWeekly = vi.fn();
vi.mock("./data-layer.js", () => ({
  getDataLayer: () => ({ getWeekly: mockGetWeekly }),
}));

import {
  seedSymbol,
  formatSeedResult,
  refreshWeeklyWatchlist,
} from "./watchlist-seed.js";
import { __resetForTests, recordCall } from "./rate-limit.js";
import type { MarketBar } from "./types.js";

function makeWeekly(symbol: string, n: number, startPrice = 100): MarketBar[] {
  const bars: MarketBar[] = [];
  // Generate n weekly bars, oldest first, Friday-keyed
  const start = new Date("2020-01-03T16:00:00-05:00").getTime();
  for (let i = 0; i < n; i++) {
    const ts = new Date(start + i * 7 * 86400000).toISOString();
    // Drift + small oscillation so variance > 0 and signals may fire
    const close = startPrice + i * 0.5 + Math.sin(i / 4) * 3;
    bars.push({
      symbol,
      timestamp: ts,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100_000 + (i % 7) * 15_000,
      provider: "alpha_vantage",
      interval: "weekly",
    });
  }
  return bars;
}

function seedRows(symbol: string, n: number): void {
  const bars = makeWeekly(symbol, n);
  const insert = db.prepare(
    `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
     VALUES (?, 'alpha_vantage', 'weekly', ?, ?, ?, ?, ?, ?)`,
  );
  for (const b of bars) {
    insert.run(b.symbol, b.timestamp, b.open, b.high, b.low, b.close, b.volume);
  }
}

// makeWeekly(_, 350) ends Fri 2026-09-11; Wed 09-16 makes that the last completed week.
const WEEK_OF_350 = new Date("2026-09-16T15:00:00Z");

describe("seedSymbol", () => {
  beforeEach(() => {
    db = freshDb();
    mockGetWeekly.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WEEK_OF_350);
  });
  afterEach(() => vi.useRealTimers());

  it("enough rows is not enough: a series that stops before the last completed week is re-fetched", async () => {
    seedRows("SPY", 350);
    vi.setSystemTime(new Date("2026-09-23T15:00:00Z")); // completed week is now 09-18
    mockGetWeekly.mockResolvedValue({ bars: [], provider: "polygon" });
    const result = await seedSymbol("SPY", { minBars: 300 });
    expect(result.skipped).toBe(false);
    expect(mockGetWeekly).toHaveBeenCalledTimes(1);
  });

  it("a mid-week partial of the completed week does not count as its close", async () => {
    seedRows("SPY", 349); // ends Fri 09-04
    db.prepare(
      `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
       VALUES ('SPY', 'alpha_vantage', 'weekly', '2026-09-09T16:00:00-04:00', 1, 2, 0.5, 1, 1)`,
    ).run();
    mockGetWeekly.mockResolvedValue({ bars: [], provider: "polygon" });
    const result = await seedSymbol("SPY", { minBars: 300 });
    expect(result.skipped).toBe(false);
  });

  it("skips when the symbol already has ≥ minBars weekly rows", async () => {
    seedRows("SPY", 350);
    const result = await seedSymbol("SPY", { minBars: 300 });
    expect(result.skipped).toBe(true);
    expect(result.barsBefore).toBe(350);
    expect(result.barsAfter).toBe(350);
    expect(result.barsInserted).toBe(0);
    expect(result.signalsInserted).toBe(0);
    expect(mockGetWeekly).not.toHaveBeenCalled();
  });

  it("fetches via DataLayer when bar count is below minBars, persists signals", async () => {
    // DataLayer persists bars as a side effect of getWeekly; simulate by
    // writing rows inside the mock so countWeeklyBars reflects it.
    const bars = makeWeekly("AAPL", 200);
    mockGetWeekly.mockImplementation(async () => {
      const insert = db.prepare(
        `INSERT INTO market_data (symbol, provider, interval, timestamp, open, high, low, close, volume)
         VALUES (?, 'alpha_vantage', 'weekly', ?, ?, ?, ?, ?, ?)`,
      );
      for (const b of bars) {
        insert.run(
          b.symbol,
          b.timestamp,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume,
        );
      }
      return { bars, provider: "alpha_vantage" };
    });

    const result = await seedSymbol("AAPL", { minBars: 100, lookback: 200 });
    expect(result.skipped).toBe(false);
    expect(result.barsBefore).toBe(0);
    expect(result.barsAfter).toBe(200);
    expect(result.barsInserted).toBe(200);
    expect(mockGetWeekly).toHaveBeenCalledWith("AAPL", { lookback: 200 });
    // Signals should have been run over the bars; at least some firings in 200 weeks
    expect(result.signalsInserted).toBeGreaterThan(0);
  });

  it("captures provider errors without throwing", async () => {
    mockGetWeekly.mockRejectedValue(new Error("AV rate limited"));
    const result = await seedSymbol("NVDA", { minBars: 100 });
    expect(result.skipped).toBe(false);
    expect(result.error).toMatch(/AV rate limited/);
    expect(result.barsInserted).toBe(0);
    expect(result.signalsInserted).toBe(0);
  });

  it("normalizes casing + whitespace on input symbol", async () => {
    seedRows("TSLA", 350);
    const result = await seedSymbol("  tsla ", { minBars: 300 });
    expect(result.symbol).toBe("TSLA");
    expect(result.skipped).toBe(true);
  });
});

describe("formatSeedResult", () => {
  it("formats skipped", () => {
    expect(
      formatSeedResult({
        symbol: "SPY",
        skipped: true,
        barsBefore: 500,
        barsAfter: 500,
        barsInserted: 0,
        signalsInserted: 0,
      }),
    ).toMatch(/skipped.*500/);
  });

  it("formats happy path", () => {
    expect(
      formatSeedResult({
        symbol: "AAPL",
        skipped: false,
        barsBefore: 0,
        barsAfter: 300,
        barsInserted: 300,
        signalsInserted: 42,
      }),
    ).toMatch(/\+300 bars.*\+42 signals/);
  });

  it("formats error", () => {
    expect(
      formatSeedResult({
        symbol: "XYZ",
        skipped: false,
        barsBefore: 0,
        barsAfter: 0,
        barsInserted: 0,
        signalsInserted: 0,
        error: "boom",
      }),
    ).toMatch(/seed error — boom/);
  });
});

describe("refreshWeeklyWatchlist", () => {
  beforeEach(() => {
    db = freshDb();
    mockGetWeekly.mockReset();
    mockGetWeekly.mockResolvedValue({ bars: [], provider: "polygon" });
    __resetForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WEEK_OF_350);
    const add = db.prepare(
      `INSERT INTO watchlist (symbol, asset_class, active) VALUES (?, ?, ?)`,
    );
    add.run("SPY", "etf", 1); // current
    add.run("QQQ", "etf", 1); // stale
    add.run("AAPL", "equity", 1); // no rows at all
    add.run("XLE", "etf", 0); // inactive
    add.run("VIXCLS", "macro", 1); // not a weekly-bar symbol
    seedRows("SPY", 350);
    seedRows("QQQ", 340);
  });
  afterEach(() => vi.useRealTimers());

  it("fetches only the active equity/ETF symbols that lack the last completed week", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const results = await refreshWeeklyWatchlist(sleep);
    expect(mockGetWeekly.mock.calls.map((c) => c[0])).toEqual(["AAPL", "QQQ"]);
    expect(results.map((r) => r.symbol)).toEqual(["AAPL", "QQQ"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits for the Polygon limiter (≤65 s a wait) before fetching a symbol", async () => {
    for (let i = 0; i < 4; i++) recordCall("polygon");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await refreshWeeklyWatchlist(sleep);
    expect(sleep).toHaveBeenCalled();
    const waited = sleep.mock.calls[0]![0] as number;
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(65_000);
  });
});
