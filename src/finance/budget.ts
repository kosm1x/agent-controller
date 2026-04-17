/**
 * api_call_budget write + read helpers.
 *
 * Every provider call — success or failure — writes a row so we can
 * (a) enforce tier ceilings, (b) seed the in-memory rate limiter at boot,
 * (c) surface consumption in the market_budget_stats tool.
 */

import { getDatabase } from "../db/index.js";
import type { BudgetEntry, Provider } from "./types.js";
import { seedFromHistory } from "./rate-limit.js";

export function recordBudget(entry: BudgetEntry): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO api_call_budget (provider, endpoint, status, response_time_ms, cost_units)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    entry.provider,
    entry.endpoint,
    entry.status,
    entry.responseTimeMs ?? null,
    entry.costUnits ?? 1,
  );
}

/**
 * Last-hour aggregate per provider — used by the budget stats tool.
 */
export function budgetSummary(): {
  provider: Provider;
  calls: number;
  successRate: number;
  costUnits: number;
}[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT provider,
              COUNT(*) AS calls,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
              SUM(cost_units) AS cost_units
       FROM api_call_budget
       WHERE call_time > datetime('now','-1 hour')
       GROUP BY provider`,
    )
    .all() as {
    provider: Provider;
    calls: number;
    successes: number;
    cost_units: number;
  }[];

  return rows.map((r) => ({
    provider: r.provider,
    calls: r.calls,
    successRate: r.calls > 0 ? r.successes / r.calls : 0,
    costUnits: r.cost_units,
  }));
}

/**
 * Seed the in-memory rate limiter at boot from the last minute of
 * successful calls. Prevents post-restart burst that would exceed the
 * provider ceiling.
 */
export function seedRateLimitersFromHistory(): void {
  const db = getDatabase();
  const providers: Provider[] = ["alpha_vantage", "polygon", "fred"];
  for (const provider of providers) {
    const rows = db
      .prepare(
        `SELECT call_time FROM api_call_budget
         WHERE provider=? AND call_time > datetime('now','-1 minute')
         ORDER BY call_time ASC`,
      )
      .all(provider) as { call_time: string }[];
    seedFromHistory(
      provider,
      rows.map((r) => r.call_time),
    );
  }
}

/**
 * Projected daily call count for a given watchlist size.
 * Used by watchlist_add to refuse adds that push projected usage > 80% of
 * the Alpha Vantage tier-1 daily quota (108,000 calls/day).
 *
 * Assumption: morning scan = 45 calls/scan × ~2 scans/day + ad-hoc = ~100 calls/symbol/day.
 * This is pessimistic — actual is lower with caching.
 */
export function projectedDailyAvCalls(watchlistSize: number): number {
  const CALLS_PER_SYMBOL_PER_DAY = 100;
  return watchlistSize * CALLS_PER_SYMBOL_PER_DAY;
}

/** Alpha Vantage tier-1 daily ceiling (108k calls/day, enforced at 80%). */
export const AV_TIER1_DAILY_CEILING = 86_400;
