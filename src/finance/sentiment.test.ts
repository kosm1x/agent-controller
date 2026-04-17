/**
 * F6.5 sentiment adapter tests.
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

// Config mock — default has no CMC key. Tests that exercise the pro path
// update the mock return via vi.mocked(getConfig).mockReturnValueOnce.
vi.mock("../config.js", () => ({
  getConfig: vi.fn(() => ({})),
}));

import {
  fetchAltMeFearGreed,
  fetchCmcFearGreed,
  fetchBinanceFunding,
  getSentimentSnapshot,
  persistSentimentReadings,
  type SentimentReading,
} from "./sentiment.js";
import { getConfig } from "../config.js";
import { __resetForTests } from "./rate-limit.js";
import { RateLimitedError } from "./types.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchAltMeFearGreed", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("parses alt.me response shape", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      okResponse({
        data: [
          {
            value: "67",
            value_classification: "Greed",
            timestamp: "1776585600",
            time_until_update: "3600",
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const r = await fetchAltMeFearGreed(fakeFetch);
    expect(r).not.toBeNull();
    expect(r!.value).toBe(67);
    expect(r!.valueText).toBe("Greed");
    expect(r!.source).toBe("alternative_me");
    expect(r!.indicator).toBe("fear_greed");
  });

  it("returns null on empty data", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ data: [] })) as unknown as typeof fetch;
    expect(await fetchAltMeFearGreed(fakeFetch)).toBeNull();
  });

  it("429 → RateLimitedError", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("rl", { status: 429 }),
      ) as unknown as typeof fetch;
    await expect(fetchAltMeFearGreed(fakeFetch)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});

describe("fetchCmcFearGreed", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
    vi.mocked(getConfig).mockReturnValue({} as ReturnType<typeof getConfig>);
  });

  it("uses public endpoint when no API key", async () => {
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      expect(url).toContain("api.coinmarketcap.com/data-api");
      return Promise.resolve(
        okResponse({
          data: {
            dataList: [
              { score: 62, name: "Greed", timestamp: "2026-04-17T10:00:00Z" },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const r = await fetchCmcFearGreed(fakeFetch);
    expect(r).not.toBeNull();
    expect(r!.value).toBe(62);
    expect(r!.valueText).toBe("Greed");
  });

  it("uses pro endpoint when CMC_PRO_API_KEY is set", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      cmcProApiKey: "test-cmc-key",
    } as unknown as ReturnType<typeof getConfig>);
    const fakeFetch = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        expect(url).toContain("pro-api.coinmarketcap.com");
        expect(
          (init?.headers as Record<string, string>)["X-CMC_PRO_API_KEY"],
        ).toBe("test-cmc-key");
        return Promise.resolve(
          okResponse({
            data: [
              {
                value: 58,
                value_classification: "Greed",
                timestamp: "2026-04-17",
              },
            ],
          }),
        );
      }) as unknown as typeof fetch;
    const r = await fetchCmcFearGreed(fakeFetch);
    expect(r!.value).toBe(58);
  });

  it("returns null on malformed response", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ data: {} })) as unknown as typeof fetch;
    expect(await fetchCmcFearGreed(fakeFetch)).toBeNull();
  });
});

describe("fetchBinanceFunding", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("parses premiumIndex and computes annualized rate implicitly in snapshot", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      okResponse({
        symbol: "BTCUSDT",
        lastFundingRate: "0.00015",
        markPrice: "68000",
        time: 1776585600000,
      }),
    ) as unknown as typeof fetch;
    const r = await fetchBinanceFunding("BTCUSDT", fakeFetch);
    expect(r!.value).toBe(0.00015);
    expect(r!.symbol).toBe("BTCUSDT");
    expect(r!.source).toBe("binance_funding");
  });

  it("returns null when lastFundingRate missing", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        okResponse({ symbol: "BTCUSDT" }),
      ) as unknown as typeof fetch;
    expect(await fetchBinanceFunding("BTCUSDT", fakeFetch)).toBeNull();
  });
});

describe("getSentimentSnapshot", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
    vi.mocked(getConfig).mockReturnValue({} as ReturnType<typeof getConfig>);
  });

  it("combines both F&G sources and 3 funding symbols", async () => {
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("alternative.me")) {
        return Promise.resolve(
          okResponse({
            data: [
              {
                value: "72",
                value_classification: "Greed",
                timestamp: "1776585600",
              },
            ],
          }),
        );
      }
      if (url.includes("coinmarketcap.com")) {
        return Promise.resolve(
          okResponse({
            data: {
              dataList: [{ score: 62, name: "Greed", timestamp: "2026-04-17" }],
            },
          }),
        );
      }
      if (url.includes("binance.com")) {
        const symbol = new URL(url).searchParams.get("symbol") ?? "BTCUSDT";
        return Promise.resolve(
          okResponse({
            symbol,
            lastFundingRate: "0.0001",
            time: 1776585600000,
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const snap = await getSentimentSnapshot(fakeFetch);
    expect(snap.fearGreed).not.toBeNull();
    expect(snap.fearGreed!.value).toBe(67); // (72+62)/2
    expect(snap.fearGreed!.classification).toBe("Greed");
    expect(snap.fearGreed!.sources).toHaveLength(2);
    expect(snap.fundingRates).toHaveLength(3);
    expect(snap.degradedSources).toHaveLength(0);
    expect(snap.interpretation).toMatch(/greedy/);
  });

  it("gracefully degrades when one source is down", async () => {
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("alternative.me")) {
        return Promise.resolve(new Response("down", { status: 503 }));
      }
      if (url.includes("coinmarketcap.com")) {
        return Promise.resolve(
          okResponse({
            data: {
              dataList: [{ score: 50, name: "Neutral", timestamp: "t" }],
            },
          }),
        );
      }
      return Promise.resolve(
        okResponse({
          symbol: "X",
          lastFundingRate: "0.00005",
          time: 1776585600000,
        }),
      );
    }) as unknown as typeof fetch;
    const snap = await getSentimentSnapshot(fakeFetch);
    expect(snap.fearGreed!.value).toBe(50);
    expect(snap.fearGreed!.sources).toHaveLength(1);
    expect(snap.degradedSources.some((d) => d.includes("alternative_me"))).toBe(
      true,
    );
  });

  it("returns null fearGreed when both sources down; still runs funding", async () => {
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("alternative.me") || url.includes("coinmarketcap.com")) {
        return Promise.resolve(new Response("err", { status: 500 }));
      }
      return Promise.resolve(
        okResponse({ symbol: "X", lastFundingRate: "0", time: 1776585600000 }),
      );
    }) as unknown as typeof fetch;
    const snap = await getSentimentSnapshot(fakeFetch);
    expect(snap.fearGreed).toBeNull();
    expect(snap.fundingRates).toHaveLength(3);
  });

  it("classifies extreme-fear as contrarian bullish in interpretation", async () => {
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("alternative.me")) {
        return Promise.resolve(
          okResponse({
            data: [
              {
                value: "15",
                value_classification: "Extreme Fear",
                timestamp: "1776585600",
              },
            ],
          }),
        );
      }
      if (url.includes("coinmarketcap.com")) {
        return Promise.resolve(
          okResponse({
            data: {
              dataList: [{ score: 18, name: "Extreme Fear", timestamp: "t" }],
            },
          }),
        );
      }
      return Promise.resolve(
        okResponse({
          symbol: "X",
          lastFundingRate: "-0.0005",
          time: 1776585600000,
        }),
      );
    }) as unknown as typeof fetch;
    const snap = await getSentimentSnapshot(fakeFetch);
    expect(snap.interpretation).toMatch(/extreme fear/i);
    expect(snap.interpretation).toMatch(/short/);
  });
});

describe("persistSentimentReadings", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts + dedupes on (source, indicator, symbol, observed_at)", () => {
    const readings: SentimentReading[] = [
      {
        source: "alternative_me",
        indicator: "fear_greed",
        value: 55,
        valueText: "Greed",
        observedAt: "2026-04-17T10:00:00Z",
      },
      {
        source: "binance_funding",
        indicator: "funding_rate",
        symbol: "BTCUSDT",
        value: 0.0001,
        observedAt: "2026-04-17T10:00:00Z",
      },
    ];
    expect(persistSentimentReadings(readings)).toBe(2);
    // Dedupe on re-insert
    expect(persistSentimentReadings(readings)).toBe(0);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM sentiment_readings")
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it("empty input returns 0", () => {
    expect(persistSentimentReadings([])).toBe(0);
  });
});
