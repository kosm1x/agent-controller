/**
 * §14 nightly sycophancy-probe cron (in-process node-cron).
 *
 * Runs the 2-call sycophancy probe over a sample of recent judgments at 02:30
 * America/Mexico_City, then checks drift (opens/auto-resolves the
 * `v8-2-sycophancy-drift` recurring blocker). The DB singleton is already open
 * in-process, so it calls `runSycophancyProbe()` / `checkSycophancyDrift()`
 * directly (the standalone `scripts/run-sycophancy-probe.ts` exists for an
 * out-of-process run and does its own init/close).
 *
 * Registered ONLY when the V8.2 producer is armed (`isV82ProducerEnabled`) — and
 * dormant even then until the producer has written `judgments` rows
 * (`sampleJudgmentsForProbe` returns [] → ZERO LLM calls). Mirrors the
 * register/stop/run trio of `cohort/rollup-cron.ts`; `RITUALS_TIMEZONE` is
 * imported (never a hardcoded tz literal) so the probe can't split from the
 * other rituals.
 */

import cron, { type ScheduledTask } from "node-cron";
import { RITUALS_TIMEZONE } from "../../rituals/config.js";
import { runSycophancyProbe, checkSycophancyDrift } from "./sycophancy.js";

export interface ProbeCronLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}
const DEFAULT_LOG: ProbeCronLog = { info: () => {}, warn: () => {} };

/** 02:30 MX nightly — separate from the morning brief / probe budgets. */
const PROBE_CRON = "30 2 * * *";
const PROBE_TIMEZONE = RITUALS_TIMEZONE;

let scheduledJob: ScheduledTask | null = null;

/** Run one probe tick. Never throws — it fires real SDK calls, so the cron
 *  callback must `.catch` (a throw would become an unhandled rejection). */
async function runProbeTick(log: ProbeCronLog): Promise<void> {
  try {
    const results = await runSycophancyProbe();
    const drift = checkSycophancyDrift();
    log.info("sycophancy probe tick complete", {
      probed: results.length,
      drift: drift.drift,
      blockerOpened: drift.blockerOpened,
    });
  } catch (err) {
    log.warn("sycophancy probe tick failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Register (idempotent — stops any prior job first). */
export function registerSycophancyProbeCron(
  log: ProbeCronLog = DEFAULT_LOG,
): boolean {
  stopSycophancyProbeCron();
  scheduledJob = cron.schedule(PROBE_CRON, () => void runProbeTick(log), {
    timezone: PROBE_TIMEZONE,
  });
  log.info(
    `registered sycophancy probe cron (${PROBE_CRON}, ${PROBE_TIMEZONE})`,
  );
  return true;
}

export function stopSycophancyProbeCron(): void {
  if (scheduledJob) {
    try {
      scheduledJob.stop();
    } catch {
      /* node-cron stop is best-effort */
    }
    scheduledJob = null;
  }
}
