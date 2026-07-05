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
import { RITUALS_TIMEZONE } from "../../rituals/config.js";
import { errMsg } from "../err-msg.js";

// Derive from the env-overridable canonical value — a hardcoded literal here
// would silently split this cron from the rituals if RITUALS_TIMEZONE is set.
const S3_TIMEZONE = RITUALS_TIMEZONE;

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
      errMsg(err),
    );
  }

  for (const [cadence, cronExpr] of Object.entries(CRON_BY_CADENCE)) {
    const c = cadence as Cadence;
    const job = cron.schedule(
      cronExpr,
      () => void runCadenceTick(c).catch((err) => noticeError(c, err)),
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
  pushesDispatched: number;
}> {
  const signals = loadEnabledSignalsByCadence(cadence);
  let alertsEmitted = 0;
  // Bundle 3: collect emitted alert ids so post-burst push dispatch can
  // look them up by id (avoids re-querying every pending P0 in the table).
  const emittedAlertIds: number[] = [];
  for (const signal of signals) {
    try {
      const alertId = await evaluateSignal(signal);
      if (alertId !== null) {
        alertsEmitted += 1;
        emittedAlertIds.push(alertId);
      }
    } catch (err) {
      // Per-signal error isolation — one signal's failure doesn't block the
      // others in the cadence. Evaluator already promotes query failures
      // into P2 alerts; this catches errors in the evaluator itself.
      console.error(
        `[s3] evaluator threw on signal ${signal.signal_name}:`,
        errMsg(err),
      );
      // S3-I2 fold (Bundle 2): also surface to Grafana via the Prom counter.
      // Dynamic import keeps the scheduler module independent of the
      // observability registration order at boot.
      try {
        const { recordS3EvaluatorError } =
          await import("../../observability/prometheus.js");
        recordS3EvaluatorError(cadence, "signal");
      } catch {
        /* counter registration shouldn't ever block the cron tick */
      }
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
        errMsg(err),
      );
      try {
        const { recordS3EvaluatorError } =
          await import("../../observability/prometheus.js");
        recordS3EvaluatorError(cadence, "burst");
      } catch {
        /* counter registration shouldn't ever block the cron tick */
      }
    }
  }

  // Bundle 3: dispatch P0 push notifications AFTER burst detection so each
  // bundle produces ONE consolidated message instead of N per-alert messages.
  // Fire-and-forget — push failure logs + bumps counter, never blocks the
  // brief or the next cron tick. Done via dynamic import to keep scheduler
  // independent of messaging boot order.
  let pushesDispatched = 0;
  if (emittedAlertIds.length > 0) {
    try {
      const [
        { loadNewlyEmittedP0Alerts, composePushMessages, dispatchPushAlerts },
        messagingMod,
      ] = await Promise.all([
        import("./push.js"),
        import("../../messaging/index.js"),
      ]);
      const p0Alerts = loadNewlyEmittedP0Alerts(emittedAlertIds);
      if (p0Alerts.length > 0) {
        const messages = composePushMessages(p0Alerts);
        const router = messagingMod.getRouter();
        pushesDispatched = await dispatchPushAlerts(router, messages);
      }
    } catch (err) {
      console.error(
        `[s3] push dispatch failed:`,
        errMsg(err),
      );
      try {
        const { recordS3PushError } =
          await import("../../observability/prometheus.js");
        recordS3PushError("broadcast");
      } catch {
        /* counter shouldn't block delivery */
      }
    }
  }

  console.log(
    `[s3] ${cadence} tick: ${signals.length} signals evaluated, ${alertsEmitted} alerts, ${bundlesEmitted} bundles, ${pushesDispatched} push(es)`,
  );
  return {
    evaluated: signals.length,
    alertsEmitted,
    bundlesEmitted,
    pushesDispatched,
  };
}

// Exported + async so tests can await the dynamic-import + counter bump.
// Production callsite (registerS3CronJobs:73) is the void-prefixed chain
// `void runCadenceTick(c).catch((err) => noticeError(c, err))` — the cron
// callback chain is void-prefixed end-to-end; noticeError's returned promise
// is fire-and-forget at the cron-callback boundary.
export async function noticeError(
  cadence: Cadence,
  err: unknown,
): Promise<void> {
  console.error(
    `[s3] cron tick threw (${cadence}):`,
    errMsg(err),
  );
  // S3-I2 fold: tick-level failures (the cron callback itself, outside
  // per-signal isolation) also bump the Prom counter so Grafana sees them.
  // CRITICAL: do not remove this try/catch. The production cron callback
  // relies on it to absorb any rejection from the dynamic import; without
  // it, a failed observability load would leak as an unhandled rejection on
  // every cron tick that already had an upstream failure.
  try {
    const { recordS3EvaluatorError } =
      await import("../../observability/prometheus.js");
    recordS3EvaluatorError(cadence, "tick");
  } catch {
    /* counter registration shouldn't ever block the cron tick */
  }
}
