/**
 * Hourly prune cron for both checkpoint stores.
 *
 * Two stores have lazy-only TTL enforcement:
 *   - `prometheus_snapshots` (SQLite table) — TTL 1h, enforced only when
 *     `loadSnapshot` is called. Abandoned aborts rot forever.
 *   - `workspace/checkpoints/*.md` (jarvis_files) — TTL 30 min, enforced
 *     only when `findRecentCheckpoint` is called. Never-resumed
 *     max-rounds exits rot in SQLite AND on the FS mirror AND in pgvector.
 *
 * Hourly is enough: both TTLs are ≤1h, so worst-case rot bounded ~2h.
 *
 * Hermes v0.13 "Checkpoints v2 real pruning" — `feedback_prometheus_upstream`
 * May Tier-2 #6. Closes the gap on the lazy-only TTL path.
 *
 * Idempotent: `registerCheckpointPruneCron()` stops any previously-registered
 * job first. Safe to call on every boot.
 */

import { type ScheduledTask } from "node-cron";
import { scheduleCron } from "../lib/cron.js";

import { pruneExpiredSnapshots } from "../prometheus/snapshot.js";
import { pruneExpiredCheckpoints } from "./checkpoint.js";
import { RITUALS_TIMEZONE } from "../rituals/config.js";
import { errMsg } from "../lib/err-msg.js";

// Derive from the env-overridable canonical value — a hardcoded literal here
// would silently split this cron from the rituals if RITUALS_TIMEZONE is set.
const PRUNE_TIMEZONE = RITUALS_TIMEZONE;
// On the hour, every hour. Bounded staleness ~1h beyond TTL.
const PRUNE_CRON = "0 * * * *";

let scheduledJob: ScheduledTask | null = null;

export interface PruneLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_LOG: PruneLog = {
  info: (msg, fields) => console.log("[checkpoint:prune]", msg, fields ?? ""),
  warn: (msg, fields) => console.warn("[checkpoint:prune]", msg, fields ?? ""),
};

/**
 * Register the hourly checkpoint-prune cron. Returns true if newly registered.
 */
export function registerCheckpointPruneCron(
  log: PruneLog = DEFAULT_LOG,
): boolean {
  stopCheckpointPruneCron();
  scheduledJob = scheduleCron("checkpoint-prune", PRUNE_CRON, () => runCheckpointPrune(log), {
    timezone: PRUNE_TIMEZONE,
  });
  log.info(
    `registered checkpoint-prune cron (${PRUNE_CRON}, ${PRUNE_TIMEZONE})`,
  );
  return true;
}

export function stopCheckpointPruneCron(): void {
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
 * Run one prune tick across both stores. Never throws — each prune is
 * already best-effort internally. Logs counts deleted; logs nothing on a
 * clean 0/0 sweep to avoid log spam. Exported for tests; no operator
 * surface (intentional — the cron handles all production firings).
 */
export function runCheckpointPrune(log: PruneLog = DEFAULT_LOG): {
  snapshots: number;
  checkpoints: number;
} {
  // Both prune functions are best-effort and SHOULD never throw — but the
  // node-cron scheduler must NEVER see an unhandled exception (it has no
  // missed-fire catchup and would stall the whole hourly tick). Same
  // defensive shape as `cohort/rollup-cron.ts:70-82`.
  let snapshots = 0;
  let checkpoints = 0;
  try {
    snapshots = pruneExpiredSnapshots();
  } catch (err) {
    log.warn("pruneExpiredSnapshots threw (contract violation)", {
      error: errMsg(err),
    });
  }
  try {
    checkpoints = pruneExpiredCheckpoints();
  } catch (err) {
    log.warn("pruneExpiredCheckpoints threw (contract violation)", {
      error: errMsg(err),
    });
  }
  if (snapshots > 0 || checkpoints > 0) {
    log.info("prune complete", { snapshots, checkpoints });
  }
  return { snapshots, checkpoints };
}
