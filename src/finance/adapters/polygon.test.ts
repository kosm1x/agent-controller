/**
 * Polygon adapter tests — daily, intraday, rate-limit, URL shape, host override.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { isNyseTradingDay } from "../market-calendar.js";

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

  // 2026-09-18: `lookback` is BARS, the URL window is CALENDAR days. A 1:1
  // window returned 33 bars for lookback 40 and market_signals skipped the
  // whole watchlist as "insufficient bars".
  function windowDays(url: string): number {
    const m = url.match(/\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\?/)!;
    return Math.round((Date.parse(m[2]) - Date.parse(m[1])) / 86_400_000);
  }

  it("daily window holds at least `lookback` completed NYSE sessions (worst-case dates)", async () => {
    // Worst end dates per lookback over the 2024-2027 holiday table (qa R1).
    // Today's bar does not exist pre-market, so it is not counted.
    for (const [today, lookback] of [
      ["2025-01-20T12:00:00Z", 40],
      ["2025-07-06T12:00:00Z", 250],
    ] as [string, number][]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(today));
      __resetForTests();
      const fakeFetch = vi
        .fn()
        .mockImplementation(async () =>
          okResponse({ results: [], status: "OK" }),
        ) as unknown as typeof fetch;
      const adapter = new PolygonAdapter("key", "https://x/v2", fakeFetch);
      await adapter.fetchDaily("SPY", { lookback });
      vi.useRealTimers();
      const m = ((fakeFetch as any).mock.calls[0][0] as string).match(
        /\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\?/,
      )!;
      let sessions = 0;
      for (
        let d = new Date(`${m[1]}T12:00:00Z`);
        d < new Date(`${m[2]}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        if (isNyseTradingDay(d.toISOString().slice(0, 10))) sessions++;
      }
      expect(sessions).toBeGreaterThanOrEqual(lookback);
    }
  });

  it("60min window is sized in hour bars, not 1-minute bars", async () => {
    const fakeFetch = vi
      .fn()
      .mockImplementation(async () =>
        okResponse({ results: [], status: "OK" }),
      ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter("key", "https://x/v2", fakeFetch);
    await adapter.fetchIntraday("SPY", "60min", { lookback: 60 });
    const days = windowDays((fakeFetch as any).mock.calls[0][0]);
    // 60 hour-bars = 10 regular sessions (6.5 h) → ≥ 14 calendar days.
    expect(days).toBeGreaterThanOrEqual(14);
  });

  it("requests newest-first and returns ascending, keeping the newest bar", async () => {
    const bar = (t: number) => ({ t, o: 1, h: 1, l: 1, c: t, v: 1 });
    const fakeFetch = vi.fn().mockResolvedValue(
      okResponse({
        status: "OK",
        results: [bar(3_000), bar(2_000), bar(1_000)], // sort=desc payload
      }),
    ) as unknown as typeof fetch;
    const adapter = new PolygonAdapter("key", "https://x/v2", fakeFetch);
    const bars = await adapter.fetchDaily("SPY", { lookback: 2 });
    const url = (fakeFetch as any).mock.calls[0][0] as string;
    expect(url).toContain("sort=desc");
    expect(url).not.toContain("sort=asc");
    // `limit` caps BASE aggregates (1-minute bars for hour/N-minute spans):
    // lookback + 50 returned ~2 hour bars for a 60min scan.
    expect(url).toContain("limit=50000");
    expect(bars.map((b) => b.close)).toEqual([2_000, 3_000]);
  });

  describe("fetchWeekly", () => {
    afterEach(() => vi.useRealTimers());

    // Live shape 2026-09-18: bars stamped Sunday 04:00Z (00:00 ET); the 04-12
    // bar closed at AV's Fri 04-17 close, the 03-29 bar is Good Friday's week.
    const sunday = (iso: string, c: number) => ({
      v: 1000,
      o: c,
      h: c + 1,
      l: c - 1,
      c,
      t: Date.parse(iso + "T04:00:00Z"),
    });
    const body = {
      status: "OK",
      results: [
        sunday("2026-04-12", 710.14),
        sunday("2026-04-05", 679.46),
        sunday("2026-03-29", 655.83),
      ],
    };

    it("re-keys each Sunday-stamped bar to the Friday close of the week it covers", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-25T15:00:00Z"));
      const fakeFetch = vi
        .fn()
        .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
      const adapter = new PolygonAdapter("key", "https://x/v2", fakeFetch);
      const bars = await adapter.fetchWeekly("SPY", { lookback: 520 });
      expect(bars.map((b) => [b.timestamp, b.close])).toEqual([
        ["2026-04-03T16:00:00-04:00", 655.83],
        ["2026-04-10T16:00:00-04:00", 679.46],
        ["2026-04-17T16:00:00-04:00", 710.14],
      ]);
      expect(bars.every((b) => b.interval === "weekly")).toBe(true);
      const url = (fakeFetch as any).mock.calls[0][0] as string;
      expect(url).toContain("/range/1/week/");
    });

    it("always asks for the full 2y window, whatever the lookback", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-25T15:00:00Z"));
      const fakeFetch = vi
        .fn()
        .mockResolvedValue(okResponse(body)) as unknown as typeof fetch;
      const adapter = new PolygonAdapter("key", "https://x/v2", fakeFetch);
      const bars = await adapter.fetchWeekly("SPY", { lookback: 1 });
      expect(bars.map((b) => b.timestamp.slice(0, 10))).toEqual(["2026-04-17"]);
      const url = (fakeFetch as any).mock.calls[0][0] as string;
      const from = url.match(/week\/(\d{4}-\d{2}-\d{2})\//)![1]!;
      const days = (Date.parse("2026-04-25") - Date.parse(from)) / 86400000;
      expect(days).toBeGreaterThanOrEqual(104 * 7);
    });

    it("drops the week still in progress — Friday itself included", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fakeFetch = vi
        .fn()
        .mockImplementation(async () =>
          okResponse(body),
        ) as unknown as typeof fetch;
      const adapter = new PolygonAdapter("key", "https://x/v2", fakeFetch);
      // Wed 04-15 and Fri 04-17 (after the close): the 04-12 bar is not final.
      for (const now of ["2026-04-15T15:00:00Z", "2026-04-17T21:00:00Z"]) {
        vi.setSystemTime(new Date(now));
        const bars = await adapter.fetchWeekly("SPY", { lookback: 10 });
        expect(bars.map((b) => b.timestamp.slice(0, 10))).toEqual([
          "2026-04-03",
          "2026-04-10",
        ]);
      }
      vi.setSystemTime(new Date("2026-04-18T15:00:00Z"));
      const bars = await adapter.fetchWeekly("SPY", { lookback: 10 });
      expect(bars.at(-1)!.timestamp.slice(0, 10)).toBe("2026-04-17");
    });
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
