/**
 * CLI entry point for running the overnight tuning loop.
 *
 * Usage: npx tsx src/tuning/run.ts [options]
 *
 * Flags:
 *   --max-experiments=N   Max experiments (default 25)
 *   --max-cost=N          Max cost in USD (default 25)
 *   --dry-run             Use mock inference (no real LLM calls)
 *   --seed                Seed test cases before running
 */

import { initDatabase } from "../db/index.js";
import { seedTestCases } from "./test-cases.js";
import { countTestCases } from "./schema.js";
import { runOvernightTuning, type TuningConfig } from "./overnight-loop.js";
import type { InferFunction } from "./eval-runner.js";
import type { MetaInferFunction } from "./meta-agent.js";

function parseIntArg(
  args: string[],
  prefix: string,
  defaultVal: number,
): number {
  const arg = args.find((a) => a.startsWith(prefix));
  if (!arg) return defaultVal;
  const val = parseInt(arg.split("=")[1], 10);
  return isNaN(val) ? defaultVal : val;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const shouldSeed = args.includes("--seed");
  const maxExperiments = parseIntArg(args, "--max-experiments=", 25);
  const maxCost = parseIntArg(args, "--max-cost=", 25);

  // Initialize database
  const dbPath = process.env.MC_DB_PATH ?? "./data/mc.db";
  initDatabase(dbPath);

  // Seed if needed
  const count = countTestCases();
  if (shouldSeed || count === 0) {
    seedTestCases();
  }

  console.log(`[tune:run] ${countTestCases()} active test cases`);

  // Build config
  const config: Partial<TuningConfig> = {
    maxExperiments,
    maxCostUsd: maxCost,
  };

  if (dryRun) {
    console.log("[tune:run] Dry run mode — using mock inference");

    // Mock eval inference: returns empty tools (tool_selection scores 0)
    const mockEvalInfer: InferFunction = async () => ({
      toolsCalled: [],
      tokensUsed: 0,
    });

    // Mock meta-agent: proposes a scope_rule fix for "coding" group
    let callCount = 0;
    const mockMetaInfer: MetaInferFunction = async () => {
      callCount++;
      // Alternate between two mutations for dry-run demo
      if (callCount % 2 === 1) {
        return {
          content: JSON.stringify({
            surface: "scope_rule",
            target: "coding",
            mutation_type: "adjust",
            mutated_value:
              "\\b(c[oó]digo|code|archivos?|files?|docker|containers?|scripts?|deploy|edita|grep|busca(r)?\\s+en|estructura|directori|carpetas?|servers?|servidores?|git|npm|build|test|lint|bug|error|fix|debug)",
            hypothesis: "Add docker/container keywords to coding scope pattern",
          }),
          tokensUsed: 500,
        };
      }
      return {
        content: JSON.stringify({
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(c[oó]digo|code|archivos?|files?|scripts?|deploy)",
          hypothesis: "Simplify coding scope (test regression detection)",
        }),
        tokensUsed: 500,
      };
    };

    config.evalInferFn = mockEvalInfer;
    config.metaInferFn = mockMetaInfer;
    config.maxExperiments = Math.min(maxExperiments, 5); // Cap dry runs
    config.stalledAfterN = 10; // Don't stall on dry runs
  }

  const result = await runOvernightTuning(config);

  console.log("\n" + (result.report ?? "No report generated"));
}

main().catch((err) => {
  console.error("[tune:run] Error:", err);
  process.exit(1);
});
