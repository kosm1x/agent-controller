/**
 * Daily retention cron for tasks/runs (see retention.ts for the policy).
 * 04:30 local — after the nightly backups' usual window, before the 06:00
 * briefing. Same defensive shape as runners/checkpoint-prune-cron.ts: the
 * node-cron scheduler must never see an unhandled exception.
 */

import cron, { type ScheduledTask } from "node-cron";

import { runTasksRetention } from "./retention.js";
import { pruneTraceEvents } from "../observability/task-trace.js";
import { RITUALS_TIMEZONE } from "../rituals/config.js";
import { errMsg } from "../lib/err-msg.js";

const RETENTION_CRON = "30 4 * * *";

let scheduledJob: ScheduledTask | null = null;

export interface RetentionLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_LOG: RetentionLog = {
  info: (msg, fields) => console.log("[retention]", msg, fields ?? ""),
  warn: (msg, fields) => console.warn("[retention]", msg, fields ?? ""),
};

/** Register the daily retention cron. Idempotent — stops any prior job. */
export function registerRetentionCron(
  log: RetentionLog = DEFAULT_LOG,
): boolean {
  stopRetentionCron();
  scheduledJob = cron.schedule(RETENTION_CRON, () => runRetentionTick(log), {
    timezone: RITUALS_TIMEZONE,
  });
  log.info(
    `registered tasks-retention cron (${RETENTION_CRON}, ${RITUALS_TIMEZONE})`,
  );
  return true;
}

export function stopRetentionCron(): void {
  if (scheduledJob) {
    try {
      scheduledJob.stop();
    } catch {
      /* node-cron stop is best-effort */
    }
    scheduledJob = null;
  }
}

/** One retention tick. Never throws. Exported for tests. */
export function runRetentionTick(log: RetentionLog = DEFAULT_LOG): void {
  try {
    const r = runTasksRetention();
    if (r.tasksDeleted > 0 || r.skippedParents > 0) {
      log.info("retention sweep complete", {
        cutoff: r.cutoff,
        tasksDeleted: r.tasksDeleted,
        runsDeleted: r.runsDeleted,
        outcomesDeleted: r.outcomesDeleted,
        skippedParents: r.skippedParents,
        archive: r.archivePath,
      });
    }
  } catch (err) {
    log.warn("retention sweep threw (contract violation)", {
      error: errMsg(err),
    });
  }
  // V8.5 Phase 6: trace-event retention rides the same tick. pruneTraceEvents
  // has its own never-throw contract, so no extra guard needed.
  const traceRemoved = pruneTraceEvents();
  if (traceRemoved > 0) {
    log.info("trace retention", { eventsDeleted: traceRemoved });
  }
}
