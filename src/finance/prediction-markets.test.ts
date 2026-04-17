/**
 * Polymarket adapter tests — mocked fetch + in-memory SQLite for persistence.
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

import { PolymarketAdapter, persistMarkets } from "./prediction-markets.js";
import { RateLimitedError } from "./types.js";
import { __resetForTests } from "./rate-limit.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("PolymarketAdapter.fetchActiveMarkets", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("fetches + normalizes active markets with outcome prices", async () => {
    const fakeFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        okResponse([
          {
            conditionId: "0xabc",
            question: "Will BTC hit $100k by 2026-12-31?",
            slug: "btc-100k-2026",
            category: "Crypto",
            endDate: "2026-12-31T23:59:00Z",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.18", "0.82"]),
            clobTokenIds: JSON.stringify(["tok-yes", "tok-no"]),
            volume: "15000000",
            liquidity: "500000",
            negRisk: false,
            eventId: 42,
          },
        ]),
      ),
    ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    const markets = await adapter.fetchActiveMarkets({ limit: 5 });
    expect(markets).toHaveLength(1);
    const m = markets[0];
    expect(m.marketId).toBe("0xabc");
    expect(m.question).toMatch(/BTC/);
    expect(m.outcomes).toHaveLength(2);
    expect(m.outcomes[0]).toEqual({ id: "tok-yes", label: "Yes", price: 0.18 });
    expect(m.outcomes[1].price).toBe(0.82);
    expect(m.volumeUsd).toBe(15_000_000);
    expect(m.isNegRisk).toBe(false);
    expect(m.eventId).toBe("42");
  });

  it("skips malformed entries (missing question or id)", async () => {
    const fakeFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        okResponse([
          {}, // no question
          { conditionId: "good", question: "Keep me" },
        ]),
      ),
    ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    const markets = await adapter.fetchActiveMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0].marketId).toBe("good");
  });

  it("throws on non-array body", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        okResponse({ error: "nope" }),
      ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    await expect(adapter.fetchActiveMarkets()).rejects.toThrow(
      /expected array/,
    );
  });

  it("returns RateLimitedError on 429", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("rate limited", { status: 429 }),
      ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    await expect(adapter.fetchActiveMarkets()).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("returns error on non-ok HTTP", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("server oops", { status: 500 }),
      ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    await expect(adapter.fetchActiveMarkets()).rejects.toThrow(/500/);
  });

  it("captures bad JSON as parse error", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    await expect(adapter.fetchActiveMarkets()).rejects.toThrow(
      /unparseable JSON/,
    );
  });

  it("empty list returns empty array", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse([])) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    expect(await adapter.fetchActiveMarkets()).toEqual([]);
  });
});

describe("PolymarketAdapter.fetchEventGroup", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("returns grouped markets with eventId propagated", async () => {
    const fakeFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        okResponse({
          id: 100,
          title: "US Presidential Election 2028",
          negRisk: true,
          markets: [
            {
              conditionId: "m1",
              question: "Will Candidate A win?",
              outcomes: JSON.stringify(["Yes", "No"]),
              outcomePrices: JSON.stringify(["0.45", "0.55"]),
              clobTokenIds: JSON.stringify(["a1", "a2"]),
            },
            {
              conditionId: "m2",
              question: "Will Candidate B win?",
              outcomes: JSON.stringify(["Yes", "No"]),
              outcomePrices: JSON.stringify(["0.35", "0.65"]),
              clobTokenIds: JSON.stringify(["b1", "b2"]),
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    const markets = await adapter.fetchEventGroup("100");
    expect(markets).toHaveLength(2);
    expect(markets.every((m) => m.eventId === "100")).toBe(true);
    // Neg-risk propagates from event to all markets
    expect(markets.every((m) => m.isNegRisk)).toBe(true);
  });

  it("handles empty markets in event", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        okResponse({ id: 200, title: "Empty event" }),
      ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    expect(await adapter.fetchEventGroup("200")).toEqual([]);
  });
});

describe("PolymarketAdapter.fetchMarketBySlug", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("returns first match", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      okResponse([
        {
          conditionId: "xyz",
          question: "Will X happen?",
          slug: "will-x-happen",
          outcomes: JSON.stringify(["Yes", "No"]),
          outcomePrices: JSON.stringify(["0.5", "0.5"]),
        },
      ]),
    ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    const m = await adapter.fetchMarketBySlug("will-x-happen");
    expect(m).not.toBeNull();
    expect(m!.slug).toBe("will-x-happen");
  });

  it("returns null on empty result", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse([])) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    expect(await adapter.fetchMarketBySlug("nope")).toBeNull();
  });
});

describe("PolymarketAdapter.fetchRecentTrades", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("normalizes unix-timestamp trades", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      okResponse([
        {
          id: "t1",
          market: "m1",
          maker_address: "0x111",
          taker_address: "0x222",
          side: "BUY",
          size: "10000",
          price: "0.45",
          timestamp: 1776000000, // unix seconds
        },
      ]),
    ) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    const trades = await adapter.fetchRecentTrades("m1", { limit: 10 });
    expect(trades).toHaveLength(1);
    expect(trades[0].size).toBe(10000);
    expect(trades[0].price).toBe(0.45);
    expect(trades[0].timestamp).toMatch(/^2026-/);
  });

  it("returns empty on non-array", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ error: "" })) as unknown as typeof fetch;
    const adapter = new PolymarketAdapter(fakeFetch);
    expect(await adapter.fetchRecentTrades("m1")).toEqual([]);
  });
});

describe("persistMarkets", () => {
  beforeEach(() => {
    __resetForTests();
    db = freshDb();
  });

  it("inserts new and upserts on conflict (source, market_id)", () => {
    const m1 = {
      source: "polymarket" as const,
      marketId: "0xabc",
      question: "Q1",
      outcomes: [{ id: "y", label: "Yes", price: 0.5 }],
      isNegRisk: false,
    };
    expect(persistMarkets([m1])).toBe(1);
    expect(persistMarkets([{ ...m1, question: "Q1-updated" }])).toBe(1);
    const row = db
      .prepare("SELECT question FROM prediction_markets WHERE market_id=?")
      .get("0xabc") as { question: string };
    expect(row.question).toBe("Q1-updated");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM prediction_markets")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("handles empty input", () => {
    expect(persistMarkets([])).toBe(0);
  });
});
