/**
 * Tool-level tests for F4 consumer tools (marketIndicatorsTool, marketScanTool).
 * Mocks DataLayer to exercise indicator computation + watchlist iteration
 * + operator dispatch + output formatting.
 *
 * Audit W5: integration checklist row 7 — closes the F4 test-coverage gap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLayer = {
  getQuote: vi.fn(),
  getDaily: vi.fn(),
  getIntraday: vi.fn(),
  getWeekly: vi.fn(),
  getMacro: vi.fn(),
  listWatchlist: vi.fn(),
  addToWatchlist: vi.fn(),
};

vi.mock("../../finance/data-layer.js", () => ({
  getDataLayer: () => mockLayer,
}));

const mockSeedSymbol = vi.fn();
vi.mock("../../finance/watchlist-seed.js", () => ({
  seedSymbol: (sym: string, opts?: unknown) => mockSeedSymbol(sym, opts),
  formatSeedResult: (r: {
    symbol: string;
    skipped: boolean;
    barsInserted: number;
    signalsInserted: number;
    error?: string;
  }) =>
    r.error
      ? `  ${r.symbol}: seed error — ${r.error}`
      : r.skipped
        ? `  ${r.symbol}: skipped`
        : `  ${r.symbol}: +${r.barsInserted} bars, +${r.signalsInserted} signals`,
  WATCHLIST_SEED_DEFAULTS: { minBars: 300, lookback: 520 },
}));

vi.mock("../../finance/budget.js", () => ({
  budgetSummary: () => [],
}));

vi.mock("../../finance/rate-limit.js", () => ({
  currentWindow: () => ({}),
  ceilings: () => ({}),
}));

const mockPersistSignals = vi.fn<(sigs: unknown[]) => number>(() => 0);
vi.mock("../../finance/signals.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../finance/signals.js")
  >("../../finance/signals.js");
  return {
    ...actual,
    persistSignals: (sigs: unknown[]) => mockPersistSignals(sigs),
  };
});

// Mock prediction-markets + sentiment modules so tool tests don't hit live endpoints.
const mockAdapter = {
  fetchActiveMarkets: vi.fn(),
  fetchEventGroup: vi.fn(),
  fetchMarketBySlug: vi.fn(),
  fetchRecentTrades: vi.fn(),
};
vi.mock("../../finance/prediction-markets.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../finance/prediction-markets.js")
  >("../../finance/prediction-markets.js");
  return {
    ...actual,
    PolymarketAdapter: {
      create: () => mockAdapter,
    },
    persistMarkets: vi.fn(() => 0),
  };
});

const mockQueryWhales = vi.fn<(opts?: unknown) => unknown[]>(() => []);
vi.mock("../../finance/whales.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../finance/whales.js")
  >("../../finance/whales.js");
  return {
    ...actual,
    queryRecentWhales: (opts?: unknown) => mockQueryWhales(opts),
    persistWhaleTrades: () => 0,
  };
});

const mockGetSentimentSnapshot = vi.fn();
vi.mock("../../finance/sentiment.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../finance/sentiment.js")
  >("../../finance/sentiment.js");
  return {
    ...actual,
    getSentimentSnapshot: () => mockGetSentimentSnapshot(),
  };
});

import {
  marketQuoteTool,
  marketHistoryTool,
  marketIndicatorsTool,
  marketScanTool,
  macroRegimeTool,
  marketSignalsTool,
  predictionMarketsTool,
  whaleTradesTool,
  sentimentSnapshotTool,
  marketWatchlistAddTool,
  marketWatchlistReseedTool,
  marketWatchlistListTool,
  marketWatchlistRemoveTool,
  marketBudgetStatsTool,
} from "./market.js";
import type { MarketBar, MacroPoint } from "../../finance/types.js";
import { RateLimitedError } from "../../finance/types.js";

/**
 * A failure is one JSON object whose first key is `error`, with nothing
 * before the opening brace: the registry and the fast runner read the start
 * of the text to decide that a call failed. Returns the error words.
 */
function errorWords(out: string): string {
  expect(out.startsWith('{"error":')).toBe(true);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  expect(Object.keys(parsed)[0]).toBe("error");
  expect(typeof parsed.error).toBe("string");
  return parsed.error as string;
}

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

