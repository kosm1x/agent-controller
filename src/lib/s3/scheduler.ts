/**
 * v7.7 Spine 2 (S3 substrate) — cron registration.
 *
 * Per spec §7: four cron cadences (hourly, every_4h, nightly, weekly).
 * The fifth cadence (`on_event`) is NOT cron-scheduled; it's fired by
 * the source component (V8.3 controller, etc.) — not implemented in this
 * bundle since V8.3 isn't shipped.
 *
 * Each cadence's cron tick:
 *   1. loads enabled signals for that cadence
 *   2. runs evaluateSignal() on each (sequentially — signals are slow,
 *      parallelism not worth the failure-isolation cost)
 *   3. detects bursts in the resulting alerts + persists bundles
 *   4. logs an aggregate summary (no per-signal noise to journal)
 *
 * Idempotent registration: `registerS3CronJobs()` can be called multiple
 * times safely (existing jobs are stopped first).
 */

import cron, { type ScheduledTask } from "node-cron";
import { evaluateSignal } from "./evaluator.js";
import {
  detectBursts,
  loadRecentUnbundledAlerts,
  persistBurstBundle,
} from "./burst.js";
import { loadEnabledSignalsByCadence, type Cadence } from "./registry.js";
import { seedSignalsIdempotent } from "./seed-signals.js";

const S3_TIMEZONE = "America/Mexico_City";

const CRON_BY_CADENCE: Record<Exclude<Cadence, "on_event">, string> = {
  // Top of hour. Matches spec §7 "hourly: top of hour".
  hourly: "0 * * * *",
  // 00:00, 04:00, 08:00, 12:00, 16:00, 20:00.
  every_4h: "0 0,4,8,12,16,20 * * *",
  // 03:00 (low-traffic window).
  nightly: "0 3 * * *",
  // Sunday 04:00.
  weekly: "0 4 * * 0",
};

const scheduledJobs: ScheduledTask[] = [];

/**
 * Register S3 cron jobs. Stops any previously-registered S3 jobs first so
 * re-registration is safe. Returns the number of jobs registered (4: one
 * per cron cadence).
 */
export function registerS3CronJobs(): number {
  stopS3CronJobs();

  // Idempotent: seed signals on first registration. Safe to call on every
  // boot — seedSignalsIdempotent skips rows that already exist.
  try {
    const { inserted, skipped } = seedSignalsIdempotent();
    console.log(
      `[s3] Seed signals: ${inserted} inserted, ${skipped} skipped (already present)`,
    );
  } catch (err) {
    // Seed failure is non-fatal — cron jobs still register and will just
    // find no signals to evaluate until a manual seed succeeds.
    console.error(
      `[s3] Seed signals failed (cron jobs still registered):`,
      err instanceof Error ? err.message : err,
    );
  }

  for (const [cadence, cronExpr] of Object.entries(CRON_BY_CADENCE)) {
    const job = cron.schedule(
      cronExpr,
      () => void runCadenceTick(cadence as Cadence).catch(noticeError),
      { timezone: S3_TIMEZONE },
    );
    scheduledJobs.push(job);
  }
  console.log(
    `[s3] Registered ${scheduledJobs.length} cron jobs (timezone ${S3_TIMEZONE})`,
  );
  return scheduledJobs.length;
}

/**
 * Stop all S3 cron jobs and clear the registry. Used by stopAll() on
 * graceful shutdown and by tests.
 */
export function stopS3CronJobs(): void {
  for (const job of scheduledJobs) {
    try {
      job.stop();
    } catch {
      /* node-cron stop is best-effort */
    }
  }
  scheduledJobs.length = 0;
}

/**
 * Run one cadence tick: evaluate every enabled signal for that cadence,
 * then detect and persist any correlated bursts the new alerts triggered.
 *
 * Exported for tests + for `mc-ctl drift run <cadence>` manual triggering.
 *
 * R1-W4 concurrent-tick race: not currently mutex-protected. Two cron jobs
 * can overlap at top-of-hour (hourly + every_4h fire at 00:00 / 04:00 / etc.)
 * AND a slow tick can re-enter if it exceeds its cadence interval. The
 * read+detect+write trio `loadRecentUnbundledAlerts → detectBursts →
 * persistBurstBundle` is not transactional across phases. Worst case: two
 * overlapping ticks bundle overlapping member sets and the second UPDATE
 * overwrites the first bundle_id. Tracked in next-sessions-queue as
 * S3-W4-burst-race. Add a per-cadence promise-mutex when V8.3 `on_event`
 * cadence lands (concurrent fires become routine).
 */
export async function runCadenceTick(cadence: Cadence): Promise<{
  evaluated: number;
  alertsEmitted: number;
  bundlesEmitted: number;
}> {
  const signals = loadEnabledSignalsByCadence(cadence);
  let alertsEmitted = 0;
  for (const signal of signals) {
    try {
      const alertId = await evaluateSignal(signal);
      if (alertId !== null) alertsEmitted += 1;
    } catch (err) {
      // Per-signal error isolation — one signal's failure doesn't block the
      // others in the cadence. Evaluator already promotes query failures
      // into P2 alerts; this catches errors in the evaluator itself.
      console.error(
        `[s3] evaluator threw on signal ${signal.signal_name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  let bundlesEmitted = 0;
  if (alertsEmitted > 0) {
    try {
      const recent = loadRecentUnbundledAlerts();
      const bursts = detectBursts(recent);
      for (const bundle of bursts) {
        persistBurstBundle(bundle);
        bundlesEmitted += 1;
      }
    } catch (err) {
      console.error(
        `[s3] burst detection failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[s3] ${cadence} tick: ${signals.length} signals evaluated, ${alertsEmitted} alerts, ${bundlesEmitted} bundles`,
  );
  return {
    evaluated: signals.length,
    alertsEmitted,
    bundlesEmitted,
  };
}

function noticeError(err: unknown): void {
  console.error(
    `[s3] cron tick threw:`,
    err instanceof Error ? err.message : err,
  );
}
