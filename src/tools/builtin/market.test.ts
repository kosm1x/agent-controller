/**
 * Tool-level tests for F4 consumer tools (marketIndicatorsTool, marketScanTool).
 * Mocks DataLayer to exercise indicator computation + watchlist iteration
 * + operator dispatch + output formatting.
 *
 * Audit W5: integration checklist row 7 — closes the F4 test-coverage gap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLayer = {
  getDaily: vi.fn(),
  getIntraday: vi.fn(),
  listWatchlist: vi.fn(),
};

vi.mock("../../finance/data-layer.js", () => ({
  getDataLayer: () => mockLayer,
}));

vi.mock("../../finance/budget.js", () => ({
  budgetSummary: () => [],
}));

vi.mock("../../finance/rate-limit.js", () => ({
  currentWindow: () => ({}),
  ceilings: () => ({}),
}));

import { marketIndicatorsTool, marketScanTool } from "./market.js";
import type { MarketBar } from "../../finance/types.js";

/** Build a monotonic-up series of `n` bars close to the given base price. */
function makeBars(symbol: string, n: number, basePrice = 100): MarketBar[] {
  const bars: MarketBar[] = [];
  for (let i = 0; i < n; i++) {
    const c = basePrice + i * 0.5 + Math.sin(i / 3) * 0.8;
    bars.push({
      symbol,
      timestamp: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
      open: c - 0.3,
      high: c + 0.5,
      low: c - 0.5,
      close: c,
      volume: 1_000_000 + i * 1000,
      provider: "alpha_vantage",
      interval: "daily",
    });
  }
  return bars;
}

describe("marketIndicatorsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes the default daily indicator set (no VWAP)", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: makeBars("SPY", 60),
      provider: "alpha_vantage",
    });
    const result = await marketIndicatorsTool.execute({ symbol: "SPY" });
    const text = result as string;
    // Default includes these 8 (VWAP excluded on daily per audit W3/W6)
    expect(text).toContain("SPY (daily, 60 bars)");
    expect(text).toContain("SMA(20)");
    expect(text).toContain("EMA(20)");
    expect(text).toContain("RSI(14)");
    expect(text).toContain("MACD(12,26,9)");
    expect(text).toContain("Bollinger(20,2)");
    expect(text).toContain("ATR(14)");
    expect(text).toContain("ROC(10)");
    expect(text).toContain("Williams %R(14)");
    // Default must NOT emit VWAP on daily
    expect(text).not.toContain("VWAP");
  });

  it("uppercases symbol and returns error when missing", async () => {
    const out = await marketIndicatorsTool.execute({});
    expect(JSON.parse(out as string).error).toMatch(/symbol/);
  });

  it("emits VWAP skip message when explicitly requested on daily", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: makeBars("SPY", 40),
      provider: "alpha_vantage",
    });
    const result = (await marketIndicatorsTool.execute({
      symbol: "SPY",
      indicators: ["vwap"],
    })) as string;
    expect(result).toContain("skipped on daily — cumulative across sessions");
  });

  it("routes to intraday when interval is intraday", async () => {
    mockLayer.getIntraday.mockResolvedValue({
      bars: makeBars("AAPL", 40),
      provider: "alpha_vantage",
    });
    const result = (await marketIndicatorsTool.execute({
      symbol: "AAPL",
      interval: "5min",
      indicators: ["vwap"],
    })) as string;
    expect(mockLayer.getIntraday).toHaveBeenCalled();
    // Intraday VWAP computed, no skip note
    expect(result).toContain("VWAP          =");
    expect(result).not.toContain("skipped");
  });
});

