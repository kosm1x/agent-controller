/**
 * api_call_budget SQL on the real schema (`initDatabase(":memory:")`).
 *
 * The provider adapters' tests stub the database and the stats tool's test
 * stubs `budgetSummary`, so no other test looks at what these statements
 * write or return. The windows are computed by SQLite's clock
 * (`datetime('now', …)`), so rows are aged with that same clock; the
 * limiter compares against JavaScript's clock, and every seeded age keeps a
 * wide margin from the window edges.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  budgetSummary,
  recordBudget,
  seedRateLimitersFromHistory,
} from "./budget.js";
import {
  __resetForTests,
  currentDailyWindow,
  currentWindow,
} from "./rate-limit.js";

/** Inserts one call row aged on SQLite's clock. */
function callAt(provider: string, status: string, modifier: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO api_call_budget (provider, endpoint, status, call_time)
       VALUES (?, 'synthetic', ?, datetime('now', ?))`,
    )
    .run(provider, status, modifier);
}

beforeEach(() => {
  __resetForTests();
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  __resetForTests();
});

describe("recordBudget on the real api_call_budget table", () => {
  it("writes each field to its own column; optional fields default to null and 1", () => {
    recordBudget({
      provider: "polygon",
      endpoint: "aggs",
      status: "success",
      responseTimeMs: 120,
      costUnits: 3,
    });
    recordBudget({ provider: "fred", endpoint: "series", status: "error" });
    expect(
      getDatabase()
        .prepare(
          `SELECT provider, endpoint, status, response_time_ms, cost_units
             FROM api_call_budget ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        provider: "polygon",
        endpoint: "aggs",
        status: "success",
        response_time_ms: 120,
        cost_units: 3,
      },
      {
        provider: "fred",
        endpoint: "series",
        status: "error",
        response_time_ms: null,
        cost_units: 1,
      },
    ]);
  });
});

describe("budgetSummary on the real table", () => {
  it("aggregates the last hour per provider: calls, success share, summed cost units", () => {
    // Calls, success shares and cost sums all differ between and within the
    // providers, so a swapped aggregate or a dropped group key shows.
    recordBudget({ provider: "polygon", endpoint: "a", status: "success" });
    recordBudget({
      provider: "polygon",
      endpoint: "a",
      status: "success",
      costUnits: 25,
    });
    recordBudget({ provider: "polygon", endpoint: "a", status: "error" });
    recordBudget({
      provider: "fred",
      endpoint: "b",
      status: "success",
      costUnits: 4,
    });
    recordBudget({ provider: "fred", endpoint: "b", status: "error" });
    // Near the window edge: -50 minutes is inside the hour and counted,
    // -70 minutes is outside and counted nowhere; neither is close enough to
    // the edge for the time between insert and read to matter.
    callAt("polygon", "success", "-50 minutes");
    callAt("fred", "error", "-70 minutes");
    // Older than the hour: counted nowhere.
    callAt("polygon", "error", "-2 hours");
    callAt("alpha_vantage", "success", "-2 hours");

    const rows = budgetSummary().sort((a, b) =>
      a.provider.localeCompare(b.provider),
    );
    expect(rows).toEqual([
      { provider: "fred", calls: 2, successRate: 0.5, costUnits: 5 },
      { provider: "polygon", calls: 4, successRate: 0.75, costUnits: 28 },
    ]);
  });
});

describe("seedRateLimitersFromHistory on the real table", () => {
  it("seeds each provider from its own recent calls only, not a neighbouring provider's", () => {
    // Providers sort alpha_vantage < fred < polygon, so fred has a neighbour
    // on both sides; every provider's recent count is a different number.
    callAt("polygon", "success", "-10 seconds");
    callAt("polygon", "success", "-12 seconds");
    callAt("polygon", "success", "-5 minutes");
    callAt("fred", "success", "-10 seconds");
    callAt("fred", "success", "-14 seconds");
    callAt("fred", "success", "-18 seconds");
    callAt("alpha_vantage", "success", "-2 hours");
    callAt("alpha_vantage", "success", "-2 days");

    seedRateLimitersFromHistory();

    expect(currentWindow()).toMatchObject({
      polygon: 2,
      fred: 3,
      alpha_vantage: 0,
    });
    expect(currentDailyWindow()).toEqual({ alpha_vantage: 1 });
  });
});
