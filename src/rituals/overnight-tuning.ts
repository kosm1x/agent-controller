/**
 * Overnight tuning ritual — runs the self-tuning experiment loop.
 *
 * Unlike other rituals that submit tasks to the fast-runner, this one
 * runs the overnight loop directly as an async function because the
 * loop needs 25+ cycles with state carried across them — exceeding
 * the fast-runner's 7-round limit.
 *
 * After completion, submits a summary task for Telegram broadcast.
 */

import { getConfig } from "../config.js";
import { seedTestCases } from "../tuning/test-cases.js";
import { countTestCases } from "../tuning/schema.js";
import { runOvernightTuning } from "../tuning/overnight-loop.js";
import { getRouter } from "../messaging/index.js";
import { mineTestCases } from "../tuning/case-miner.js";
import { computeAllBaselines } from "../intel/baselines.js";

/**
 * Execute the overnight tuning run.
 * Called directly from the ritual scheduler (not via submitTask).
 */
export async function executeOvernightTuning(): Promise<void> {
  const config = getConfig();

  if (!config.tuningEnabled) {
    console.log(
      "[rituals] overnight-tuning: TUNING_ENABLED is false, skipping",
    );
    return;
  }

  console.log("[rituals] overnight-tuning: starting");

  // Ensure test cases are seeded
  if (countTestCases() === 0) {
    seedTestCases();
  }

  // Mine new test cases from scope telemetry before running the loop
  try {
    mineTestCases();
  } catch (err) {
    console.warn("[rituals] case mining failed (non-fatal):", err);
  }

  // Compute Intel Depot baselines (rolling stats for z-score anomaly detection)
  try {
    computeAllBaselines();
    console.log("[rituals] overnight-tuning: Intel baselines computed");
  } catch (err) {
    console.warn("[rituals] baseline computation failed (non-fatal):", err);
  }

  try {
    const result = await runOvernightTuning({
      maxExperiments: config.tuningMaxExperiments,
      maxCostUsd: config.tuningMaxCostUsd,
    });

    // Deliver the report straight to the owner's channels. The report is already
    // rendered, so we broadcast it directly (router.broadcastToAll) like every
    // other ritual (diff-digest, market scans, canary) — NOT via a "deliver this"
    // LLM task. The old submitTask path spun up a fast-runner agent that, lacking a
    // telegram_send tool, reverse-engineered mission-control's own code, lifted the
    // bot token from .env, and shelled out a raw curl/python send — 17 turns, ~$1,
    // and a secret in the logs (2026-06-20). Direct broadcast is deterministic,
    // free, and leaks nothing.
    if (result.report) {
      const summary =
        result.experiments_won > 0
          ? `Found ${result.experiments_won} improvements (${result.baseline_score?.toFixed(1)} → ${result.best_score?.toFixed(1)})`
          : `No improvements found (score: ${result.baseline_score?.toFixed(1)})`;

      const message = `🔧 Overnight Tuning — ${new Date().toLocaleDateString("en-CA")}\n\n${summary}\n\n${result.report}`;

      const router = getRouter();
      if (router) {
        await router.broadcastToAll(message);
      } else {
        console.log(
          "[rituals] overnight-tuning: no messaging router — report not delivered",
        );
      }
    }

    console.log(
      `[rituals] overnight-tuning: completed (${result.experiments_won} wins)`,
    );
  } catch (err) {
    console.error("[rituals] overnight-tuning: failed —", err);
  }
}
