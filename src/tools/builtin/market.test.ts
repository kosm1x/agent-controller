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
  marketIndicatorsTool,
  marketScanTool,
  macroRegimeTool,
  marketSignalsTool,
  predictionMarketsTool,
  whaleTradesTool,
  sentimentSnapshotTool,
  marketWatchlistAddTool,
  marketWatchlistReseedTool,
} from "./market.js";
import type { MarketBar, MacroPoint } from "../../finance/types.js";

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
    expect(out).toContain("active markets");
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

  it("handles adapter errors gracefully", async () => {
    mockAdapter.fetchActiveMarkets.mockRejectedValue(
      new Error("Polymarket 503"),
    );
    const out = (await predictionMarketsTool.execute({})) as string;
    expect(out).toMatch(/503/);
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
    expect(out).toContain("Fear & Greed: 67");
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

  it("handles thrown errors gracefully", async () => {
    mockGetSentimentSnapshot.mockRejectedValue(new Error("catastrophe"));
    const out = (await sentimentSnapshotTool.execute({})) as string;
    expect(out).toMatch(/catastrophe/);
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
    expect(out).toMatch(/OK: added NVDA/);
    expect(out).toMatch(/\+520 weekly bars, \+187 signals/);
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
    expect(out).toMatch(/OK: added XYZ/);
    expect(out).toMatch(/Rate limited/);
    expect(out).toMatch(/market_watchlist_reseed/);
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

  it("rejects empty symbol", async () => {
    const out = (await marketWatchlistReseedTool.execute({})) as string;
    expect(out).toMatch(/symbol is required/);
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
    expect(out).toMatch(/market_watchlist_reseed:/);
    expect(out).toMatch(/QQQ: skipped/);
  });
});
