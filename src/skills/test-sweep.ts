/**
 * v7.7 Spine 3 Phase 2 Bundle 2 — S5 scheduled test sweep.
 *
 * Per spec §9: "Cron-driven (every 6h) test pass over all is_certified=1
 * skills. Failures decertify automatically (is_certified=0) and emit a
 * notification."
 *
 * Phase 2 ships the cron + the sweep itself. The "emit a notification"
 * decision (which channel — telegram? whatsapp? email?) is a Phase 5
 * operator-surface choice; this sweep logs decertifications via
 * structured pino + bumps the `mc_skills_test_runs_total` counter.
 * Operator can pull decertifications from `mc-ctl skill-health`.
 *
 * Idempotent registration: `registerSkillsTestSweepCron()` stops any
 * previously-registered job before installing a new one. Safe to call
 * on every boot.
 */

import cron, { type ScheduledTask } from "node-cron";
import { getDatabase } from "../db/index.js";
import { createLogger } from "../lib/logger.js";
import { runSkillTests } from "./test-runner.js";
import { RITUALS_TIMEZONE } from "../rituals/config.js";
import { errMsg } from "../lib/err-msg.js";

// Derive from the env-overridable canonical value — a hardcoded literal here
// would silently split this cron from the rituals if RITUALS_TIMEZONE is set.
const SWEEP_TIMEZONE = RITUALS_TIMEZONE;
// Every 6 hours starting at 02:00, 08:00, 14:00, 20:00 Mexico City.
// Offset from cost-ledger pulls / morning brief windows to spread CPU load.
const SWEEP_CRON = "0 2,8,14,20 * * *";

let scheduledJob: ScheduledTask | null = null;

export interface SweepLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

// DEFAULT_LOG bridges callers' (msg, fields) console-style signature to
// pino's (fields, msg) order. Tests pass `SILENT` directly; only the
// default path translates.
const moduleLog = createLogger("skills:sweep");
const DEFAULT_LOG: SweepLog = {
  info: (msg, fields) => moduleLog.info(fields ?? {}, msg),
  warn: (msg, fields) => moduleLog.warn(fields ?? {}, msg),
};

/**
 * Register the skill test sweep cron. Returns true if newly registered,
 * false if already registered.
 */
export function registerSkillsTestSweepCron(
  log: SweepLog = DEFAULT_LOG,
): boolean {
  stopSkillsTestSweepCron();
  scheduledJob = cron.schedule(
    SWEEP_CRON,
    () =>
      void runSkillsTestSweep(log).catch((err) => {
        log.warn("sweep tick failed", {
          error: errMsg(err),
        });
      }),
    { timezone: SWEEP_TIMEZONE },
  );
  log.info(`registered test sweep cron (${SWEEP_CRON}, ${SWEEP_TIMEZONE})`);
  return true;
}

export function stopSkillsTestSweepCron(): void {
  if (scheduledJob) {
    try {
      scheduledJob.stop();
    } catch {
      /* node-cron stop is best-effort */
    }
    scheduledJob = null;
  }
}

export interface SweepResult {
  /** Skills examined this tick (is_certified=1 AND active=1). */
  examined: number;
  /** Skills whose tests passed end-to-end. */
  reaffirmed: number;
  /** Skills whose tests failed → decertified this tick. */
  decertified: number;
  /** Skills that couldn't run (no current_version, malformed tests_json). */
  skipped: number;
}

/**
 * Run one sweep tick: iterate certified+active skills, re-run tests,
 * decertify failures.
 *
 * Exposed for direct invocation (testing, manual `mc-ctl skill-health
 * --sweep-now`). Idempotent — re-running on no-change skills just
 * re-affirms certification.
 */
export async function runSkillsTestSweep(
  log: SweepLog = DEFAULT_LOG,
): Promise<SweepResult> {
  const db = getDatabase();
  const candidates = db
    .prepare(
      `SELECT skill_id, name, current_version_id
       FROM skills
       WHERE is_certified = 1 AND active = 1 AND current_version_id IS NOT NULL`,
    )
    .all() as Array<{
    skill_id: string;
    name: string;
    current_version_id: number;
  }>;

  const result: SweepResult = {
    examined: 0,
    reaffirmed: 0,
    decertified: 0,
    skipped: 0,
  };

  for (const skill of candidates) {
    result.examined++;
    try {
      const outcome = await runSkillTests(
        skill.skill_id,
        skill.current_version_id,
      );
      if (outcome.outcomes.length === 0) {
        result.skipped++;
        log.warn("skill skipped (no tests or unparseable tests_json)", {
          skill: skill.name,
        });
        continue;
      }
      if (outcome.certified) {
        result.reaffirmed++;
      } else {
        result.decertified++;
        const failedNames = outcome.outcomes
          .filter((o) => o.result !== "pass")
          .map((o) => o.testName);
        log.warn("decertified — test sweep failed", {
          skill: skill.name,
          skill_id: skill.skill_id,
          version_id: skill.current_version_id,
          failed_tests: failedNames,
        });
      }
    } catch (err) {
      result.skipped++;
      log.warn("sweep run threw — skipping", {
        skill: skill.name,
        error: errMsg(err),
      });
    }
  }

  log.info("sweep complete", { ...result });
  return result;
}
