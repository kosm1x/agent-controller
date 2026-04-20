import { describe, it, expect } from "vitest";
import {
  detectPivots,
  fitTrendChannel,
  detectConsolidation,
} from "./trend-channel.js";
import type { MarketBar } from "./types.js";

function mkBar(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
): MarketBar {
  return {
    symbol: "TEST",
    timestamp: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open,
    high,
    low,
    close,
    volume: 1_000_000,
    provider: "alpha_vantage",
    interval: "daily",
  };
}

function uptrend(n: number, slope = 1): MarketBar[] {
  return Array.from({ length: n }, (_, i) =>
    mkBar(
      i,
      100 + slope * i,
      101 + slope * i,
      99 + slope * i,
      100.5 + slope * i,
    ),
  );
}

function downtrend(n: number, slope = 1): MarketBar[] {
  return Array.from({ length: n }, (_, i) =>
    mkBar(
      i,
      200 - slope * i,
      201 - slope * i,
      199 - slope * i,
      200.5 - slope * i,
    ),
  );
}

function sideways(n: number, noise = 0.5): MarketBar[] {
  return Array.from({ length: n }, (_, i) => {
    const wiggle = Math.sin(i * 0.4) * noise;
    return mkBar(i, 100 + wiggle, 100.8 + wiggle, 99.2 + wiggle, 100 + wiggle);
  });
}

describe("detectPivots", () => {
  it("finds a local high surrounded by lower bars", () => {
    const bars: MarketBar[] = [
      mkBar(0, 100, 101, 99, 100),
      mkBar(1, 101, 102, 100, 101),
      mkBar(2, 102, 110, 101, 109), // pivot high at index 2
      mkBar(3, 101, 103, 100, 101),
      mkBar(4, 100, 101, 99, 100),
      mkBar(5, 99, 100, 98, 99),
      mkBar(6, 98, 99, 97, 98),
    ];
    const { highs } = detectPivots(bars, 2);
    expect(highs.map((h) => h.index)).toEqual([2]);
    expect(highs[0].value).toBe(110);
  });

  it("finds a local low surrounded by higher bars", () => {
    const bars: MarketBar[] = [
      mkBar(0, 100, 102, 98, 100),
      mkBar(1, 100, 102, 99, 100),
      mkBar(2, 100, 102, 90, 95), // pivot low at index 2
      mkBar(3, 100, 102, 99, 100),
      mkBar(4, 100, 102, 99, 100),
    ];
    const { lows } = detectPivots(bars, 2);
    expect(lows.map((l) => l.index)).toEqual([2]);
    expect(lows[0].value).toBe(90);
  });

  it("returns empty when bars < 2*window+1", () => {
    const bars = uptrend(4);
    const { highs, lows } = detectPivots(bars, 3);
    expect(highs).toEqual([]);
    expect(lows).toEqual([]);
  });

  it("returns empty when window < 1", () => {
    const bars = uptrend(20);
    const { highs, lows } = detectPivots(bars, 0);
    expect(highs).toEqual([]);
    expect(lows).toEqual([]);
  });
});

describe("fitTrendChannel", () => {
  it("labels strict uptrend correctly, slopes ≈ +1", () => {
    const bars = uptrend(50, 1);
    const tc = fitTrendChannel(bars);
    expect(tc.direction).toBe("uptrend");
    expect(tc.upper.slope).toBeGreaterThan(0.9);
    expect(tc.upper.slope).toBeLessThan(1.1);
    expect(tc.lower.slope).toBeGreaterThan(0.9);
    expect(tc.lower.slope).toBeLessThan(1.1);
    expect(tc.consolidation).toBe(false);
  });

  it("labels strict downtrend correctly, slopes ≈ −1", () => {
    const bars = downtrend(50, 1);
    const tc = fitTrendChannel(bars);
    expect(tc.direction).toBe("downtrend");
    expect(tc.upper.slope).toBeLessThan(-0.9);
    expect(tc.lower.slope).toBeLessThan(-0.9);
  });

  it("labels sideways chop as sideways", () => {
    const bars = sideways(60, 0.5);
    const tc = fitTrendChannel(bars);
    expect(tc.direction).toBe("sideways");
  });

  it("flags consolidation when width < 2 * avgATR", () => {
    // Very tight range: ATR ≈ 0.2, width should be near zero
    const bars = sideways(40, 0.1);
    const tc = fitTrendChannel(bars);
    expect(tc.consolidation).toBe(true);
    expect(tc.channelWidthAtLast).not.toBeNull();
    expect(tc.avgATR).not.toBeNull();
  });

  it("does NOT flag consolidation in a trending market", () => {
    const bars = uptrend(50, 3); // strong trend + wide daily range
    const tc = fitTrendChannel(bars);
    expect(tc.consolidation).toBe(false);
  });

  it("falls back to full series when pivots are insufficient", () => {
    const bars = uptrend(7, 1);
    const tc = fitTrendChannel(bars, { pivotWindow: 3 });
    // Only 1 pivot possible with 7 bars + window=3 → falls back to full high/low series
    expect(tc.upper.pivots.length).toBe(7);
    expect(tc.lower.pivots.length).toBe(7);
  });

  it("produces ChannelLine with finite slope, intercept, r²", () => {
    const bars = uptrend(30, 1);
    const tc = fitTrendChannel(bars);
    expect(Number.isFinite(tc.upper.slope)).toBe(true);
    expect(Number.isFinite(tc.upper.intercept)).toBe(true);
    expect(tc.upper.r2).toBeGreaterThanOrEqual(0);
    expect(tc.upper.r2).toBeLessThanOrEqual(1);
  });

  it("has r² near 1 for a perfectly linear trend", () => {
    const bars = uptrend(40, 1);
    const tc = fitTrendChannel(bars);
    expect(tc.upper.r2).toBeGreaterThan(0.99);
    expect(tc.lower.r2).toBeGreaterThan(0.99);
  });

  it("exposes midline slope via slopePerBar", () => {
    const bars = uptrend(40, 2);
    const tc = fitTrendChannel(bars);
    expect(tc.slopePerBar).toBeGreaterThan(1.9);
    expect(tc.slopePerBar).toBeLessThan(2.1);
  });
});

describe("detectConsolidation", () => {
  it("true on sideways chop", () => {
    expect(detectConsolidation(sideways(40, 0.1))).toBe(true);
  });

  it("false on strong uptrend", () => {
    expect(detectConsolidation(uptrend(40, 3))).toBe(false);
  });
});
