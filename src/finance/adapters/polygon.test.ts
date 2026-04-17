/**
 * Polygon adapter tests — daily, intraday, rate-limit, URL shape, host override.
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
  getConfig: () => ({
    polygonApiKey: "test-poly-key",
    polygonBaseUrl: "https://api.massive.com/v2",
  }),
}));

import { PolygonAdapter } from "./polygon.js";
import { RateLimitedError } from "../types.js";
import { __resetForTests } from "../rate-limit.js";

const polygonDailySpy = JSON.parse(
  readFileSync(
    resolve(__dirname, "../__fixtures__/polygon-daily-spy.json"),
    "utf8",
  ),
);

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("PolygonAdapter", () => {
  beforeEach(() => {
    __resetForTests();
    mockDb.prepare.mockClear();
  });

  it("fetches daily aggregates from api.massive.com", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        okResponse(polygonDailySpy),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter(
      "key",
      "https://api.massive.com/v2",
      fakeFetch,
    );
    const bars = await adapter.fetchDaily("SPY", { lookback: 100 });

    expect(bars).toHaveLength(3);
    // Chronologically ascending
    expect(bars[0].open).toBe(517.25);
    expect(bars[2].close).toBe(523.45);
    // NY timestamp format (has offset)
    expect(bars[2].timestamp).toMatch(/-0[45]:00$/);
    expect(bars[2].provider).toBe("polygon");
    expect(bars[2].interval).toBe("daily");
    // URL contains api.massive.com
    const calledUrl = (fakeFetch as any).mock.calls[0][0];
    expect(calledUrl).toContain("api.massive.com");
    expect(calledUrl).toContain("/aggs/ticker/SPY/range/1/day/");
  });

  it("respects local 4/min sliding window (5th call blocked)", async () => {
    const fakeFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(okResponse({ results: [], status: "OK" })),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter(
      "key",
      "https://api.massive.com/v2",
      fakeFetch,
    );
    for (let i = 0; i < 4; i++) {
      await adapter.fetchDaily("SPY", { lookback: 1 });
    }
    await expect(
      adapter.fetchDaily("SPY", { lookback: 1 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("throws RateLimitedError on 429", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("rate limited", { status: 429 }),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter(
      "key",
      "https://api.massive.com/v2",
      fakeFetch,
    );
    await expect(
      adapter.fetchDaily("SPY", { lookback: 10 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("produces AV-shape-compatible MarketBar", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        okResponse(polygonDailySpy),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter(
      "key",
      "https://api.massive.com/v2",
      fakeFetch,
    );
    const bars = await adapter.fetchDaily("SPY", { lookback: 10 });
    const bar = bars[0];
    // Shape check: MarketBar
    expect(bar).toHaveProperty("symbol");
    expect(bar).toHaveProperty("timestamp");
    expect(bar).toHaveProperty("open");
    expect(bar).toHaveProperty("high");
    expect(bar).toHaveProperty("low");
    expect(bar).toHaveProperty("close");
    expect(bar).toHaveProperty("volume");
    expect(bar).toHaveProperty("provider");
    expect(bar).toHaveProperty("interval");
  });

  it("maps intraday interval to correct multiplier/timespan", async () => {
    const fakeFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(okResponse({ results: [], status: "OK" })),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter(
      "key",
      "https://api.massive.com/v2",
      fakeFetch,
    );
    await adapter.fetchIntraday("SPY", "5min", { lookback: 10 });
    const calledUrl = (fakeFetch as any).mock.calls[0][0];
    expect(calledUrl).toContain("/range/5/minute/");
    await adapter.fetchIntraday("SPY", "60min", { lookback: 10 });
    const calledUrl2 = (fakeFetch as any).mock.calls[1][0];
    expect(calledUrl2).toContain("/range/1/hour/");
  });

  it("honors POLYGON_BASE_URL override (legacy api.polygon.io)", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        okResponse({ results: [], status: "OK" }),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter(
      "key",
      "https://api.polygon.io/v2",
      fakeFetch,
    );
    await adapter.fetchDaily("SPY", { lookback: 1 });
    const calledUrl = (fakeFetch as any).mock.calls[0][0];
    expect(calledUrl).toContain("api.polygon.io");
    expect(calledUrl).not.toContain("api.massive.com");
  });
});
