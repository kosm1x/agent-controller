import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  d.exec(schema);
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

import {
  persistChartPattern,
  getChartPatternById,
  listChartPatternsBySymbol,
  listRecentChartPatterns,
} from "./chart-patterns-persist.js";

beforeEach(() => {
  db = freshDb();
});

describe("persistChartPattern", () => {
  it("inserts a row and returns the new id", () => {
    const id = persistChartPattern({
      symbol: "SPY",
      interval: "daily",
      pattern_label: "head_and_shoulders",
      confidence: 0.72,
      candle_start: 3,
      candle_end: 18,
      png_path: "/tmp/spy.png",
      rationale: "clear neckline breach",
    });
    expect(id).toBeGreaterThan(0);
    const row = getChartPatternById(id);
    expect(row?.symbol).toBe("SPY");
    expect(row?.pattern_label).toBe("head_and_shoulders");
    expect(row?.confidence).toBeCloseTo(0.72, 6);
  });

  it("allows nullable candle range + png_path + rationale", () => {
    const id = persistChartPattern({
      symbol: "AAPL",
      interval: "weekly",
      pattern_label: "none",
      confidence: 0,
    });
    const row = getChartPatternById(id);
    expect(row?.candle_start).toBeNull();
    expect(row?.candle_end).toBeNull();
    expect(row?.png_path).toBeNull();
    expect(row?.rationale).toBeNull();
  });

  it("clamps confidence to [0,1]", () => {
    const id = persistChartPattern({
      symbol: "QQQ",
      interval: "daily",
      pattern_label: "ascending_triangle",
      confidence: 1.5,
    });
    expect(getChartPatternById(id)?.confidence).toBe(1);

    const id2 = persistChartPattern({
      symbol: "QQQ",
      interval: "daily",
      pattern_label: "none",
      confidence: -0.3,
    });
    expect(getChartPatternById(id2)?.confidence).toBe(0);
  });

  it("rejects non-finite confidence", () => {
    expect(() =>
      persistChartPattern({
        symbol: "SPY",
        interval: "daily",
        pattern_label: "x",
        confidence: Number.NaN,
      }),
    ).toThrow(/finite/);
    expect(() =>
      persistChartPattern({
        symbol: "SPY",
        interval: "daily",
        pattern_label: "x",
        confidence: Infinity,
      }),
    ).toThrow(/finite/);
  });

  it("CHECK constraint rejects invalid interval", () => {
    expect(() =>
      persistChartPattern({
        symbol: "SPY",
        interval: "intraday" as unknown as "daily",
        pattern_label: "x",
        confidence: 0.5,
      }),
    ).toThrow();
  });
});

describe("listChartPatternsBySymbol", () => {
  it("returns rows for a symbol, most recent first", () => {
    persistChartPattern({
      symbol: "SPY",
      interval: "daily",
      pattern_label: "a",
      confidence: 0.5,
    });
    persistChartPattern({
      symbol: "SPY",
      interval: "daily",
      pattern_label: "b",
      confidence: 0.6,
    });
    persistChartPattern({
      symbol: "AAPL",
      interval: "daily",
      pattern_label: "c",
      confidence: 0.4,
    });
    const spy = listChartPatternsBySymbol("SPY");
    expect(spy).toHaveLength(2);
    expect(spy.every((r) => r.symbol === "SPY")).toBe(true);
  });

  it("clamps limit to [1,500]", () => {
    for (let i = 0; i < 3; i++) {
      persistChartPattern({
        symbol: "SPY",
        interval: "daily",
        pattern_label: "x",
        confidence: 0.5,
      });
    }
    expect(listChartPatternsBySymbol("SPY", 0)).toHaveLength(1);
    expect(listChartPatternsBySymbol("SPY", 10_000)).toHaveLength(3);
  });
});

describe("listRecentChartPatterns", () => {
  it("returns most-recent rows across all symbols", () => {
    persistChartPattern({
      symbol: "SPY",
      interval: "daily",
      pattern_label: "a",
      confidence: 0.1,
    });
    persistChartPattern({
      symbol: "AAPL",
      interval: "daily",
      pattern_label: "b",
      confidence: 0.2,
    });
    const rows = listRecentChartPatterns(10);
    expect(rows).toHaveLength(2);
  });
});
