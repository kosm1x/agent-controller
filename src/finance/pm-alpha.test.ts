import { describe, expect, it } from "vitest";
import { PM_ALPHA_DEFAULTS, runPmAlpha } from "./pm-alpha.js";
import type { PredictionMarket } from "./prediction-markets.js";
import type { SentimentReading } from "./sentiment.js";
import type { WhaleTrade } from "./whales.js";

function mkMarket(overrides: Partial<PredictionMarket> = {}): PredictionMarket {
  return {
    source: "polymarket",
    marketId: "0xabc",
    slug: "test-market",
    question: "Will BTC reach $200K by summer?",
    resolutionDate: "2026-07-15T00:00:00Z", // ~86 days from ASOF → inside 180d window
    outcomes: [
      { id: "tk-yes", label: "Yes", price: 0.4 },
      { id: "tk-no", label: "No", price: 0.6 },
    ],
    liquidityUsd: 50_000,
    volumeUsd: 100_000,
    isNegRisk: false,
    ...overrides,
  };
}

const ASOF = "2026-04-20T16:00:00Z";

describe("runPmAlpha — basic math", () => {
  it("returns empty-result when markets is empty", () => {
    const result = runPmAlpha({
      markets: [],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.nMarkets).toBe(0);
    expect(result.nActive).toBe(0);
    expect(result.totalExposure).toBe(0);
    expect(result.tokens).toEqual([]);
  });

  it("no sentiment + no whales + non-crypto question → edge=0 → weight=0", () => {
    const m = mkMarket({ question: "Russia-Ukraine Ceasefire by 2026?" });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens.length).toBe(2);
    for (const t of result.tokens) {
      expect(t.excluded).toBe(false);
      expect(t.edge).toBeCloseTo(0, 12);
      expect(t.weight).toBeCloseTo(0, 12);
    }
    expect(result.totalExposure).toBeCloseTo(0, 12);
  });

  it("crypto-UP market + extreme fear → positive tilt on YES, negative on NO", () => {
    const m = mkMarket({
      question: "Will BTC hit $200K ATH by Dec?",
      outcomes: [
        { id: "yes", label: "Yes", price: 0.4 },
        { id: "no", label: "No", price: 0.6 },
      ],
    });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 20, // extreme fear < 25
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    const yes = result.tokens.find((t) => t.outcome === "Yes")!;
    const no = result.tokens.find((t) => t.outcome === "No")!;
    expect(yes.sentimentTilt).toBeCloseTo(0.02, 5);
    expect(no.sentimentTilt).toBeCloseTo(-0.02, 5);
    expect(yes.edge).toBeGreaterThan(0);
    expect(no.edge).toBeLessThan(0);
    expect(yes.weight).toBeGreaterThan(0);
    expect(no.weight).toBeLessThan(0);
  });

  it("extreme greed → negative tilt on YES (crypto-UP markets)", () => {
    const m = mkMarket({
      question: "Will ETH reach new ATH by Nov?",
    });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 85, // extreme greed > 75
        valueText: "Extreme Greed",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    const yes = result.tokens.find((t) => t.outcome === "Yes")!;
    expect(yes.sentimentTilt).toBeCloseTo(-0.02, 5);
    expect(yes.edge).toBeLessThan(0);
    expect(yes.weight).toBeLessThan(0);
  });

  it("non-crypto market gets no sentiment tilt regardless of F&G", () => {
    const m = mkMarket({
      question: "Russia-Ukraine Ceasefire by 2026?",
    });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 10,
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    for (const t of result.tokens) {
      expect(t.sentimentTilt).toBe(0);
      expect(t.weight).toBe(0);
    }
  });
});

describe("runPmAlpha — Kelly math", () => {
  it("Kelly fraction: edge/b with b = (1-p)/p", () => {
    // Crypto market, YES price=0.4, extreme fear → tilt +0.02 → p_est=0.42
    // edge = 0.02; b = 0.6/0.4 = 1.5; kelly_raw = 0.02/1.5 = 0.01333
    // weight = 0.2 × 0.01333 = 0.002667  (< MAX_WT=0.02 so no clip)
    const m = mkMarket({ question: "Will BTC hit $150K by Sep?" });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 20,
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    const yes = result.tokens.find((t) => t.outcome === "Yes")!;
    expect(yes.kellyRaw).toBeCloseTo(0.02 / 1.5, 6);
    expect(yes.weight).toBeCloseTo(0.2 * (0.02 / 1.5), 6);
  });

  it("per-token clip: |weight| ≤ maxWeightPerToken", () => {
    // Force a large raw Kelly by using kellyScale=10 (way above default 0.2)
    const m = mkMarket({
      question: "Will BTC hit ATH?",
      outcomes: [
        { id: "y", label: "Yes", price: 0.4 },
        { id: "n", label: "No", price: 0.6 },
      ],
    });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 10,
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
      config: { kellyScale: 10 },
    });
    for (const t of result.tokens) {
      expect(Math.abs(t.weight)).toBeLessThanOrEqual(
        PM_ALPHA_DEFAULTS.maxWeightPerToken + 1e-12,
      );
    }
  });

  it("total-exposure clip: Σ|weight| ≤ maxTotalExposure", () => {
    // Many markets tilting in same direction → sum would exceed cap
    const markets: PredictionMarket[] = [];
    for (let i = 0; i < 50; i++) {
      markets.push(
        mkMarket({
          marketId: `m-${i}`,
          slug: `m-${i}`,
          question: `Will BTC hit ATH number ${i}?`,
          outcomes: [
            { id: `y-${i}`, label: "Yes", price: 0.4 },
            { id: `n-${i}`, label: "No", price: 0.6 },
          ],
        }),
      );
    }
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 10,
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets,
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.totalExposure).toBeLessThanOrEqual(
      PM_ALPHA_DEFAULTS.maxTotalExposure + 1e-12,
    );
  });
});

