/**
 * CLI entry point for running a baseline evaluation.
 *
 * Usage: npx tsx src/tuning/baseline.ts [--seed] [--category=scope_accuracy]
 *
 * Flags:
 *   --seed              Seed test cases from seed-cases.json before running
 *   --category=<cat>    Only evaluate a specific category
 *   --dry-run           Only run free evals (scope + classification), skip LLM calls
 */

import { initDatabase } from "../db/index.js";
import { seedTestCases } from "./test-cases.js";
import { runEvaluation, type InferFunction } from "./eval-runner.js";
import { insertRun, updateRun, countTestCases } from "./schema.js";
import type { TestCaseCategory, EvalFilter } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldSeed = args.includes("--seed");
  const dryRun = args.includes("--dry-run");
  const categoryArg = args.find((a) => a.startsWith("--category="));
  const category = categoryArg?.split("=")[1] as TestCaseCategory | undefined;

  // Initialize database — use MC_DB_PATH env or default
  const dbPath = process.env.MC_DB_PATH ?? "./data/mc.db";
  initDatabase(dbPath);

  // Seed if requested or if no test cases exist
  const count = countTestCases();
  if (shouldSeed || count === 0) {
    seedTestCases();
  }

  const finalCount = countTestCases();
  console.log(`\n[baseline] ${finalCount} active test cases`);

  // Build filter
  const filter: EvalFilter = {};
  if (category) {
    filter.category = category;
    console.log(`[baseline] Filtering to category: ${category}`);
  }

  // Dry-run: only run free evals (scope + classification)
  let inferFn: InferFunction | undefined;
  if (dryRun) {
    console.log(
      "[baseline] Dry run — skipping LLM calls (tool_selection scored as 0)",
    );
    inferFn = async () => ({ toolsCalled: [], tokensUsed: 0 });
  }

  // Create run record
  const runId = `baseline-${Date.now()}`;
  insertRun({
    run_id: runId,
    status: "running",
    baseline_score: null,
    best_score: null,
    experiments_run: 0,
    experiments_won: 0,
    total_cost_usd: 0,
    report: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  console.log(`[baseline] Running evaluation (run_id: ${runId})...\n`);

  // Run evaluation
  const result = await runEvaluation({}, filter, inferFn);

  // Update run record
  updateRun(runId, {
    status: "completed",
    baseline_score: result.compositeScore,
    best_score: result.compositeScore,
    total_cost_usd: result.estimatedCostUsd,
    completed_at: new Date().toISOString(),
  });

  // Print results
  console.log("═══════════════════════════════════════════");
  console.log("  JARVIS SELF-TUNING — BASELINE RESULTS");
  console.log("═══════════════════════════════════════════\n");
  console.log(
    `  Composite Score:    ${result.compositeScore.toFixed(1)} / 100`,
  );
  console.log(
    `  Tool Selection:     ${result.subscores.toolSelection.toFixed(1)} / 100 (weight: 50%)`,
  );
  console.log(
    `  Scope Accuracy:     ${result.subscores.scopeAccuracy.toFixed(1)} / 100 (weight: 30%)`,
  );
  console.log(
    `  Classification:     ${result.subscores.classification.toFixed(1)} / 100 (weight: 20%)`,
  );
  console.log(`\n  Cases evaluated:    ${result.perCase.length}`);
  console.log(`  Tokens used:        ${result.totalTokens}`);
  console.log(`  Estimated cost:     $${result.estimatedCostUsd.toFixed(2)}`);
  console.log(
    `  Duration:           ${(result.durationMs / 1000).toFixed(1)}s`,
  );

  // Show worst cases
  const worstCases = [...result.perCase]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
  if (worstCases.length > 0 && worstCases[0].score < 1.0) {
    console.log("\n  Worst cases:");
    for (const c of worstCases) {
      if (c.score >= 1.0) break;
      console.log(
        `    ${c.caseId}: ${(c.score * 100).toFixed(0)}% (${c.category})`,
      );
    }
  }

  console.log("\n═══════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("[baseline] Error:", err);
  process.exit(1);
});
