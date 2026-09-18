/**
 * Weekly-bar refresh cron.
 *
 * `alpha_run` and `backtest_run` read `market_data interval='weekly'`, and
 * until 2026-09-18 nothing wrote to it on a schedule: the seed skipped any
 * symbol with ≥300 rows, so 6 of 10 watchlist symbols stayed at the 04-17 seed
 * and `alpha_run` answered with an equal-weight fallback. Runs every morning:
 * a symbol that already holds the last completed week costs no provider call,
 * so Saturday does the work and the other days only catch up after downtime.
 *
 * Idempotent: `registerWeeklyRefreshCron()` stops any previously-registered
 * job first. Safe to call on every boot.
 */

import { type ScheduledTask } from "node-cron";
import { scheduleCron } from "../lib/cron.js";
import { recordRitualFailure } from "../rituals/scheduler.js";
import { formatSeedResult, refreshWeeklyWatchlist } from "./watchlist-seed.js";

const REFRESH_TIMEZONE = "America/New_York";
// 09:00 New York, daily (see header).
const REFRESH_CRON = "0 9 * * *";

let scheduledJob: ScheduledTask | null = null;

export interface RefreshLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_LOG: RefreshLog = {
  info: (msg, fields) => console.log("[weekly-refresh]", msg, fields ?? ""),
  warn: (msg, fields) => console.warn("[weekly-refresh]", msg, fields ?? ""),
};

export function registerWeeklyRefreshCron(
  log: RefreshLog = DEFAULT_LOG,
): boolean {
  stopWeeklyRefreshCron();
  scheduledJob = scheduleCron(
    "weekly-bars-refresh",
    REFRESH_CRON,
    () => runWeeklyRefresh(log),
    { timezone: REFRESH_TIMEZONE },
  );
  log.info(
    `registered weekly-bars-refresh cron (${REFRESH_CRON}, ${REFRESH_TIMEZONE})`,
  );
  return true;
}

export function stopWeeklyRefreshCron(): void {
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
  }
}

export async function runWeeklyRefresh(
  log: RefreshLog = DEFAULT_LOG,
): Promise<void> {
  try {
    const results = await refreshWeeklyWatchlist();
    const failed = results.filter((r) => r.error);
    log.info("weekly bars refreshed", {
      refreshed: results.length - failed.length,
      failed: failed.length,
    });
    if (failed.length > 0) {
      log.warn("weekly bars refresh had errors", {
        detail: failed.map(formatSeedResult),
      });
      recordRitualFailure(
        "weekly-bars-refresh",
        new Error(failed.map((r) => `${r.symbol}: ${r.error}`).join("; ")),
        "execute",
      );
    }
  } catch (err) {
    recordRitualFailure("weekly-bars-refresh", err, "execute");
  }
}