describe("marketQuoteTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the quote line as plain text on success", async () => {
    mockLayer.getQuote.mockResolvedValue(makeBars("SPY", 1)[0]);
    const out = (await marketQuoteTool.execute({ symbol: "spy" })) as string;
    expect(mockLayer.getQuote).toHaveBeenCalledWith("SPY");
    expect(out.startsWith("SPY: $")).toBe(true);
  });

  it("reports a data-layer failure as an error object, Spanish words kept", async () => {
    mockLayer.getQuote.mockRejectedValue(new Error("both providers down"));
    const out = (await marketQuoteTool.execute({ symbol: "SPY" })) as string;
    expect(errorWords(out)).toBe(
      "No pude obtener cotización de SPY: both providers down",
    );
  });

  const quoteBar = (over: Partial<MarketBar> = {}): MarketBar => ({
    symbol: "SPY",
    timestamp: "2026-04-17T16:00:00-04:00",
    open: 521.5,
    high: 524.2,
    low: 520.1,
    close: 523.45,
    volume: 900,
    provider: "alpha_vantage",
    interval: "daily",
    ...over,
  });
  const quoteOf = async (bar: MarketBar) => {
    mockLayer.getQuote.mockResolvedValue(bar);
    return (await marketQuoteTool.execute({ symbol: bar.symbol })) as string;
  };

  it("prints change percent and previous close when the source gave both", async () => {
    const out = await quoteOf(
      quoteBar({ previousClose: 521.05, changePercent: 0.4605 }),
    );
    expect(out).toBe(
      "SPY: $523.45 · change +0.46% · prev close $521.05 (OHLC 2026-04-17: O 521.50 · H 524.20 · L 520.10) · vol 900 · source: alpha_vantage",
    );
  });

  it("prints neither part, and no placeholder, when the source gave neither", async () => {
    const out = await quoteOf(quoteBar());
    expect(out).toBe(
      "SPY: $523.45 (OHLC 2026-04-17: O 521.50 · H 524.20 · L 520.10) · vol 900 · source: alpha_vantage",
    );
  });

  it("prints only the part the source gave", async () => {
    expect(await quoteOf(quoteBar({ changePercent: -1.2 }))).toBe(
      "SPY: $523.45 · change -1.20% (OHLC 2026-04-17: O 521.50 · H 524.20 · L 520.10) · vol 900 · source: alpha_vantage",
    );
    expect(await quoteOf(quoteBar({ previousClose: 530 }))).toBe(
      "SPY: $523.45 · prev close $530.00 (OHLC 2026-04-17: O 521.50 · H 524.20 · L 520.10) · vol 900 · source: alpha_vantage",
    );
  });

  it("a zero change prints with a plus sign and two decimals", async () => {
    const out = await quoteOf(quoteBar({ changePercent: 0 }));
    expect(out).toContain(" · change +0.00% (OHLC ");
  });

  it("a negative change that rounds to zero prints +0.00%, never -0.00%", async () => {
    const out = await quoteOf(quoteBar({ changePercent: -0.004 }));
    expect(out).toBe(
      "SPY: $523.45 · change +0.00% (OHLC 2026-04-17: O 521.50 · H 524.20 · L 520.10) · vol 900 · source: alpha_vantage",
    );
  });

  it("the OHLC label is the source's trading day, an earlier session too, with no time part", async () => {
    const out = await quoteOf(
      quoteBar({ timestamp: "2026-04-10T16:00:00-04:00" }),
    );
    expect(out.startsWith("SPY: $")).toBe(true);
    expect(out).toContain("(OHLC 2026-04-10: O 521.50");
    expect(out).not.toContain("today");
    expect(out).not.toContain("@");
    expect(out).not.toContain("16:00");
  });

  it("a quote without a readable price is an error object, not a NaN price", async () => {
    const out = await quoteOf(quoteBar({ close: Number.NaN }));
    expect(errorWords(out)).toBe(
      "market_quote: la fuente no dio precio para SPY",
    );
  });
});

describe("marketHistoryTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("its description names Polygon as the primary source and Alpha Vantage as the fallback, each once", () => {
    const description = marketHistoryTool.definition.function.description;
    const source = "Source: Polygon primary, Alpha Vantage fallback. Stored in NY market time.";
    expect(description.split(source).length - 1).toBe(1);
    expect(description).not.toContain("Alpha Vantage primary");
    expect(description.split("Alpha Vantage").length - 1).toBe(1);
    expect(description.split("Polygon").length - 1).toBe(1);
  });

  it("returns the bar table as plain text on success", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: makeBars("SPY", 3),
      provider: "alpha_vantage",
    });
    const out = (await marketHistoryTool.execute({ symbol: "SPY" })) as string;
    expect(out.startsWith("SPY — 3 bars (daily) · source: alpha_vantage")).toBe(
      true,
    );
  });

  it("reports a data-layer failure as an error object, Spanish words kept", async () => {
    mockLayer.getDaily.mockRejectedValue(new Error("both providers down"));
    const out = (await marketHistoryTool.execute({ symbol: "SPY" })) as string;
    expect(errorWords(out)).toBe(
      "No pude obtener historial de SPY (daily): both providers down",
    );
  });

  it("pins the stale-rows header label", async () => {
    const bars = makeBars("SPY", 1);
    mockLayer.getDaily.mockResolvedValue({
      bars,
      provider: bars[0].provider,
      stale: true,
    });
    const out = (await marketHistoryTool.execute({ symbol: "SPY" })) as string;
    expect(out).toContain(" · STALE (providers unreachable)");
  });
});

describe("marketIndicatorsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a data-layer failure as an error object, Spanish words kept", async () => {
    mockLayer.getDaily.mockRejectedValue(new Error("both providers down"));
    const out = (await marketIndicatorsTool.execute({
      symbol: "SPY",
    })) as string;
    expect(errorWords(out)).toBe(
      "No pude calcular indicadores de SPY: both providers down",
    );
  });

  it("returns zero bars from the provider as a plain result, not an error", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: [],
      provider: "alpha_vantage",
    });
    const out = (await marketIndicatorsTool.execute({
      symbol: "SPY",
    })) as string;
    expect(out).toBe("SPY: no data available for daily.");
  });

  it("computes the default daily indicator set (no VWAP)", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: makeBars("SPY", 60),
      provider: "alpha_vantage",
    });
    const result = await marketIndicatorsTool.execute({ symbol: "SPY" });
    const text = result as string;
    // Default includes these 8 (VWAP excluded on daily per audit W3/W6)
    expect(text.startsWith("SPY (daily, 60 bars)")).toBe(true);
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

