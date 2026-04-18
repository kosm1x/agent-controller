/**
 * AlphaVantage adapter tests — fetch mocked, shapes validated,
 * rate-limit / error envelopes exercised.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const mockDb = {
  prepare: vi.fn(() => ({ run: vi.fn(), all: vi.fn(() => []) })),
};

vi.mock("../../db/index.js", () => ({
  getDatabase: () => mockDb,
}));

vi.mock("../../config.js", () => ({
  getConfig: () => ({ alphaVantageApiKey: "test-av-key" }),
}));

import { AlphaVantageAdapter } from "./alpha-vantage.js";
import { RateLimitedError } from "../types.js";
import { __resetForTests } from "../rate-limit.js";

const avDailySpy = JSON.parse(
  readFileSync(resolve(__dirname, "../__fixtures__/av-daily-spy.json"), "utf8"),
);
const avWeeklySpy = JSON.parse(
  readFileSync(
    resolve(__dirname, "../__fixtures__/av-weekly-spy.json"),
    "utf8",
  ),
);

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AlphaVantageAdapter", () => {
  beforeEach(() => {
    __resetForTests();
    mockDb.prepare.mockClear();
  });

  it("fetches TIME_SERIES_DAILY_ADJUSTED and normalizes timestamps", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(avDailySpy)) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    const bars = await adapter.fetchDaily("SPY", { lookback: 100 });

    // 3 bars in fixture, all within lookback
    expect(bars).toHaveLength(3);
    // Sorted chronologically ascending
    expect(bars[0].timestamp.startsWith("2026-04-15T16:00:00")).toBe(true);
    expect(bars[2].timestamp.startsWith("2026-04-17T16:00:00")).toBe(true);
    expect(bars[2].close).toBe(523.45);
    expect(bars[2].adjustedClose).toBe(523.45);
    expect(bars[2].volume).toBe(52345678);
    expect(bars[2].provider).toBe("alpha_vantage");
    expect(bars[2].interval).toBe("daily");
  });

  it("fetches TIME_SERIES_WEEKLY_ADJUSTED and normalizes timestamps", async () => {
    const fakeFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(okResponse(avWeeklySpy)),
      ) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    const bars = await adapter.fetchWeekly!("SPY", { lookback: 100 });
    // 3 bars in fixture, all within lookback
    expect(bars).toHaveLength(3);
    // Sorted ascending, first bar is oldest week
    expect(bars[0]!.timestamp.startsWith("2026-04-03T16:00:00")).toBe(true);
    expect(bars[2]!.timestamp.startsWith("2026-04-17T16:00:00")).toBe(true);
    expect(bars[2]!.close).toBe(523.45);
    expect(bars[2]!.adjustedClose).toBe(523.45);
    expect(bars[2]!.volume).toBe(152470391);
    expect(bars[2]!.provider).toBe("alpha_vantage");
    expect(bars[2]!.interval).toBe("weekly");
    // AV returns full history; lookback slices the tail
    const bars1 = await adapter.fetchWeekly!("SPY", { lookback: 1 });
    expect(bars1).toHaveLength(1);
    expect(bars1[0]!.timestamp.startsWith("2026-04-17")).toBe(true);
  });

  it("fetchWeekly throws on unexpected shape", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse({})) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    await expect(adapter.fetchWeekly!("SPY", { lookback: 10 })).rejects.toThrow(
      /AV weekly: unexpected shape/,
    );
  });

  it("fetches TIME_SERIES_INTRADAY (5min)", async () => {
    const body = {
      "Meta Data": {},
      "Time Series (5min)": {
        "2026-07-15 14:30:00": {
          "1. open": "520.10",
          "2. high": "520.55",
          "3. low": "519.90",
          "4. close": "520.45",
          "5. volume": "125000",
        },
      },
    };
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    const bars = await adapter.fetchIntraday("SPY", "5min", { lookback: 10 });
    expect(bars).toHaveLength(1);
    expect(bars[0].timestamp).toBe("2026-07-15T14:30:00-04:00");
    expect(bars[0].interval).toBe("5min");
  });

  it("fetches FX_DAILY (EURUSD) with volume=0", async () => {
    const body = {
      "Meta Data": {},
      "Time Series FX (Daily)": {
        "2026-04-17": {
          "1. open": "1.0825",
          "2. high": "1.0840",
          "3. low": "1.0810",
          "4. close": "1.0832",
        },
      },
    };
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    const bars = await adapter.fetchFxDaily("EUR", "USD", { lookback: 10 });
    expect(bars[0].symbol).toBe("EURUSD");
    expect(bars[0].close).toBe(1.0832);
    expect(bars[0].volume).toBe(0);
  });

  it("fetches GLOBAL_QUOTE", async () => {
    const body = {
      "Global Quote": {
        "01. symbol": "SPY",
        "02. open": "521.50",
        "03. high": "524.20",
        "04. low": "520.10",
        "05. price": "523.45",
        "06. volume": "52345678",
        "07. latest trading day": "2026-04-17",
        "08. previous close": "521.05",
        "09. change": "2.40",
        "10. change percent": "0.4605%",
      },
    };
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    const bar = await adapter.fetchQuote("SPY");
    expect(bar.symbol).toBe("SPY");
    expect(bar.close).toBe(523.45);
  });

  it("fetches NEWS_SENTIMENT with cost_units=25", async () => {
    const body = { feed: [], items: "0", sentiment_score_definition: "" };
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
    const run = vi.fn();
    mockDb.prepare.mockReturnValue({ run, all: vi.fn(() => []) });
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    await adapter.fetchNewsSentiment(["SPY", "AAPL"]);
    // Budget write should have costUnits=25 in the params
    const call = run.mock.calls[0];
    expect(call).toBeDefined();
    // Args: provider, endpoint, status, responseTimeMs, costUnits
    expect(call?.[4]).toBe(25);
  });

  it("fetches macro FEDFUNDS via FEDERAL_FUNDS_RATE endpoint", async () => {
    const body = {
      name: "Federal Funds Rate",
      data: [
        { date: "2026-04-01", value: "5.25" },
        { date: "2026-03-01", value: "5.25" },
      ],
    };
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    const points = await adapter.fetchMacro("FEDFUNDS");
    expect(points).toHaveLength(2);
    expect(points[0].series).toBe("FEDFUNDS");
    expect(points[0].value).toBe(5.25);
    // URL must reference FEDERAL_FUNDS_RATE function
    const calledUrl = (fakeFetch as any).mock.calls[0][0];
    expect(calledUrl).toContain("function=FEDERAL_FUNDS_RATE");
  });

  it("surfaces AV Note (premium throttle) as RateLimitedError", async () => {
    const body = { Note: "Thank you for using Alpha Vantage! Our premium..." };
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    await expect(
      adapter.fetchDaily("SPY", { lookback: 10 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("surfaces 429 as RateLimitedError", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("rate limited", { status: 429 }),
      ) as unknown as typeof fetch;
    const adapter = new AlphaVantageAdapter("test-key", fakeFetch);
    await expect(
      adapter.fetchDaily("SPY", { lookback: 10 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
