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
import {
  claimCertificationRun,
  releaseCertificationRun,
  runSkillTests,
} from "./test-runner.js";
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

/** Per-test LLM wall for the sweep; 3x the mini-runner default (see runSkillTests). */
export const SWEEP_TEST_TIMEOUT_MS = 90_000;

/**
 * Sweep ticks an uncertified version is retried: it drops out once any one
 * of its tests has this many error/timeout runs since that test's own last
 * pass, instead of costing LLM calls every 6 h forever.
 */
export const SWEEP_RETEST_RUNS = 3;

// Tests in the current version's tests_json; 0 when absent or malformed
// (CASE keeps json_array_length off invalid JSON, which would throw).
const TEST_COUNT_SQL = `(CASE WHEN json_valid(v.tests_json) THEN json_array_length(v.tests_json) ELSE 0 END)`;

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
  /** Skills examined this tick (active; certified or retest-eligible). */
  examined: number;
  /** Certified skills whose tests passed end-to-end. */
  reaffirmed: number;
  /** Certified skills whose tests failed → decertified this tick. */
  decertified: number;
  /** Uncertified skills whose retest passed → certified this tick. */
  recertified: number;
  /** Uncertified skills whose retest did not pass (they stay uncertified). */
  stillUncertified: number;
  /** Skills that couldn't run (no current_version, malformed tests_json). */
  skipped: number;
}

/**
 * Run one sweep tick: iterate active skills that are certified OR whose
 * current version never FAILED a test (only error/timeout runs, or none),
 * re-run tests, decertify failures. The second set is the recovery path: a
 * single 30 s LLM timeout decertified 5 healthy skills in May-June 2026 and,
 * with only certified skills swept, nothing ever re-tested them. A version
 * with a `fail` row stays out — it needs a new version — and so does one
 * with no tests, or with a test at SWEEP_RETEST_RUNS unfinished runs since
 * that test's last pass.
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
      `SELECT s.skill_id, s.name, s.current_version_id, s.is_certified
       FROM skills s
       LEFT JOIN skill_versions v ON v.id = s.current_version_id
       WHERE s.active = 1 AND s.current_version_id IS NOT NULL
         AND (s.is_certified = 1 OR (
           NOT EXISTS (
             SELECT 1 FROM skill_test_runs r
             WHERE r.version_id = s.current_version_id AND r.result = 'fail')
           AND ${TEST_COUNT_SQL} > 0
           -- no test has N unfinished runs since ITS OWN last pass (per
           -- test: a sibling test's pass must not reset a timing-out one)
           AND NOT EXISTS (
             SELECT 1 FROM skill_test_runs r
             WHERE r.version_id = s.current_version_id
               AND r.result IN ('error', 'timeout')
               AND r.ran_at >= COALESCE((
                 SELECT MAX(p.ran_at) FROM skill_test_runs p
                 WHERE p.version_id = r.version_id AND p.test_name = r.test_name
                   AND p.result = 'pass'), '')
             GROUP BY r.test_name
             HAVING COUNT(*) >= ?)))`,
    )
    .all(SWEEP_RETEST_RUNS) as Array<{
    skill_id: string;
    name: string;
    current_version_id: number;
    is_certified: number;
  }>;

  const result: SweepResult = {
    examined: 0,
    reaffirmed: 0,
    decertified: 0,
    recertified: 0,
    stillUncertified: 0,
    skipped: 0,
  };

  for (const skill of candidates) {
    result.examined++;
    // A kb-file write is certifying this version right now: its run decides.
    if (!claimCertificationRun(skill.current_version_id)) {
      result.skipped++;
      log.info("skill skipped (certification run in flight)", {
        skill: skill.name,
      });
      continue;
    }
    try {
      // Structured skills with multi-beat outputs (2026-09-12 screenwriting
      // set) run 25-27 s on Sonnet against the mini-runner's 30 s default;
      // a timeout here is not "pass" and would decertify a healthy skill.
      const outcome = await runSkillTests(
        skill.skill_id,
        skill.current_version_id,
        { timeoutMs: SWEEP_TEST_TIMEOUT_MS },
      );
      if (outcome.outcomes.length === 0) {
        result.skipped++;
        log.warn("skill skipped (no tests or unparseable tests_json)", {
          skill: skill.name,
        });
        continue;
      }
      if (skill.is_certified !== 1) {
        if (outcome.certified) {
          result.recertified++;
          log.info("recertified — retest passed", { skill: skill.name });
        } else {
          result.stillUncertified++;
          log.warn("retest did not pass — still uncertified", {
            skill: skill.name,
            version_id: skill.current_version_id,
            results: outcome.outcomes.map((o) => `${o.testName}:${o.result}`),
          });
        }
      } else if (outcome.certified) {
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
    } finally {
      releaseCertificationRun(skill.current_version_id);
    }
  }

  log.info("sweep complete", { ...result });
  return result;
}