describe("macroRegimeTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function flatMacro(series: string, value: number, n = 10): MacroPoint[] {
    return Array.from({ length: n }, (_, i) => ({
      series,
      date: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`,
      value,
      provider: "fred" as const,
    }));
  }

  it("fetches 8 macro series and formats a regime summary", async () => {
    // Configure an expansion scenario: positive yield curve, falling unemployment, low VIX
    mockLayer.getMacro.mockImplementation(async (series: string) => {
      switch (series) {
        case "TREASURY_10Y":
          return flatMacro("T10", 4.5);
        case "TREASURY_2Y":
          return flatMacro("T2", 3.0);
        case "UNEMPLOYMENT":
          return Array.from({ length: 10 }, (_, i) => ({
            series: "UE",
            date: `2025-${String(i + 1).padStart(2, "0")}-01`,
            value: 5.0 - i * 0.1,
            provider: "fred" as const,
          }));
        case "VIXCLS":
          return flatMacro("VIX", 15);
        case "FEDFUNDS":
          return flatMacro("FF", 4.25);
        case "CPI":
          return flatMacro("CPI", 300);
        case "M2SL":
          return flatMacro("M2", 20_000);
        case "ICSA":
          return flatMacro("ICSA", 210_000);
        default:
          return [];
      }
    });
    const out = (await macroRegimeTool.execute({})) as string;
    expect(out).toMatch(/Regime: expansion/);
    expect(out).toContain("Yield curve");
    expect(out).toContain("VIX");
    expect(out).toContain("Fed funds");
    expect(mockLayer.getMacro).toHaveBeenCalledTimes(8);
  });

  it("tolerates adapter errors and returns mixed when all series unavailable", async () => {
    mockLayer.getMacro.mockRejectedValue(new Error("FRED down"));
    const out = (await macroRegimeTool.execute({})) as string;
    expect(out).toMatch(/Regime: mixed/);
  });
});

describe("marketSignalsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistSignals.mockReturnValue(0);
  });

  it("returns no-signals message on a synthetic quiet series", async () => {
    // 100 ultra-quiet bars (flat close + flat volume) → no detectors fire
    const quiet = Array.from({ length: 100 }, (_, i) => ({
      symbol: "QUIET",
      timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 1_000_000,
      provider: "alpha_vantage" as const,
      interval: "daily" as const,
    }));
    mockLayer.getDaily.mockResolvedValue({
      bars: quiet,
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({
      symbol: "QUIET",
    })) as string;
    expect(out).toMatch(/No signals fired/);
  });

  it("detects and lists firings on a volatile series", async () => {
    // Build a series that triggers rsi_extreme and volume_spike
    const bars = Array.from({ length: 100 }, (_, i) => {
      const close =
        i < 50
          ? 100 - i * 0.8 // falling to ~60 → oversold RSI
          : 60 + (i - 50) * 0.5;
      return {
        symbol: "SPY",
        timestamp: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
        open: close - 0.3,
        high: close + 0.5,
        low: close - 0.5,
        close,
        volume: 1_000_000 + (i === 49 ? 20_000_000 : (i % 5) * 50_000),
        provider: "alpha_vantage" as const,
        interval: "daily" as const,
      };
    });
    mockLayer.getDaily.mockResolvedValue({
      bars,
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({ symbol: "SPY" })) as string;
    expect(out).toContain("SPY");
    expect(out).toMatch(/signals:/);
    expect(mockPersistSignals).toHaveBeenCalled();
  });

  it("scans watchlist when no symbol passed", async () => {
    mockLayer.listWatchlist.mockReturnValue([
      {
        symbol: "A",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
      {
        symbol: "B",
        assetClass: "equity",
        tags: [],
        active: true,
        addedAt: "x",
      },
    ]);
    mockLayer.getDaily.mockResolvedValue({
      bars: Array.from({ length: 100 }, (_, i) => ({
        symbol: "A",
        timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
        open: 100,
        high: 100.1,
        low: 99.9,
        close: 100,
        volume: 1_000_000,
        provider: "alpha_vantage" as const,
        interval: "daily" as const,
      })),
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({})) as string;
    expect(out).toContain("scanned 2 symbols");
  });

  it("handles empty watchlist gracefully", async () => {
    mockLayer.listWatchlist.mockReturnValue([]);
    const out = (await marketSignalsTool.execute({})) as string;
    expect(out).toMatch(/watchlist is empty/);
  });

  it("reports insufficient-bars skip", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: Array.from({ length: 30 }, (_, i) => ({
        symbol: "NEW",
        timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T16:00:00-04:00`,
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1_000_000,
        provider: "alpha_vantage" as const,
        interval: "daily" as const,
      })),
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({ symbol: "NEW" })) as string;
    expect(out).toContain("Skipped");
    expect(out).toContain("insufficient bars");
  });

  it("filters detector types when types[] provided", async () => {
    const bars = Array.from({ length: 100 }, (_, i) => ({
      symbol: "TEST",
      timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T16:00:00-04:00`,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 1_000_000,
      provider: "alpha_vantage" as const,
      interval: "daily" as const,
    }));
    mockLayer.getDaily.mockResolvedValue({
      bars,
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({
      symbol: "TEST",
      types: ["volume_spike"],
    })) as string;
    // Even if nothing fires, the header should still appear
    expect(out).toContain("scanned 1 symbols");
  });
});

describe("marketSignalsTool — newest bar line", () => {
  /** `n` flat daily bars, one per calendar day, ascending, the last on `lastDay`. */
  function dailyUpTo(
    symbol: string,
    n: number,
    lastDay: string,
    lastClose = 100,
  ): MarketBar[] {
    const end = Date.parse(`${lastDay}T00:00:00Z`);
    return Array.from({ length: n }, (_, i) => {
      const day = new Date(end - (n - 1 - i) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const close = i === n - 1 ? lastClose : 100;
      return {
        symbol,
        timestamp: `${day}T16:00:00-05:00`,
        open: close,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 500,
        provider: "alpha_vantage" as const,
        interval: "daily" as const,
      };
    });
  }
  const entry = (symbol: string) => ({
    symbol,
    assetClass: "equity",
    tags: [],
    active: true,
    addedAt: "x",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistSignals.mockReturnValue(0);
  });

  it("names every scanned symbol once, in scan order, at line 2; nothing else in the reply moves", async () => {
    const symbols = ["FRESH", "OLD", "THIN", "ERR", "RL1", "RL2", "RL3", "LATE"];
    mockLayer.listWatchlist.mockReturnValue(symbols.map(entry));
    mockLayer.getDaily.mockImplementation(async (symbol: string) => {
      switch (symbol) {
        case "FRESH": // fetched on this call; its last close crosses 105
          return {
            bars: dailyUpTo("FRESH", 60, "2026-03-01", 106),
            provider: "alpha_vantage",
          };
        case "OLD": // no provider answered: the stored fallback, enough rows
          return {
            bars: dailyUpTo("OLD", 60, "2026-02-27"),
            provider: "alpha_vantage",
            stale: true,
          };
        case "THIN": // the stored fallback, too few rows to scan
          return {
            bars: dailyUpTo("THIN", 30, "2026-01-30"),
            provider: "alpha_vantage",
            stale: true,
          };
        case "ERR":
          throw new Error("provider down");
        default: // RL1..RL3 abort the scan; LATE is never fetched
          throw new RateLimitedError("alpha_vantage");
      }
    });

    const out = (await marketSignalsTool.execute({
      types: ["price_threshold"],
      price_thresholds: [105],
    })) as string;

    expect(out).toBe(
      [
        "market_signals: scanned 8 symbols · 0 new firings persisted",
        "  Newest bar: FRESH 2026-03-01, OLD 2026-02-27 (fallback), THIN 2026-01-30 (fallback), ERR none, RL1 none, RL2 none, RL3 none, LATE none",
        "",
        "FRESH — 1 signals:",
        "  2026-03-01T16:00:00-05:00 | price_threshold | long    | Price crossed threshold 105 (100.00 → 106.00)",
        "",
        "Skipped (6):",
        "  THIN: insufficient bars",
        "  ERR: provider down",
        "  RL1: Rate limited by alpha_vantage",
        "  RL2: Rate limited by alpha_vantage",
        "  RL3: Rate limited by alpha_vantage",
        "  ... and 1 more",
      ].join("\n"),
    );
    expect(mockLayer.getDaily).not.toHaveBeenCalledWith(
      "LATE",
      expect.anything(),
    );
  });

  it("a fetched symbol with no firing shows its date unmarked, before the no-signals line", async () => {
    mockLayer.getDaily.mockResolvedValue({
      bars: dailyUpTo("QUIET", 60, "2026-03-01"),
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({
      symbol: "QUIET",
    })) as string;
    expect(out).toBe(
      [
        "market_signals: scanned 1 symbols · 0 new firings persisted",
        "  Newest bar: QUIET 2026-03-01",
        "  No signals fired.",
      ].join("\n"),
    );
  });

  it("the 60-minute interval prints the date with hour and minute", async () => {
    const end = Date.parse("2026-03-02T20:00:00Z");
    const bars = Array.from({ length: 50 }, (_, i) => ({
      symbol: "SPY",
      timestamp: new Date(end - (49 - i) * 3_600_000).toISOString(),
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 500,
      provider: "alpha_vantage" as const,
      interval: "60min" as const,
    }));
    mockLayer.getIntraday.mockResolvedValue({
      bars,
      provider: "alpha_vantage",
    });
    const out = (await marketSignalsTool.execute({
      symbol: "SPY",
      interval: "60min",
      types: ["price_threshold"],
      price_thresholds: [105],
    })) as string;
    expect(mockLayer.getIntraday).toHaveBeenCalledWith("SPY", "60min", {
      lookback: 100,
    });
    expect(out).toBe(
      [
        "market_signals: scanned 1 symbols · 0 new firings persisted",
        "  Newest bar: SPY 2026-03-02T20:00",
        "  No signals fired.",
      ].join("\n"),
    );
  });
});

describe("predictionMarketsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.fetchActiveMarkets.mockReset();
    mockAdapter.fetchEventGroup.mockReset();
  });

  it("lists active markets and filters by query substring", async () => {
    mockAdapter.fetchActiveMarkets.mockResolvedValue([
      {
        source: "polymarket",
        marketId: "m1",
        question: "Will BTC hit $100k by 2026-12-31?",
        category: "Crypto",
        outcomes: [
          { id: "y", label: "Yes", price: 0.18 },
          { id: "n", label: "No", price: 0.82 },
        ],
        volumeUsd: 15_000_000,
        isNegRisk: false,
      },
      {
        source: "polymarket",
        marketId: "m2",
        question: "2028 US Election — Democrat wins?",
        outcomes: [],
        isNegRisk: true,
      },
    ]);
    const out = (await predictionMarketsTool.execute({
      query: "btc",
    })) as string;
    expect(out.startsWith("Polymarket — 1 active markets")).toBe(true);
    expect(out).toMatch(/BTC/);
    expect(out).not.toMatch(/Election/);
  });

  it("returns event group when event_id is provided", async () => {
    mockAdapter.fetchEventGroup.mockResolvedValue([
      {
        source: "polymarket",
        marketId: "a",
        question: "Candidate A?",
        outcomes: [],
        isNegRisk: true,
        eventId: "100",
      },
      {
        source: "polymarket",
        marketId: "b",
        question: "Candidate B?",
        outcomes: [],
        isNegRisk: true,
        eventId: "100",
      },
    ]);
    const out = (await predictionMarketsTool.execute({
      event_id: "100",
    })) as string;
    expect(mockAdapter.fetchEventGroup).toHaveBeenCalledWith("100");
    expect(out).toContain("event 100");
    expect(out).toContain("negRisk grouping: yes");
  });

  it("surfaces empty-result message", async () => {
    mockAdapter.fetchActiveMarkets.mockResolvedValue([]);
    const out = (await predictionMarketsTool.execute({
      query: "nothing",
    })) as string;
    expect(out).toMatch(/no markets matched/);
  });

  it("reports an adapter failure as an error object", async () => {
    mockAdapter.fetchActiveMarkets.mockRejectedValue(
      new Error("Polymarket 503"),
    );
    const out = (await predictionMarketsTool.execute({})) as string;
    expect(errorWords(out)).toBe("prediction_markets: Polymarket 503");
  });
});

describe("whaleTradesTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryWhales.mockReset();
  });

  it("defaults to last 24h and $5k threshold", async () => {
    mockQueryWhales.mockReturnValue([]);
    await whaleTradesTool.execute({});
    const opts = mockQueryWhales.mock.calls[0]?.[0] as {
      hours?: number;
      minSizeUsd?: number;
      limit?: number;
    };
    expect(opts.hours).toBe(24);
    expect(opts.minSizeUsd).toBe(5000);
  });

  it("formats returned rows sorted by size descending", async () => {
    mockQueryWhales.mockReturnValue([
      {
        source: "polymarket",
        wallet: "0xAAAAAA",
        marketId: "mkt-A",
        side: "buy",
        sizeUsd: 42_500,
        price: 0.45,
        occurredAt: "2026-04-17T14:20:00Z",
      },
      {
        source: "polymarket",
        wallet: "0xBBBBBB",
        marketId: "mkt-A",
        side: "sell",
        sizeUsd: 12_000,
        price: 0.55,
        occurredAt: "2026-04-17T10:10:00Z",
      },
    ]);
    const out = (await whaleTradesTool.execute({})) as string;
    // 42,500 must appear before 12,000 in output (sorted desc)
    const bigIdx = out.indexOf("42,500");
    const smallIdx = out.indexOf("12,000");
    expect(bigIdx).toBeGreaterThan(-1);
    expect(smallIdx).toBeGreaterThan(-1);
    expect(bigIdx).toBeLessThan(smallIdx);
  });

  it("no-rows fallback suggests fetch_live", async () => {
    mockQueryWhales.mockReturnValue([]);
    const out = (await whaleTradesTool.execute({
      market_id: "unseen",
    })) as string;
    expect(out).toMatch(/no whale activity/);
    expect(out).toMatch(/fetch_live=true/);
  });
});

describe("sentimentSnapshotTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSentimentSnapshot.mockReset();
  });

  it("formats full snapshot with F&G + funding + interpretation", async () => {
    mockGetSentimentSnapshot.mockResolvedValue({
      fearGreed: {
        value: 67,
        classification: "Greed",
        sources: [
          { source: "alternative_me", value: 72, classification: "Greed" },
          { source: "cmc_fng", value: 62, classification: "Greed" },
        ],
      },
      fundingRates: [
        { symbol: "BTCUSDT", rate: 0.0001, annualizedPct: 10.95 },
        { symbol: "ETHUSDT", rate: 0.00008, annualizedPct: 8.76 },
        { symbol: "SOLUSDT", rate: 0.00015, annualizedPct: 16.43 },
      ],
      interpretation: "crowd greedy; funding positive",
      degradedSources: [],
    });
    const out = (await sentimentSnapshotTool.execute({})) as string;
    expect(out.startsWith("Fear & Greed: 67")).toBe(true);
    expect(out).toContain("Greed");
    expect(out).toContain("BTC");
    expect(out).toContain("Interpretation");
  });

  it("reports fear & greed unavailable when both sources down", async () => {
    mockGetSentimentSnapshot.mockResolvedValue({
      fearGreed: null,
      fundingRates: [],
      interpretation: "no sentiment data available",
      degradedSources: ["alternative_me: 500", "coinmarketcap: 503"],
    });
    const out = (await sentimentSnapshotTool.execute({})) as string;
    expect(out).toMatch(/Fear & Greed: \(unavailable/);
    expect(out).toMatch(/Funding: \(unavailable/);
    expect(out).toMatch(/Degraded: 2 source/);
  });

  it("reports a thrown snapshot failure as an error object", async () => {
    mockGetSentimentSnapshot.mockRejectedValue(new Error("catastrophe"));
    const out = (await sentimentSnapshotTool.execute({})) as string;
    expect(errorWords(out)).toBe("sentiment_snapshot: catastrophe");
  });
});

describe("marketWatchlistAddTool", () => {
  beforeEach(() => {
    mockLayer.addToWatchlist.mockReset();
    mockSeedSymbol.mockReset();
  });

  it("adds the row then auto-seeds weekly bars + signals", async () => {
    mockLayer.addToWatchlist.mockReturnValue({
      symbol: "NVDA",
      assetClass: "equity",
      tags: ["semi", "ai"],
      active: true,
      addedAt: "2026-04-18",
    });
    mockSeedSymbol.mockResolvedValue({
      symbol: "NVDA",
      skipped: false,
      barsBefore: 0,
      barsAfter: 520,
      barsInserted: 520,
      signalsInserted: 187,
    });
    const out = (await marketWatchlistAddTool.execute({
      symbol: "NVDA",
      asset_class: "equity",
      tags: ["semi", "ai"],
    })) as string;
    expect(out).toBe(
      "OK: added NVDA (equity) [semi, ai]\nseed: +520 weekly bars, +187 signals",
    );
    expect(mockSeedSymbol).toHaveBeenCalledWith("NVDA", { minBars: 300 });
  });

  it("skips seeding for macro asset class", async () => {
    mockLayer.addToWatchlist.mockReturnValue({
      symbol: "FEDFUNDS",
      assetClass: "macro",
      tags: [],
      active: true,
      addedAt: "2026-04-18",
    });
    const out = (await marketWatchlistAddTool.execute({
      symbol: "FEDFUNDS",
      asset_class: "macro",
    })) as string;
    expect(out).toMatch(/OK: added FEDFUNDS/);
    expect(out).not.toMatch(/seed:/);
    expect(mockSeedSymbol).not.toHaveBeenCalled();
  });

  it("surfaces seed errors without rolling back the watchlist row", async () => {
    mockLayer.addToWatchlist.mockReturnValue({
      symbol: "XYZ",
      assetClass: "equity",
      tags: [],
      active: true,
      addedAt: "2026-04-18",
    });
    mockSeedSymbol.mockResolvedValue({
      symbol: "XYZ",
      skipped: false,
      barsBefore: 0,
      barsAfter: 0,
      barsInserted: 0,
      signalsInserted: 0,
      error: "Rate limited by alpha_vantage",
    });
    const out = (await marketWatchlistAddTool.execute({
      symbol: "XYZ",
      asset_class: "equity",
    })) as string;
    // The requested write happened, so this is a result, not a failure:
    // the head and the words stay plain text.
    expect(out).toBe(
      "OK: added XYZ (equity)\nseed: Rate limited by alpha_vantage (bars 0 → 0). Retry with market_watchlist_reseed.",
    );
  });

  it("reports a failed watchlist write as an error object without the upper-case marker", async () => {
    mockLayer.addToWatchlist.mockImplementation(() => {
      throw new Error("invalid symbol");
    });
    const out = (await marketWatchlistAddTool.execute({
      symbol: "BAD",
      asset_class: "equity",
    })) as string;
    expect(errorWords(out)).toBe("could not add — invalid symbol");
    expect(mockSeedSymbol).not.toHaveBeenCalled();
  });

  it("reports the skip reason when history is already sufficient", async () => {
    mockLayer.addToWatchlist.mockReturnValue({
      symbol: "SPY",
      assetClass: "etf",
      tags: [],
      active: true,
      addedAt: "2026-04-18",
    });
    mockSeedSymbol.mockResolvedValue({
      symbol: "SPY",
      skipped: true,
      barsBefore: 500,
      barsAfter: 500,
      barsInserted: 0,
      signalsInserted: 0,
    });
    const out = (await marketWatchlistAddTool.execute({
      symbol: "SPY",
      asset_class: "etf",
    })) as string;
    expect(out).toMatch(/500 weekly bars already present/);
  });
});

describe("marketWatchlistReseedTool", () => {
  beforeEach(() => {
    mockSeedSymbol.mockReset();
  });

  it("rejects an empty symbol with an error object", async () => {
    const out = (await marketWatchlistReseedTool.execute({})) as string;
    expect(errorWords(out)).toBe("market_watchlist_reseed: symbol is required");
    expect(mockSeedSymbol).not.toHaveBeenCalled();
  });

  it("reports a reseed whose seed failed as an error object carrying the formatted seed result", async () => {
    mockSeedSymbol.mockResolvedValue({
      symbol: "XYZ",
      skipped: false,
      barsBefore: 0,
      barsAfter: 0,
      barsInserted: 0,
      signalsInserted: 0,
      error: "Rate limited by alpha_vantage",
    });
    const out = (await marketWatchlistReseedTool.execute({
      symbol: "XYZ",
    })) as string;
    expect(errorWords(out)).toBe(
      "market_watchlist_reseed:\n  XYZ: seed error — Rate limited by alpha_vantage",
    );
  });

  it("forwards min_bars override to seedSymbol", async () => {
    mockSeedSymbol.mockResolvedValue({
      symbol: "TSLA",
      skipped: false,
      barsBefore: 0,
      barsAfter: 200,
      barsInserted: 200,
      signalsInserted: 34,
    });
    await marketWatchlistReseedTool.execute({ symbol: "TSLA", min_bars: 150 });
    expect(mockSeedSymbol).toHaveBeenCalledWith("TSLA", { minBars: 150 });
  });

  it("formats the seed result for the operator", async () => {
    mockSeedSymbol.mockResolvedValue({
      symbol: "QQQ",
      skipped: true,
      barsBefore: 400,
      barsAfter: 400,
      barsInserted: 0,
      signalsInserted: 0,
    });
    const out = (await marketWatchlistReseedTool.execute({
      symbol: "QQQ",
    })) as string;
    expect(out).toBe("market_watchlist_reseed:\n  QQQ: skipped");
  });
});

// Description pins: each tool's whole description text as registered.
describe("tool description texts", () => {
  const prop = (tool: typeof marketHistoryTool, name: string): string =>
    (tool.definition.function.parameters as { properties: Record<string, { description: string }> })
      .properties[name].description;
  it("pins the whole market_history description", () => {
    expect(marketHistoryTool.definition.function.description).toBe(`Historical OHLCV bars for a ticker. Pre-formatted as a compact table.

USE WHEN:
- User asks for price history, chart, trend analysis
- Need data for follow-up reasoning (recent highs/lows, moving averages by eye)

Default: daily, 60 bars. Override interval for intraday (1/5/15/60 min) or lookback for longer history.

Source: Polygon primary, Alpha Vantage fallback. Stored in NY market time.

DO NOT USE WHEN:
- You want the current price or the day's change: this tool returns bars with no change or previous-close figure — use market_quote when it is among your tools.
- You want indicators computed: it computes none — use market_indicators when it is among your tools.
- You want weekly bars or more than 500 bars: the interval is daily or intraday only, and lookback stops at 500.
- You want a chart image: it returns text only.

Output: header + table of ≤lookback rows (date/time, O, H, L, C, V). A "STALE" notice in the header means the rows are stored rows returned because no data provider returned bars (daily interval only).`);
  });
  it("pins the whole market_signals description", () => {
    expect(marketSignalsTool.definition.function.description).toBe(`Detect recent technical signals on one symbol or the whole watchlist.

USE WHEN:
- User asks "any signals firing?", "what's triggering?", "show me crossovers/breakouts"
- Morning/EOD scan wants the recent signal list

Detectors (6): ma_crossover (golden/death cross), rsi_extreme (overbought/oversold),
macd_crossover (histogram sign change), bollinger_breakout (close outside bands),
volume_spike (z-score > 2σ), price_threshold (explicit user thresholds).

If 'symbol' is omitted, scans the active watchlist. Persists detected signals
to the market_signals DB table for F7 alpha-combination consumption.

DO NOT USE WHEN:
- You want current indicator values (an RSI level, a moving average): this tool lists detector firings, not an indicator table — use market_indicators when it is among your tools.
- You want firings stored by earlier scans: its reply shows what it detects in the bars this call gets, not rows read from the stored firings.
- You want weekly or minute bars: the interval is daily or 60min only, and a symbol with fewer than 40 bars is skipped.
- You need every firing in the window: the reply shows at most the last 10 per symbol.

Output: after the header, a "Newest bar:" line gives each scanned symbol's newest bar date, marked "(fallback)" when no provider answered and the bars are the stored fallback (the date tells their age), or "none" when no bars were at hand.`);
  });
  it("pins the whole market_watchlist_list description", () => {
    expect(marketWatchlistListTool.definition.function.description).toBe(`Show active watchlist grouped by asset_class.

USE WHEN: "muestra mi watchlist", "list watchlist", "what am I tracking".
DO NOT USE WHEN:
- You want prices or recent moves of the tickers: it reads the watchlist table only and fetches no market data.
- You want removed tickers: it lists active rows only; a removed ticker is not shown.
- You want how much price history is stored per ticker: it lists asset class, symbol, name, tags and notes, and nothing about stored price history.

Output: compact text table, no API calls.`);
  });
  it("pins the whole market_watchlist_remove description", () => {
    expect(marketWatchlistRemoveTool.definition.function.description).toBe(`Remove (deactivate) a ticker from the watchlist.

USE WHEN: "quita TSLA", "remove AAPL", "drop NVDA from watchlist".
Soft delete — row kept with active=0, can be re-added.

DO NOT USE WHEN:
- You want the ticker's stored prices or signals erased: it only marks the watchlist row inactive; stored bars and signals stay.
- You want to close a paper position in that ticker: it changes no paper position or trade.`);
  });
  it("pins the whole market_budget_stats description", () => {
    expect(marketBudgetStatsTool.definition.function.description).toBe(`API consumption stats for Alpha Vantage / Polygon / FRED.

USE WHEN: user asks about API usage, rate limits, budget status.
Output: last-60s window usage vs ceilings + daily quota usage (Alpha Vantage
free tier: 25 req/day) + last-hour summary.

DO NOT USE WHEN:
- You want the token budget of the market scan rituals: this tool counts market-data provider calls only — use alert_budget_status when it is among your tools.
- You want model token use or task cost: it reads no model or task figures.
- You want a limit raised or a counter reset: it raises no limit and resets no counter.`);
  });
  it("pins the whole macro_regime description", () => {
    expect(macroRegimeTool.definition.function.description).toBe(`Classify the current US macro regime from FRED + Alpha Vantage series.

USE WHEN:
- User asks about economic regime, recession risk, yield curve, inflation, fed policy
- Need macro context before interpreting market signals
- Morning briefing wants a regime snapshot

Regimes: expansion / tightening / recession_risk / recovery / mixed
Each classification includes: yield curve (10Y-2Y), fed funds, VIX, unemployment,
CPI YoY, M2 YoY, initial jobless claims, plus a reasons[] list and confidence (0..1).

DO NOT USE WHEN:
- You want the regime of a past date or of another country: it takes no arguments and classifies only the current US regime from its eight fixed series.
- You want an indicator's history (CPI over a year): it prints one current figure per indicator, not a time series.
- You want crowd or crypto sentiment: it reads macro series only — use sentiment_snapshot when it is among your tools.

Cost: one call pulls 8 macro series (FEDFUNDS + CPI + UNEMPLOYMENT + TREASURY_YIELD x2
via AV, VIXCLS + ICSA + M2SL via FRED). Cache-friendly on repeat queries via the
DataLayer macro cache (6-hour TTL).`);
  });
  it("pins the whole sentiment_snapshot description", () => {
    expect(sentimentSnapshotTool.definition.function.description).toBe(`Current crypto sentiment composite: Fear & Greed (2 sources) + funding rates.

USE WHEN:
- User asks about crypto market mood, crowd sentiment, fear/greed
- Morning briefing needs sentiment layer
- Checking crowd extremes before a trading decision (contrarian context)

Sources: alternative.me + CoinMarketCap (Fear & Greed 0-100), Binance premium
index (8h funding rate on BTC/ETH/SOL USDT perps).
Composite interpretation highlights contrarian signals at extremes.

No args — returns current snapshot with interpretation.

DO NOT USE WHEN:
- You want stock-market or single-stock sentiment: it reads only the crypto Fear & Greed indexes and the funding rates of three fixed perps (BTC, ETH, SOL); it takes no symbol.
- You want past readings or a trend: it shows one set of readings and no history.
- You want the odds of an event: it reads no prediction market — use prediction_markets when it is among your tools.`);
  });
  it("pins the whole whale_trades description", () => {
    expect(whaleTradesTool.definition.function.description).toBe(`Recent whale activity (≥$5k default) on Polymarket markets.

USE WHEN:
- User asks about smart-money flow, whale trades, large positions
- Need a smart-money signal alongside technical + macro layers
- Assessing conviction behind a specific market (use market_id filter)

Reads from the whale_trades table (F6 populates via Polymarket trade history).
Only a call with fetch_live=true and a market_id asks Polymarket for that market's recent trades and stores the whale trades found; without both, the call reads stored rows only.

DO NOT USE WHEN:
- You want the largest trades of the whole window: the limit keeps the most recent rows first, and only those are sorted by size.
- You want trades outside prediction markets (stocks, crypto transfers): it reads only the prediction-market trades its own live fetch stored.
- You want to place or copy a trade: it buys and sells nothing.

Default: last 24h, ≥$5,000 USD, 20 results. Output sorted by size descending.`);
  });
  it("pins the whole market_quote description", () => {
    expect(marketQuoteTool.definition.function.description).toBe(`Current price snapshot for a single ticker (last close, intraday high/low, volume).

USE WHEN:
- User asks "how is SPY?", "cotiza AAPL", "precio actual de NVDA"
- Need a one-shot quote, not a time series (for history use market_history)

Any other tool named in this description or its parameters is usable only when it is among your tools.

NOT WHEN:
- User wants historical bars (use market_history)
- User wants indicators/signals (use market_indicators / market_signals)

Source: Alpha Vantage GLOBAL_QUOTE. ~15-min delayed during US market hours.

Input: symbol (ticker). Examples: SPY, AAPL, TSLA, BRK.B.
Output: formatted single-line summary (symbol, price, change % and previous close when the source gives them, OHLC with its trading day, volume, source).`);
  });
  it("pins the whole market_watchlist_add description", () => {
    expect(marketWatchlistAddTool.definition.function.description).toBe(`Add a ticker to the operator's watchlist.

USE WHEN:
- User says "agrega TSLA a mi watchlist", "add AAPL", "trackea NVDA"
- New symbol is being introduced into rotation

NOT WHEN:
- User wants a one-shot quote (use market_quote when it is among your tools)
- User wants to rename/retag existing symbol (use add again — upserts)

Validation: symbol normalized to UPPERCASE; FX forced to 6-letter form (EURUSD);
rejects if projected daily API usage would exceed the Alpha Vantage tier ceiling.`);
  });
  it("pins the whole market_watchlist_reseed description", () => {
    expect(marketWatchlistReseedTool.definition.function.description).toBe(`Refresh a symbol's weekly history + signals. Idempotent —
skips if the symbol already has ≥300 weekly bars. Otherwise fetches via
DataLayer.getWeekly, persists bars, re-runs detectAllSignals, persists firings.

USE WHEN:
- A prior market_watchlist_add returned a seed error (provider down, rate limit)
- User explicitly asks to "refresh" or "re-seed" a symbol's history
- After a long gap where the daily quote seed is stale

NOT WHEN:
- User wants the current price (use market_quote when it is among your tools)
- User wants indicators (use market_indicators when it is among your tools)

Output: one line with bars inserted + signals inserted, or skip reason.`);
  });
  it("pins the whole market_indicators description", () => {
    expect(marketIndicatorsTool.definition.function.description).toBe(`Compute technical indicators over a symbol's recent price history.

USE WHEN:
- User asks for RSI, MACD, moving averages, Bollinger bands, or similar quant signals
- Need quick overbought/oversold / trend / momentum read on a ticker

NOT WHEN:
- User wants to scan the watchlist for symbols matching a condition (use market_scan when it is among your tools)
- User wants raw historical bars (use market_history when it is among your tools)

Output: pre-formatted summary of latest indicator values. Default interval=daily, lookback=100 bars, all 9 indicators.

VWAP is meaningful on intraday intervals (1min/5min/15min/60min); on daily bars it returns a cumulative value that is not the intraday-VWAP convention.`);
  });
  it("pins the whole market_scan description", () => {
    expect(marketScanTool.definition.function.description).toBe(`Scan the active watchlist for symbols matching an indicator threshold.

USE WHEN:
- User asks to find symbols meeting a condition (e.g., "what's oversold today?", "find symbols with RSI < 30", "which are above their 50-day SMA?")

NOT WHEN:
- User wants indicators on one specific symbol (use market_indicators when it is among your tools)
- User wants to add/remove symbols from the watchlist (use market_watchlist_{add,remove,list} when the one you need is among your tools)

The scan iterates the active watchlist, computes one indicator per symbol over recent bars, and filters by the operator+threshold. Cache-friendly: warm scans (after a morning data pull) cost zero API calls.

Output: pre-formatted match list with cache-hit summary.`);
  });
  it("pins the whole prediction_markets description", () => {
    expect(predictionMarketsTool.definition.function.description).toBe(`List / search active Polymarket prediction markets.

USE WHEN:
- User asks about Polymarket odds, binary markets, election markets,
  sports betting markets, crowd-pricing on an outcome
- Morning briefing includes crowd signal layer
- Event grouping needed (e.g. "US election markets" across candidates)

NOT WHEN:
- User wants to place a trade (Phase δ F11 territory — not in v7.0)
- User wants whale-trade activity (use whale_trades when it is among your tools)

Source: Polymarket Gamma API (public, no auth). Results include multi-outcome
event grouping (negRisk flag) and outcome prices (0..1 probability).

Cost: 1 Polymarket call per invocation (cached). Auto-persists metadata to
prediction_markets table for F7 alpha-combination consumption.`);
  });
  it("pins the market_history symbol parameter text", () => {
    expect(prop(marketHistoryTool, "symbol")).toBe(`Ticker. Equity/ETF: SPY.`);
  });
  it("pins the market_history lookback parameter text", () => {
    expect(prop(marketHistoryTool, "lookback")).toBe(`Number of bars requested. Default 60; a number is rounded and kept between 1 and 500. Fewer rows can come back.`);
  });
  it("pins the market_history interval parameter text", () => {
    expect(prop(marketHistoryTool, "interval")).toBe(`Bar interval. Default 'daily'. Use intraday only for recent-day analysis.`);
  });
  it("pins the whale_trades fetch_live parameter text", () => {
    expect(prop(whaleTradesTool, "fetch_live")).toBe(`If true AND market_id provided, hit Polymarket CLOB live and persist the whale trades found before querying. Default false (DB-only).`);
  });
});
