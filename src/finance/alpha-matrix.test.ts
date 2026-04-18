/**
 * Unit tests for F7 return-matrix builder.
 */

import { describe, it, expect } from "vitest";
import {
  buildReturnMatrix,
  signalKey,
  parseSignalKey,
  resolvePeriodsFromBars,
  type FiringRow,
  type BarRow,
} from "./alpha-matrix.js";

const makeFiring = (over: Partial<FiringRow> = {}): FiringRow => ({
  symbol: "AAPL",
  signal_type: "rsi_extreme",
  direction: "long",
  strength: 0.8,
  triggered_at: "2026-04-10",
  ...over,
});

const makeBar = (over: Partial<BarRow> = {}): BarRow => ({
  symbol: "AAPL",
  timestamp: "2026-04-10",
  close: 100,
  ...over,
});

describe("signalKey / parseSignalKey", () => {
  it("round-trips", () => {
    const k = signalKey("rsi_extreme", "AAPL");
    expect(k).toBe("rsi_extreme:AAPL");
    expect(parseSignalKey(k)).toEqual({ type: "rsi_extreme", symbol: "AAPL" });
  });
  it("handles colons in symbol (BRK.B has no colon, but tickers with separators work)", () => {
    const k = signalKey("volume_spike", "BRK.B");
    expect(parseSignalKey(k)).toEqual({
      type: "volume_spike",
      symbol: "BRK.B",
    });
  });
  it("throws on malformed key", () => {
    expect(() => parseSignalKey("no-colon-here")).toThrow(/missing ':'/);
  });
});