describe("marketScanTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty-watchlist message when listWatchlist is empty", async () => {
    mockLayer.listWatchlist.mockReturnValue([]);
    const result = (await marketScanTool.execute({
      indicator: "rsi",
      operator: "lt",
      threshold: 30,
    })) as string;
    expect(result).toContain("watchlist is empty");
  });

  it("finds symbols where RSI < threshold and sorts ascending", async () => {
    mockLayer.listWatchlist.mockReturnValue([
      {
        symbol: "AAA",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
      {
        symbol: "BBB",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
    ]);
    // AAA: strictly rising → RSI high (~100), BBB: mixed → RSI moderate
    const risingBars = makeBars("AAA", 40, 100).map((b, i) => ({
      ...b,
      close: 100 + i * 1.0, // strictly rising = RSI → 100 (above 30)
      high: 101 + i * 1.0,
      low: 99 + i * 1.0,
    }));
    const fallingBars = makeBars("BBB", 40, 100).map((b, i) => ({
      ...b,
      close: 100 - i * 1.0, // strictly falling = RSI → 0 (below 30)
      high: 101 - i * 1.0,
      low: 99 - i * 1.0,
    }));
    mockLayer.getDaily
      .mockResolvedValueOnce({ bars: risingBars, provider: "alpha_vantage" })
      .mockResolvedValueOnce({ bars: fallingBars, provider: "alpha_vantage" });

    const result = (await marketScanTool.execute({
      indicator: "rsi",
      operator: "lt",
      threshold: 30,
    })) as string;
    // BBB matches (falling → RSI 0 < 30), AAA does not (rising → RSI 100)
    expect(result).toContain("BBB");
    expect(result).not.toMatch(/AAA: /);
  });

  it("sorts descending for operator=gt (audit W2)", async () => {
    mockLayer.listWatchlist.mockReturnValue([
      {
        symbol: "LOW",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
      {
        symbol: "HIGH",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
    ]);
    // Both rising → both RSI near 100 but with slight difference via volatility
    const lowerRsiBars = makeBars("LOW", 40, 100).map((b, i) => ({
      ...b,
      close: 100 + i * 0.5 + (i % 2 === 0 ? 0.3 : -0.3), // zig-zag = lower RSI
      high: 101 + i * 0.5,
      low: 99 + i * 0.5,
    }));
    const higherRsiBars = makeBars("HIGH", 40, 100).map((b, i) => ({
      ...b,
      close: 100 + i * 1.0, // strictly rising = RSI 100
      high: 101 + i * 1.0,
      low: 99 + i * 1.0,
    }));
    mockLayer.getDaily
      .mockResolvedValueOnce({ bars: lowerRsiBars, provider: "alpha_vantage" })
      .mockResolvedValueOnce({
        bars: higherRsiBars,
        provider: "alpha_vantage",
      });

    const result = (await marketScanTool.execute({
      indicator: "rsi",
      operator: "gt",
      threshold: 50,
    })) as string;
    // Both match. With descending sort, HIGH (RSI=100) appears before LOW.
    const highIdx = result.indexOf("HIGH");
    const lowIdx = result.indexOf("LOW");
    expect(highIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("filters watchlist by tags when provided", async () => {
    mockLayer.listWatchlist.mockReturnValue([
      {
        symbol: "TECH1",
        assetClass: "equity",
        tags: ["tech"],
        active: true,
        addedAt: "x",
      },
      {
        symbol: "FIN1",
        assetClass: "equity",
        tags: ["finance"],
        active: true,
        addedAt: "x",
      },
    ]);
    mockLayer.getDaily.mockResolvedValue({
      bars: makeBars("TECH1", 40),
      provider: "alpha_vantage",
    });
    const result = (await marketScanTool.execute({
      indicator: "sma",
      operator: "gt",
      threshold: 0,
      tags: ["tech"],
    })) as string;
    // Only TECH1 should be fetched
    expect(mockLayer.getDaily).toHaveBeenCalledTimes(1);
    expect((mockLayer.getDaily as any).mock.calls[0][0]).toBe("TECH1");
    expect(result).toContain("scanned 1");
  });

  it("reports skipped entries when insufficient bars", async () => {
    mockLayer.listWatchlist.mockReturnValue([
      {
        symbol: "NEW",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
    ]);
    mockLayer.getDaily.mockResolvedValue({
      bars: makeBars("NEW", 10),
      provider: "alpha_vantage",
    });
    const result = (await marketScanTool.execute({
      indicator: "rsi",
      operator: "lt",
      threshold: 30,
    })) as string;
    expect(result).toContain("Skipped");
    expect(result).toContain("insufficient bars");
  });

  it("validates required args", async () => {
    const out = await marketScanTool.execute({ indicator: "rsi" });
    expect(JSON.parse(out as string).error).toMatch(
      /indicator, operator, threshold/,
    );
  });
});
