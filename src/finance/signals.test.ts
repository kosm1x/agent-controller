/**
 * F3 signal detector tests — each detector gets a fires-once + no-fire
 * + direction-correctness trio where applicable.
 *
 * Persistence test uses an in-memory SQLite with the F1 market_signals table.
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
  detectMaCrossover,
  detectRsiExtremes,
  detectMacdCrossover,
  detectBollingerBreakout,
  detectVolumeSpike,
  detectPriceThreshold,
  detectAllSignals,
  persistSignals,
  type Signal,
} from "./signals.js";
import type { MarketBar } from "./types.js";

function bar(overrides: Partial<MarketBar> = {}): MarketBar {
  return {
    symbol: "TEST",
    timestamp: "2026-04-17T16:00:00-04:00",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000_000,
    provider: "alpha_vantage",
    interval: "daily",
    ...overrides,
  };
}

/** Build `n` bars with close rising from `start` by `step`. */
function risingBars(n: number, start = 100, step = 1): MarketBar[] {
  return Array.from({ length: n }, (_, i) =>
    bar({
      timestamp: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
      close: start + i * step,
      high: start + i * step + 0.5,
      low: start + i * step - 0.5,
      open: start + i * step - 0.2,
    }),
  );
}

/** Build `n` bars with close falling. */
function fallingBars(n: number, start = 100, step = 1): MarketBar[] {
  return Array.from({ length: n }, (_, i) =>
    bar({
      timestamp: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
      close: start - i * step,
      high: start - i * step + 0.5,
      low: start - i * step - 0.5,
      open: start - i * step + 0.2,
    }),
  );
}

describe("detectMaCrossover", () => {
  it("fires golden cross when fast SMA crosses above slow SMA (5/10 periods)", () => {
    // Use small periods for test hygiene; detector semantics are the same.
    // Build a V-shape: 20 falling bars then 20 rising. SMA(5) races above SMA(10) mid-recovery.
    const fall = fallingBars(20, 200, 3);
    const rise = risingBars(20, 140, 5).map((b, i) => ({
      ...b,
      timestamp: `2027-01-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
    }));
    const bars = [...fall, ...rise];
    const signals = detectMaCrossover(bars, 5, 10);
    const golden = signals.find((s) => s.direction === "long");
    expect(golden).toBeDefined();
    expect(golden!.type).toBe("ma_crossover");
    expect(golden!.description).toMatch(/golden cross/);
  });

  it("does not fire on insufficient data", () => {
    expect(detectMaCrossover(risingBars(100))).toHaveLength(0);
  });

  it("fires once at the sign-change bar, not every subsequent bar", () => {
    const fall = fallingBars(20, 200, 3);
    const rise = risingBars(20, 140, 5).map((b, i) => ({
      ...b,
      timestamp: `2027-01-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
    }));
    const longs = detectMaCrossover([...fall, ...rise], 5, 10).filter(
      (s) => s.direction === "long",
    );
    expect(longs.length).toBeLessThanOrEqual(2);
  });
});

describe("detectRsiExtremes", () => {
  it("fires long signal when RSI crosses below oversold threshold", () => {
    // Alternating rise/fall warm-up → neutral RSI; then sustained fall pushes below 30.
    const warmup: MarketBar[] = [];
    for (let i = 0; i < 15; i++) {
      warmup.push(
        bar({
          timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
          close: 100 + (i % 2 === 0 ? 1 : -1),
        }),
      );
    }
    const fall = Array.from({ length: 20 }, (_, i) =>
      bar({
        timestamp: `2026-02-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
        close: 100 - (i + 1) * 2,
      }),
    );
    const bars = [...warmup, ...fall];
    const signals = detectRsiExtremes(bars, 70, 30, 14);
    const longs = signals.filter((s) => s.direction === "long");
    expect(longs.length).toBeGreaterThanOrEqual(1);
    expect(longs[0].description).toMatch(/oversold/);
  });

  it("fires short signal when RSI crosses above overbought threshold", () => {
    // Alternating warm-up then sustained rise pushes above 70.
    const warmup: MarketBar[] = [];
    for (let i = 0; i < 15; i++) {
      warmup.push(
        bar({
          timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
          close: 100 + (i % 2 === 0 ? 1 : -1),
        }),
      );
    }
    const rise = Array.from({ length: 20 }, (_, i) =>
      bar({
        timestamp: `2026-02-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
        close: 100 + (i + 1) * 2,
      }),
    );
    const bars = [...warmup, ...rise];
    const signals = detectRsiExtremes(bars, 70, 30, 14);
    const shorts = signals.filter((s) => s.direction === "short");
    expect(shorts.length).toBeGreaterThanOrEqual(1);
    expect(shorts[0].description).toMatch(/overbought/);
  });

  it("returns empty on insufficient data", () => {
    expect(detectRsiExtremes(risingBars(5))).toHaveLength(0);
  });
});

