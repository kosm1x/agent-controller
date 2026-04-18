/**
 * End-to-end integration test for the market_watchlist_add auto-seed path.
 *
 * Audit C3 round 1: the existing market.test.ts mocks seedSymbol, so the
 * full chain of `marketWatchlistAddTool → DataLayer.addToWatchlist →
 * seedSymbol → DataLayer.getWeekly → AlphaVantageAdapter.fetchWeekly →
 * persistBars → detectAllSignals → persistSignals` was never exercised through
 * the tool boundary. This file fills that gap with a real in-memory SQLite and
 * only the HTTP layer stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(
    resolve(__dirname, "../../db/schema.sql"),
    "utf8",
  );
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../../db/index.js", () => ({
  getDatabase: () => db,
}));

vi.mock("../../config.js", () => ({
  getConfig: () => ({
    alphaVantageApiKey: "test-av",
    polygonApiKey: null,
    fredApiKey: null,
  }),
}));

// Build a synthetic weekly series that will produce real indicator firings.
function buildAvWeeklyBody(nWeeks: number): unknown {
  const series: Record<string, Record<string, string>> = {};
  const start = new Date("2018-01-05").getTime();
  for (let i = 0; i < nWeeks; i++) {
    const date = new Date(start + i * 7 * 86400000).toISOString().slice(0, 10);
    // Oscillating trend so RSI / MACD / Bollinger have firing windows
    const base = 100 + i * 0.5;
    const osc = Math.sin(i / 4) * 8;
    const close = base + osc;
    series[date] = {
      "1. open": (close - 1).toFixed(4),
      "2. high": (close + 2).toFixed(4),
      "3. low": (close - 2).toFixed(4),
      "4. close": close.toFixed(4),
      "5. adjusted close": close.toFixed(4),
      "6. volume": (100_000 + (i % 7) * 10_000).toString(),
      "7. dividend amount": "0.0000",
    };
  }
  return {
    "Meta Data": {
      "1. Information": "Weekly Adjusted Prices and Volumes",
      "2. Symbol": "NVDA",
    },
    "Weekly Adjusted Time Series": series,
  };
}

// Replace global fetch for the adapter's HTTP call.
const originalFetch = globalThis.fetch;

import { __resetDataLayerForTests } from "../../finance/data-layer.js";
import { __resetForTests as resetRateLimit } from "../../finance/rate-limit.js";
import { marketWatchlistAddTool } from "./market.js";

describe("market_watchlist_add end-to-end (audit C3 round 1)", () => {
  beforeEach(() => {
    db = freshDb();
    __resetDataLayerForTests();
    resetRateLimit();
  });

  it("populates market_data (weekly) and market_signals from a fresh watchlist add", async () => {
    // Return full weekly history from the stubbed AV endpoint.
    const body = buildAvWeeklyBody(350);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    try {
      const out = (await marketWatchlistAddTool.execute({
        symbol: "NVDA",
        asset_class: "equity",
        tags: ["semi", "ai"],
      })) as string;

      expect(out).toMatch(/OK: added NVDA/);
      expect(out).toMatch(/weekly bars/);

      // Verify market_data contains weekly rows for NVDA
      const barCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM market_data WHERE symbol='NVDA' AND interval='weekly'",
          )
          .get() as { n: number }
      ).n;
      expect(barCount).toBeGreaterThanOrEqual(300);

      // Verify market_signals has firings (RSI / MACD / Bollinger across 350 weeks)
      const sigCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM market_signals WHERE symbol='NVDA'",
          )
          .get() as { n: number }
      ).n;
      expect(sigCount).toBeGreaterThan(0);

      // Watchlist row present
      const wl = db
        .prepare(
          "SELECT symbol FROM watchlist WHERE symbol='NVDA' AND active=1",
        )
        .get() as { symbol: string } | undefined;
      expect(wl?.symbol).toBe("NVDA");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the watchlist row on seed failure (provider error)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      ) as unknown as typeof fetch;

    try {
      const out = (await marketWatchlistAddTool.execute({
        symbol: "OOPS",
        asset_class: "equity",
      })) as string;
      expect(out).toMatch(/OK: added OOPS/);
      expect(out).toMatch(/seed/);
      // Row persisted despite the failed seed
      const wl = db
        .prepare(
          "SELECT symbol FROM watchlist WHERE symbol='OOPS' AND active=1",
        )
        .get() as { symbol: string } | undefined;
      expect(wl?.symbol).toBe("OOPS");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
