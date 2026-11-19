/**
 * The optional scheduled jobs registered at boot. Each block loads its job
 * module with a dynamic import, registers the job, and logs a non-fatal
 * warning when the load or the registration fails; some blocks sit behind an
 * environment switch, read when this function runs (never at module load).
 *
 * The jobs are requested in the order the blocks are written, and nothing
 * waits for them: every import is fire-and-forget, so this function is
 * synchronous and returns nothing. Called once from main(), after the
 * read-back verifiers are registered and before the intel collectors start.
 */
import type { createLogger } from "./lib/logger.js";
import { isTriageMonitorEnabled } from "./lib/self-healing/flags.js";
import { isXProbeEnabled } from "./lib/x-poster/config.js";
import { errMsg } from "./lib/err-msg.js";

export function registerOptionalCrons(
  log: ReturnType<typeof createLogger>,
): void {
  // v6.2 M1: Register weekly KB confidence decay sweep
  import("./memory/lesson-decay.js")
    .then(({ registerDecayCron }) => registerDecayCron())
    .catch((err) => {
      console.warn(
        "[lesson-decay] Registration failed (non-fatal):",
        errMsg(err),
      );
    });

  // v7.7 Spine 2 (S3 substrate): register drift-detector cron jobs.
  // Seeds 13 signals on first boot (idempotent on subsequent boots).
  // Registration failure is non-fatal — service runs without drift watching.
  import("./lib/s3/scheduler.js")
    .then(({ registerS3CronJobs }) => registerS3CronJobs())
    .catch((err) => {
      console.warn("[s3] Cron registration failed (non-fatal):", errMsg(err));
    });

  // v7.7 Spine 3 Phase 2 Bundle 2: register skill test sweep cron.
  // Every 6h re-runs tests against is_certified=1 active skills;
  // decertifies on any failure. Non-fatal if registration fails.
  if (process.env.JARVIS_SKILLS_TEST_SWEEP_DISABLED !== "true") {
    import("./skills/test-sweep.js")
      .then(({ registerSkillsTestSweepCron }) =>
        registerSkillsTestSweepCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[skills] Test sweep cron registration failed (non-fatal)",
        );
      });
  }

  // v7.7 Spine 5 Bundle 2: register the Conway Pattern 2 cohort roll-up
  // cron. Daily at 05:00 MX re-derives the self-defining cohort (projects +
  // objectives) ahead of the morning brief. Non-fatal if registration fails.
  if (process.env.JARVIS_COHORT_ROLLUP_DISABLED !== "true") {
    import("./cohort/rollup-cron.js")
      .then(({ registerCohortRollupCron }) =>
        registerCohortRollupCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[cohort] Roll-up cron registration failed (non-fatal)",
        );
      });
  }

  // Hourly prune for both checkpoint stores. Closes the lazy-only-TTL gap
  // (Hermes v0.13 "Checkpoints v2 real pruning"). Non-fatal if registration
  // fails — the lazy paths still enforce TTL on every load.
  import("./runners/checkpoint-prune-cron.js")
    .then(({ registerCheckpointPruneCron }) =>
      registerCheckpointPruneCron({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        "[checkpoint] prune cron registration failed (non-fatal)",
      );
    });

  // Saturday refresh of the weekly bars alpha_run / backtest_run read. Nothing
  // else writes them on a schedule (frozen 04-17 → 09-18). Non-fatal.
  import("./finance/weekly-refresh-cron.js")
    .then(({ registerWeeklyRefreshCron }) =>
      registerWeeklyRefreshCron({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        "[weekly-refresh] cron registration failed (non-fatal)",
      );
    });

  // Daily tasks/runs retention (04:30 local, 90d window — operator-approved
  // 2026-07-05). Archives to data/archive/*.jsonl.gz then deletes in batched
  // transactions; in-flight tasks and parents with surviving children are
  // never touched (see db/retention.ts). Non-fatal if registration fails.
  import("./db/retention-cron.js")
    .then(({ registerRetentionCron }) =>
      registerRetentionCron({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
      }),
    )
    .catch((err) => {
      log.warn({ err }, "[retention] cron registration failed (non-fatal)");
    });

  // V8.2 §14 nightly sycophancy probe (02:30 MX). Registered only when the
  // judgment-assembly producer is armed (V82_JUDGMENT_PRODUCER_ENABLED=true);
  // dormant even then until judgments exist (zero LLM calls on an empty window).
  // Non-fatal if registration fails.
  if (process.env.V82_JUDGMENT_PRODUCER_ENABLED === "true") {
    import("./lib/v8-2/probe-cron.js")
      .then(({ registerSycophancyProbeCron }) =>
        registerSycophancyProbeCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[v8.2] sycophancy probe cron registration failed (non-fatal)",
        );
      });
  }

  // Proactive X (Twitter) auth probe (daily MX). Read-only: probes the posting
  // backends' auth, records mc_x_backend_healthy, and notifies the operator on a
  // healthy→unhealthy transition (cookies expiring) BEFORE a post 401s. Registered
  // only when X_PROBE_ENABLED=true, so it ships dormant. Non-fatal if it fails.
  if (isXProbeEnabled()) {
    import("./lib/x-poster/probe-cron.js")
      .then(({ registerXProbeCron }) =>
        registerXProbeCron({
          info: (msg) => log.info(msg),
          warn: (msg) => log.warn(msg),
        }),
      )
      .catch((err) => {
        log.warn({ err }, "[x-probe] cron registration failed (non-fatal)");
      });
  }

  // Self-healing triage monitor (every 6h MX). Read-only: detects health
  // anomalies, has a sub-agent root-cause them, persists a triage report —
  // NEVER remediates. Registered only when SELF_HEALING_TRIAGE_ENABLED=true, so
  // it ships dormant. Non-fatal if registration fails.
  if (isTriageMonitorEnabled()) {
    import("./lib/self-healing/triage-cron.js")
      .then(({ registerTriageCron }) =>
        registerTriageCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[self-healing] triage cron registration failed (non-fatal)",
        );
      });
  }
}