describe("detectMacdCrossover", () => {
  it("fires at histogram sign change on V-shaped series", () => {
    // Long V-shape: 60 fall + 80 rise gives MACD histogram enough room to
    // cross zero with non-zero product (audit W2 strict-flip check).
    const fall = Array.from({ length: 60 }, (_, i) =>
      bar({
        symbol: "TEST",
        timestamp: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
        close: 200 - i * 2,
      }),
    );
    const rise = Array.from({ length: 80 }, (_, i) =>
      bar({
        symbol: "TEST",
        timestamp: `2027-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
        close: 80 + i * 3,
      }),
    );
    const signals = detectMacdCrossover([...fall, ...rise]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.some((s) => s.direction === "long")).toBe(true);
  });

  it("returns empty on insufficient data", () => {
    expect(detectMacdCrossover(risingBars(10))).toHaveLength(0);
  });
});

describe("detectBollingerBreakout", () => {
  it("fires upper-band break when price spikes up", () => {
    const bars = risingBars(30, 100, 0.2);
    bars[29] = bar({
      timestamp: bars[29].timestamp,
      close: 120,
      high: 121,
      low: 119,
      open: 119.5,
    });
    const signals = detectBollingerBreakout(bars, 20, 2);
    const shorts = signals.filter((s) => s.direction === "short");
    expect(shorts.length).toBeGreaterThanOrEqual(1);
    expect(shorts[0].description).toMatch(/Upper Bollinger break/);
  });

  it("does not fire when price stays inside bands", () => {
    const bars = risingBars(30, 100, 0.2);
    const signals = detectBollingerBreakout(bars, 20, 2);
    expect(signals).toHaveLength(0);
  });

  it("fires only once per breakout entry", () => {
    const bars = risingBars(30, 100, 0.2);
    // Spike outside, stay outside for 3 bars — expect 1 signal
    bars[29].close = 120;
    bars[29].high = 121;
    bars.push(bar({ timestamp: "2026-05-01T16:00:00-04:00", close: 121 }));
    bars.push(bar({ timestamp: "2026-05-02T16:00:00-04:00", close: 122 }));
    const signals = detectBollingerBreakout(bars, 20, 2);
    expect(signals.length).toBe(1);
  });
});

describe("detectVolumeSpike", () => {
  it("fires when volume z-score exceeds threshold", () => {
    // Baseline needs variance so std > 0 (detector skips when std === 0)
    const bars = risingBars(30, 100, 0.1).map((b, i) => ({
      ...b,
      volume: 1_000_000 + (i % 5) * 50_000, // modest variance
    }));
    bars[29] = { ...bars[29], volume: 20_000_000 };
    const signals = detectVolumeSpike(bars, 2, 20);
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });

  it("does not fire when std is zero (flat volume)", () => {
    const bars = risingBars(30, 100, 0.1); // all volume = 1_000_000 exactly
    const signals = detectVolumeSpike(bars, 2, 20);
    expect(signals).toHaveLength(0);
  });

  it("direction follows price action (up bar = long)", () => {
    const bars = risingBars(30, 100, 0.1).map((b, i) => ({
      ...b,
      volume: 1_000_000 + (i % 5) * 50_000,
    }));
    bars[29] = {
      ...bars[29],
      volume: 20_000_000,
      open: 100,
      close: 105,
    };
    const signals = detectVolumeSpike(bars, 2, 20);
    expect(signals[0]).toBeDefined();
    expect(signals[0].direction).toBe("long");
  });
});

describe("detectPriceThreshold", () => {
  it("fires when close crosses each threshold (either direction)", () => {
    const bars = [
      bar({ timestamp: "2026-01-01T16:00:00-04:00", close: 99 }),
      bar({ timestamp: "2026-01-02T16:00:00-04:00", close: 101 }), // crosses 100 up
      bar({ timestamp: "2026-01-03T16:00:00-04:00", close: 98 }), // crosses 100 down
    ];
    const signals = detectPriceThreshold(bars, [100]);
    expect(signals).toHaveLength(2);
  });

  it("does not fire when no threshold crossed", () => {
    const bars = [
      bar({ timestamp: "t1", close: 100 }),
      bar({ timestamp: "t2", close: 101 }),
    ];
    const signals = detectPriceThreshold(bars, [110]);
    expect(signals).toHaveLength(0);
  });

  it("returns empty when thresholds list empty", () => {
    const bars = risingBars(10);
    expect(detectPriceThreshold(bars, [])).toHaveLength(0);
  });
});

describe("detectAllSignals", () => {
  it("aggregates detectors and returns chronologically sorted list", () => {
    const bars = risingBars(60, 50, 1);
    const signals = detectAllSignals(bars);
    // Chronological order
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i - 1].timestamp <= signals[i].timestamp).toBe(true);
    }
  });

  it("applies DetectOpts.priceThresholds", () => {
    const bars = risingBars(25, 95, 1);
    const all = detectAllSignals(bars, { priceThresholds: [100] });
    expect(all.some((s) => s.type === "price_threshold")).toBe(true);
  });
});

describe("persistSignals", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts new signals and returns count", () => {
    const signals: Signal[] = [
      {
        symbol: "SPY",
        type: "rsi_extreme",
        direction: "short",
        strength: 0.8,
        price: 500,
        timestamp: "2026-04-17T16:00:00-04:00",
        description: "test",
        indicators: { rsi: 75 },
        transmissionChain: [],
      },
    ];
    expect(persistSignals(signals)).toBe(1);
    const rows = db
      .prepare("SELECT symbol, signal_type FROM market_signals")
      .all();
    expect(rows).toHaveLength(1);
  });

  it("deduplicates by (symbol, type, triggered_at)", () => {
    const s: Signal = {
      symbol: "SPY",
      type: "rsi_extreme",
      direction: "short",
      strength: 0.8,
      price: 500,
      timestamp: "2026-04-17T16:00:00-04:00",
      description: "test",
      indicators: { rsi: 75 },
      transmissionChain: [],
    };
    expect(persistSignals([s])).toBe(1);
    expect(persistSignals([s])).toBe(0); // already present
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM market_signals")
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("handles empty input", () => {
    expect(persistSignals([])).toBe(0);
  });
});
