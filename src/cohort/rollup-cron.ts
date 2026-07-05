/**
 * v7.7 Spine 5 Bundle 2 — Conway Pattern 2 cohort roll-up cron.
 *
 * Re-derives the self-defining cohort once per day at 05:00 Mexico City —
 * before the 06:00 morning-brief window, so V8.1's briefing reads a fresh
 * cohort. The roll-up itself (`rollUpCohort`) is deterministic and cheap
 * (a few SQL aggregations, no LLM), so daily is ample.
 *
 * Idempotent registration: `registerCohortRollupCron()` stops any
 * previously-registered job first. Safe to call on every boot.
 */

import cron, { type ScheduledTask } from "node-cron";
import { recordCohortRollup } from "../observability/prometheus.js";
import { type RollUpResult, rollUpCohort } from "./self-defining.js";
import { RITUALS_TIMEZONE } from "../rituals/config.js";
import { errMsg } from "../lib/err-msg.js";

// Derive from the env-overridable canonical value — a hardcoded literal here
// would silently split this cron from the rituals if RITUALS_TIMEZONE is set.
const ROLLUP_TIMEZONE = RITUALS_TIMEZONE;
// 05:00 Mexico City daily — ahead of the morning brief, offset from the
// skill test sweep (02/08/14/20) to spread CPU load.
const ROLLUP_CRON = "0 5 * * *";

let scheduledJob: ScheduledTask | null = null;

export interface RollupLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_LOG: RollupLog = {
  info: (msg, fields) => console.log("[cohort:rollup]", msg, fields ?? ""),
  warn: (msg, fields) => console.warn("[cohort:rollup]", msg, fields ?? ""),
};

/**
 * Register the daily cohort roll-up cron. Returns true if newly registered.
 */
export function registerCohortRollupCron(
  log: RollupLog = DEFAULT_LOG,
): boolean {
  stopCohortRollupCron();
  scheduledJob = cron.schedule(ROLLUP_CRON, () => runCohortRollup(log), {
    timezone: ROLLUP_TIMEZONE,
  });
  log.info(
    `registered cohort roll-up cron (${ROLLUP_CRON}, ${ROLLUP_TIMEZONE})`,
  );
  return true;
}

export function stopCohortRollupCron(): void {
  if (scheduledJob) {
    try {
      scheduledJob.stop();
    } catch {
      /* node-cron stop is best-effort */
    }
    scheduledJob = null;
  }
}

/**
 * Run one roll-up tick. Never throws — a failed roll-up logs, bumps the
 * error counter, and leaves the previous cohort intact (the gauge is not
 * overwritten on failure). Returns the result, or null if the roll-up
 * threw. Exposed for direct invocation (`mc-ctl cohort rollup`, tests).
 */
export function runCohortRollup(
  log: RollupLog = DEFAULT_LOG,
): RollUpResult | null {
  try {
    const result = rollUpCohort();
    recordCohortRollup("ok", result.by_kind);
    log.info("cohort roll-up complete", { ...result });
    return result;
  } catch (err) {
    recordCohortRollup("error");
    log.warn("cohort roll-up failed", {
      error: errMsg(err),
    });
    return null;
  }
}
