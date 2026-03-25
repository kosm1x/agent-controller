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
import { submitTask } from "../dispatch/dispatcher.js";

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

  try {
    const result = await runOvernightTuning({
      maxExperiments: config.tuningMaxExperiments,
      maxCostUsd: config.tuningMaxCostUsd,
    });

    // Submit a summary task for Telegram broadcast
    if (result.report) {
      const summary =
        result.experiments_won > 0
          ? `Found ${result.experiments_won} improvements (${result.baseline_score?.toFixed(1)} → ${result.best_score?.toFixed(1)})`
          : `No improvements found (score: ${result.baseline_score?.toFixed(1)})`;

      await submitTask({
        title: `Overnight tuning — ${new Date().toLocaleDateString("en-CA")}`,
        description: `Deliver this overnight tuning report to Fede via Telegram. Be concise — just send the key findings.

${summary}

Full report:
${result.report}

STATUS: DONE`,
        agentType: "fast",
      });
    }

    console.log(
      `[rituals] overnight-tuning: completed (${result.experiments_won} wins)`,
    );
  } catch (err) {
    console.error("[rituals] overnight-tuning: failed —", err);
  }
}