describe("buildReturnMatrix", () => {
  const periods = [
    "2026-04-08",
    "2026-04-09",
    "2026-04-10",
    "2026-04-11",
    "2026-04-12",
  ];

  it("returns empty result for zero periods", () => {
    const r = buildReturnMatrix({ firings: [], bars: [], periods: [] });
    expect(r.N).toBe(0);
    expect(r.M).toBe(0);
    expect(r.signalKeys).toEqual([]);
  });

  it("happy path — 1 signal fires in 2 periods with matching bars", () => {
    const firings: FiringRow[] = [
      makeFiring({ triggered_at: "2026-04-09" }),
      makeFiring({ triggered_at: "2026-04-11" }),
    ];
    const bars: BarRow[] = [
      makeBar({ timestamp: "2026-04-08", close: 100 }),
      makeBar({ timestamp: "2026-04-09", close: 102 }),
      makeBar({ timestamp: "2026-04-10", close: 104 }),
      makeBar({ timestamp: "2026-04-11", close: 108 }),
      makeBar({ timestamp: "2026-04-12", close: 110 }),
    ];
    const r = buildReturnMatrix({ firings, bars, periods });
    expect(r.N).toBe(1);
    expect(r.M).toBe(5);
    expect(r.signalKeys).toEqual(["rsi_extreme:AAPL"]);
    // s=0 (no firing) → 0
    expect(r.R[0]).toBe(0);
    // s=1 firing, horizon=1, close 102 → 104 ≈ +1.96%
    expect(r.R[1]).toBeCloseTo((104 - 102) / 102, 10);
    // s=2 no firing → 0
    expect(r.R[2]).toBe(0);
    // s=3 firing, 108 → 110 ≈ +1.85%
    expect(r.R[3]).toBeCloseTo((110 - 108) / 108, 10);
    // s=4 no firing and last period anyway → 0
    expect(r.R[4]).toBe(0);
    expect(r.flags).toEqual([]);
    expect(r.excludePremature.size).toBe(0);
  });

  it("negates returns for short-direction firings", () => {
    const firings: FiringRow[] = [
      makeFiring({ direction: "short", triggered_at: "2026-04-09" }),
    ];
    const bars: BarRow[] = [
      makeBar({ timestamp: "2026-04-09", close: 100 }),
      makeBar({ timestamp: "2026-04-10", close: 105 }),
    ];
    const r = buildReturnMatrix({ firings, bars, periods });
    expect(r.R[1]).toBeCloseTo(-0.05, 10);
  });

  it("flags firings at last period (horizon out of window)", () => {
    const firings: FiringRow[] = [
      makeFiring({ triggered_at: "2026-04-12" }), // last period
    ];
    const bars: BarRow[] = [makeBar({ timestamp: "2026-04-12", close: 100 })];
    const r = buildReturnMatrix({ firings, bars, periods });
    expect(r.R[4]).toBe(0);
    expect(r.flags.length).toBe(1);
    expect(r.flags[0]!.reason).toBe("out_of_window_forward");
    // Single firing attempt, single flag → 100% flag ratio → excluded
    expect(r.excludePremature.has(0)).toBe(true);
  });

  it("flags missing forward close without producing NaN", () => {
    const firings: FiringRow[] = [makeFiring({ triggered_at: "2026-04-09" })];
    const bars: BarRow[] = [
      makeBar({ timestamp: "2026-04-09", close: 100 }),
      // 2026-04-10 missing
    ];
    const r = buildReturnMatrix({ firings, bars, periods });
    expect(r.R[1]).toBe(0);
    expect(Number.isFinite(r.R[1]!)).toBe(true);
    expect(r.flags[0]!.reason).toBe("missing_close_forward");
  });

  it("guards divide-by-zero on zero close", () => {
    const firings: FiringRow[] = [makeFiring({ triggered_at: "2026-04-09" })];
    const bars: BarRow[] = [
      makeBar({ timestamp: "2026-04-09", close: 0 }),
      makeBar({ timestamp: "2026-04-10", close: 100 }),
    ];
    const r = buildReturnMatrix({ firings, bars, periods });
    expect(r.R[1]).toBe(0);
    expect(r.flags[0]!.reason).toBe("missing_close_now");
  });

  it("does NOT exclude signals below the flag threshold (5% default)", () => {
    // 10 firings, 1 flagged (10% — above threshold), should be excluded
    const bars: BarRow[] = [];
    const firings: FiringRow[] = [];
    const big: string[] = [];
    for (let d = 1; d <= 20; d++) {
      const day = `2026-04-${d.toString().padStart(2, "0")}`;
      big.push(day);
      bars.push(makeBar({ timestamp: day, close: 100 + d }));
    }
    // 10 firings on consecutive days; last day is "good" (has forward close)
    for (let d = 1; d <= 10; d++) {
      firings.push(
        makeFiring({
          triggered_at: `2026-04-${d.toString().padStart(2, "0")}`,
        }),
      );
    }
    // Flag one: delete the forward close for day 5 (so firing at day 5 flags)
    const barsFiltered = bars.filter((b) => b.timestamp !== "2026-04-06");
    const r = buildReturnMatrix({ firings, bars: barsFiltered, periods: big });
    // 10 attempts, 1 flag = 10% > 5% → excluded
    expect(r.excludePremature.has(0)).toBe(true);
  });

  it("does NOT exclude signals at-or-below threshold", () => {
    const bars: BarRow[] = [];
    const firings: FiringRow[] = [];
    const big: string[] = [];
    for (let d = 1; d <= 30; d++) {
      const day = `2026-04-${d.toString().padStart(2, "0")}`;
      big.push(day);
      bars.push(makeBar({ timestamp: day, close: 100 + d }));
    }
    // 21 firings, all with valid forward closes → 0 flags → not excluded
    for (let d = 1; d <= 21; d++) {
      firings.push(
        makeFiring({
          triggered_at: `2026-04-${d.toString().padStart(2, "0")}`,
        }),
      );
    }
    const r = buildReturnMatrix({ firings, bars, periods: big });
    expect(r.excludePremature.has(0)).toBe(false);
    expect(r.flags.length).toBe(0);
  });

  it("produces stable signalKeys ordering across runs", () => {
    const firings: FiringRow[] = [
      makeFiring({ symbol: "TSLA", signal_type: "rsi_extreme" }),
      makeFiring({ symbol: "AAPL", signal_type: "rsi_extreme" }),
      makeFiring({ symbol: "AAPL", signal_type: "macd_crossover" }),
    ];
    const r = buildReturnMatrix({ firings, bars: [], periods });
    expect(r.signalKeys).toEqual([
      "macd_crossover:AAPL",
      "rsi_extreme:AAPL",
      "rsi_extreme:TSLA",
    ]);
  });

  it("horizon=5 (weekly) computes correct forward index", () => {
    const firings: FiringRow[] = [makeFiring({ triggered_at: "2026-04-08" })];
    const bars: BarRow[] = [];
    for (let d = 1; d <= 15; d++) {
      const day = `2026-04-${d.toString().padStart(2, "0")}`;
      bars.push(makeBar({ timestamp: day, close: 100 + d * 2 }));
    }
    const p: string[] = [];
    for (let d = 1; d <= 15; d++) {
      p.push(`2026-04-${d.toString().padStart(2, "0")}`);
    }
    const r = buildReturnMatrix({ firings, bars, periods: p, horizon: 5 });
    // s=7 corresponds to 2026-04-08. Forward = s+5 = 12 → 2026-04-13.
    // closes: day 8 → 116, day 13 → 126. Ret = 126/116 - 1 ≈ 0.08620689...
    const dayIdx = p.indexOf("2026-04-08");
    expect(r.R[dayIdx]).toBeCloseTo(126 / 116 - 1, 10);
  });

  it("rejects horizon < 1", () => {
    expect(() =>
      buildReturnMatrix({ firings: [], bars: [], periods, horizon: 0 }),
    ).toThrow(/horizon must be >= 1/);
  });
});

describe("resolvePeriodsFromBars", () => {
  it("returns last M sorted calendar days filtered to asOf inclusive", () => {
    const bars: BarRow[] = [
      { symbol: "AAPL", timestamp: "2026-04-08", close: 100 },
      { symbol: "AAPL", timestamp: "2026-04-09", close: 101 },
      { symbol: "AAPL", timestamp: "2026-04-10", close: 102 },
      { symbol: "TSLA", timestamp: "2026-04-10", close: 200 }, // duplicate day → dedup
      { symbol: "AAPL", timestamp: "2026-04-11", close: 103 }, // > asOf, filtered
    ];
    const p = resolvePeriodsFromBars(bars, "2026-04-10", 3);
    expect(p).toEqual(["2026-04-08", "2026-04-09", "2026-04-10"]);
  });

  it("returns all days if fewer than M available", () => {
    const bars: BarRow[] = [
      { symbol: "AAPL", timestamp: "2026-04-08", close: 100 },
    ];
    expect(resolvePeriodsFromBars(bars, "2026-04-10", 5)).toEqual([
      "2026-04-08",
    ]);
  });
});