describe("runPmAlpha — exclusion rules", () => {
  it("excludes extreme_price (< 0.05 or > 0.95)", () => {
    const m = mkMarket({
      outcomes: [
        { id: "y", label: "Yes", price: 0.02 }, // extreme low
        { id: "n", label: "No", price: 0.98 }, // extreme high
      ],
    });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens.every((t) => t.excluded)).toBe(true);
    expect(
      result.tokens.every((t) => t.excludeReason === "extreme_price"),
    ).toBe(true);
    expect(result.nActive).toBe(0);
  });

  it("excludes low_liquidity", () => {
    const m = mkMarket({ liquidityUsd: 500 });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens.every((t) => t.excluded)).toBe(true);
    expect(result.tokens[0]!.excludeReason).toBe("low_liquidity");
  });

  it("excludes near_resolution (< 1 day)", () => {
    const m = mkMarket({
      resolutionDate: "2026-04-20T20:00:00Z", // 4h from asOf
    });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens[0]!.excludeReason).toBe("near_resolution");
  });

  it("excludes far_resolution (> 180 days)", () => {
    const m = mkMarket({
      resolutionDate: "2027-12-31T00:00:00Z", // way past 180d
    });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens[0]!.excludeReason).toBe("far_resolution");
  });

  it("excludes malformed_outcome when outcomes array is empty", () => {
    const m = mkMarket({ outcomes: [] });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens[0]!.excluded).toBe(true);
    expect(result.tokens[0]!.excludeReason).toBe("malformed_outcome");
  });

  it("excludes unknown_liquidity when liquidityUsd is undefined (audit W2 round 1)", () => {
    const m = mkMarket({ liquidityUsd: undefined });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens.every((t) => t.excluded)).toBe(true);
    expect(result.tokens[0]!.excludeReason).toBe("unknown_liquidity");
  });

  it("excludes unknown_resolution when resolutionDate is undefined (audit W3)", () => {
    const m = mkMarket({ resolutionDate: undefined });
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens.every((t) => t.excluded)).toBe(true);
    expect(result.tokens[0]!.excludeReason).toBe("unknown_resolution");
  });

  it("excludes already_resolved when resolutionDate is in the past (audit W6)", () => {
    const m = mkMarket({ resolutionDate: "2026-04-10T00:00:00Z" }); // before ASOF
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.tokens.every((t) => t.excluded)).toBe(true);
    expect(result.tokens[0]!.excludeReason).toBe("already_resolved");
  });
});

describe("runPmAlpha — multi-outcome tilt gate (audit W4)", () => {
  it("3-outcome crypto market: no tilt applied to any outcome", () => {
    const m = mkMarket({
      question: "Will BTC break ATH by Q3?",
      outcomes: [
        { id: "a", label: "January", price: 0.2 },
        { id: "b", label: "February", price: 0.3 },
        { id: "c", label: "March", price: 0.5 },
      ],
    });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 10,
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    for (const t of result.tokens) {
      expect(t.sentimentTilt).toBe(0);
      expect(t.weight).toBe(0);
    }
  });

  it("2-outcome crypto market with custom labels (no yes/no match): no tilt", () => {
    const m = mkMarket({
      question: "Will BTC reach ATH?",
      outcomes: [
        { id: "a", label: "ABOVE_100K", price: 0.4 },
        { id: "b", label: "OTHERWISE", price: 0.6 },
      ],
    });
    const sentiment: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        symbol: undefined,
        value: 10,
        valueText: "Extreme Fear",
        observedAt: "2026-04-20T00:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: sentiment,
      whaleTrades: [],
      asOf: ASOF,
    });
    const above = result.tokens.find((t) => t.outcome === "ABOVE_100K")!;
    // "ABOVE" starts with "above" → isYesLabel matches; tilt applies.
    expect(above.sentimentTilt).toBeCloseTo(0.02, 5);
  });
});

describe("runPmAlpha — whale flow", () => {
  it("empty whale trades → whaleFlowUsd=null on every token", () => {
    const m = mkMarket();
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    for (const t of result.tokens) expect(t.whaleFlowUsd).toBeNull();
  });

  it("whale buy on YES → positive flow on YES, negative on NO", () => {
    const m = mkMarket({ marketId: "mkt-1" });
    const trades: WhaleTrade[] = [
      {
        source: "polymarket",
        wallet: "0xwhale",
        marketId: "mkt-1",
        side: "buy",
        sizeUsd: 10_000,
        occurredAt: "2026-04-19T00:00:00Z",
      },
      {
        source: "polymarket",
        wallet: "0xwhale",
        marketId: "mkt-1",
        side: "buy",
        sizeUsd: 5_000,
        occurredAt: "2026-04-19T01:00:00Z",
      },
    ];
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: trades,
      asOf: ASOF,
    });
    const yes = result.tokens.find((t) => t.outcome === "Yes")!;
    const no = result.tokens.find((t) => t.outcome === "No")!;
    expect(yes.whaleFlowUsd).toBe(15_000);
    expect(no.whaleFlowUsd).toBe(-15_000);
  });
});

describe("runPmAlpha — metadata", () => {
  it("run result includes durationMs + generated runId", () => {
    const m = mkMarket();
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
    });
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.runTimestamp).toBe(ASOF);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("injected runId is used verbatim", () => {
    const m = mkMarket();
    const result = runPmAlpha({
      markets: [m],
      sentimentReadings: [],
      whaleTrades: [],
      asOf: ASOF,
      runId: "deterministic-id",
    });
    expect(result.runId).toBe("deterministic-id");
  });
});
