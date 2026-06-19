/**
 * Self-healing triage monitor — in-process node-cron (mirrors the register/stop/
 * tick trio of `v8-2/probe-cron.ts`). Registered ONLY when
 * `SELF_HEALING_TRIAGE_ENABLED=true` (see `flags.ts`), so it ships dormant.
 *
 * Each tick detects anomalies and, only if some are present AND no open report
 * already covers the window, runs the read-only triage sub-agent and persists a
 * report. It NEVER remediates. `RITUALS_TIMEZONE` is imported (never a hardcoded
 * tz) so the monitor can't split from the other rituals.
 */

import cron, { type ScheduledTask } from "node-cron";
import { RITUALS_TIMEZONE } from "../../rituals/config.js";
import { getDatabase } from "../../db/index.js";
import {
  detectAnomalies,
  queryPrometheus,
  getStuckTaskCount,
  recentTaskErrors,
} from "./detect.js";
import { runTriageAnalysis } from "./analyze.js";
import { persistTriageReport, hasOpenTriageWithin } from "./persist.js";
import { runTriageTick, type TriageTickLog } from "./tick.js";

/** Every 6h on the hour, MX. The throttle (one open report / 6h) prevents
 *  duplicate reports for the same ongoing issue between ticks. */
const TRIAGE_CRON = "0 */6 * * *";
const THROTTLE_HOURS = 6;

let scheduledJob: ScheduledTask | null = null;

const NOOP_LOG: TriageTickLog = { info: () => {}, warn: () => {} };

/** One tick wired to the real Prometheus / DB / SDK deps. Never throws — it fires
 *  real SDK calls, so the cron callback must `.catch` (a throw → unhandled
 *  rejection). */
async function tickWithRealDeps(log: TriageTickLog): Promise<void> {
  try {
    const db = getDatabase();
    await runTriageTick(
      {
        detect: () =>
          detectAnomalies({
            queryPrometheus,
            getStuckTaskCount: () => getStuckTaskCount(db),
          }),
        recentTriageExists: () => hasOpenTriageWithin(db, THROTTLE_HOURS),
        analyze: (anomalies) =>
          runTriageAnalysis(anomalies, { recentErrors: recentTaskErrors(db) }),
        persist: (report, anomalies, meta) =>
          persistTriageReport(db, report, anomalies, meta),
      },
      log,
    );
  } catch (err) {
    log.warn("[triage] tick failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Register (idempotent — stops any prior job first). */
export function registerTriageCron(log: TriageTickLog = NOOP_LOG): boolean {
  stopTriageCron();
  scheduledJob = cron.schedule(TRIAGE_CRON, () => void tickWithRealDeps(log), {
    timezone: RITUALS_TIMEZONE,
  });
  log.info(
    `registered self-healing triage cron (${TRIAGE_CRON}, ${RITUALS_TIMEZONE})`,
  );
  return true;
}

export function stopTriageCron(): void {
  if (scheduledJob) {
    try {
      scheduledJob.stop();
    } catch {
      /* node-cron stop is best-effort */
    }
    scheduledJob = null;
  }
}
