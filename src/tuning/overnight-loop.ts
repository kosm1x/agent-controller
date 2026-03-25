/**
 * Overnight loop engine — the autoresearch-inspired experiment loop.
 *
 * Runs baseline eval → meta-agent proposes mutation → targeted re-eval →
 * keep/discard → repeat until budget/time/stall limits hit.
 */

import type {
  TuningSurface,
  SandboxConfig,
  Mutation,
  EvalResult,
  TuneRun,
  CaseScore,
} from "./types.js";
import {
  insertRun,
  updateRun,
  insertExperiment,
  getExperimentsByRun,
  getRecentExperiments,
} from "./schema.js";
import { runEvaluation, type InferFunction } from "./eval-runner.js";
import {
  proposeMutation,
  type MetaInferFunction,
  type MetaAgentContext,
} from "./meta-agent.js";
import { CostTracker } from "./cost-tracker.js";
import { generateReport } from "./report.js";
import { computeCompositeScore } from "./scorer.js";
import { DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";
import { toolRegistry } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TuningConfig {
  maxExperiments: number;
  maxCostUsd: number;
  maxDurationMs: number;
  minDeltaToKeep: number;
  stalledAfterN: number;
  surfaces: TuningSurface[];
  /** Injectable inference for tool_selection evals (testing). */
  evalInferFn?: InferFunction;
  /** Injectable inference for meta-agent (testing). */
  metaInferFn?: MetaInferFunction;
}

const DEFAULT_CONFIG: TuningConfig = {
  maxExperiments: 25,
  maxCostUsd: 25.0,
  maxDurationMs: 8 * 60 * 60 * 1000, // 8 hours
  minDeltaToKeep: 0.5,
  stalledAfterN: 5,
  surfaces: ["tool_description", "scope_rule"],
};

// ---------------------------------------------------------------------------
// Mutation application
// ---------------------------------------------------------------------------

/** Get the current value for a mutation target. */
function getCurrentValue(mutation: Mutation): string {
  switch (mutation.surface) {
    case "tool_description": {
      const tool = toolRegistry.get(mutation.target);
      return tool?.definition.function.description ?? "(not found)";
    }
    case "scope_rule": {
      const pattern = DEFAULT_SCOPE_PATTERNS.find(
        (p) => p.group === mutation.target,
      );
      return pattern?.pattern.source ?? "(not found)";
    }
    default:
      return "(unsupported surface)";
  }
}

/** Apply a mutation to create a sandbox config. */
function applySandbox(
  currentSandbox: SandboxConfig,
  mutation: Mutation,
): SandboxConfig {
  const sandbox: SandboxConfig = {
    toolDescriptionOverrides: new Map(
      currentSandbox.toolDescriptionOverrides ?? [],
    ),
    scopePatternOverrides: currentSandbox.scopePatternOverrides
      ? [...currentSandbox.scopePatternOverrides]
      : undefined,
  };

  switch (mutation.surface) {
    case "tool_description": {
      sandbox.toolDescriptionOverrides!.set(
        mutation.target,
        mutation.mutated_value,
      );
      break;
    }
    case "scope_rule": {
      // Build new patterns array with the mutated regex
      const basePatterns = sandbox.scopePatternOverrides ?? [
        ...DEFAULT_SCOPE_PATTERNS,
      ];
      try {
        const newRegex = new RegExp(mutation.mutated_value, "i");
        const idx = basePatterns.findIndex((p) => p.group === mutation.target);
        if (idx >= 0) {
          basePatterns[idx] = { pattern: newRegex, group: mutation.target };
        } else {
          basePatterns.push({ pattern: newRegex, group: mutation.target });
        }
        sandbox.scopePatternOverrides = basePatterns;
      } catch {
        console.warn(
          `[tuning] Invalid regex in mutation: ${mutation.mutated_value}`,
        );
      }
      break;
    }
  }

  return sandbox;
}

/** Identify test cases affected by a mutation (for targeted re-eval). */
function identifyAffectedCases(
  mutation: Mutation,
  allCases: CaseScore[],
): string[] {
  switch (mutation.surface) {
    case "tool_description": {
      // Re-eval tool_selection cases that involve this tool
      const toolName = mutation.target;
      return allCases
        .filter((c) => {
          if (c.category !== "tool_selection") return false;
          const details = c.details as Record<string, unknown>;
          const expected = (details.expected as string[]) ?? [];
          const forbidden = (details.forbidden as string[]) ?? [];
          return expected.includes(toolName) || forbidden.includes(toolName);
        })
        .map((c) => c.caseId);
    }
    case "scope_rule": {
      // Re-eval all scope_accuracy cases (patterns affect all)
      return allCases
        .filter((c) => c.category === "scope_accuracy")
        .map((c) => c.caseId);
    }
    default:
      // Unknown surface — re-eval everything
      return allCases.map((c) => c.caseId);
  }
}

/**
 * Recompute composite score by merging new targeted results into cached baseline.
 */
function mergeResults(baseline: EvalResult, targeted: EvalResult): EvalResult {
  // Build map of baseline per-case scores
  const caseMap = new Map<string, CaseScore>();
  for (const c of baseline.perCase) {
    caseMap.set(c.caseId, c);
  }
  // Override with targeted results
  for (const c of targeted.perCase) {
    caseMap.set(c.caseId, c);
  }

  const mergedCases = [...caseMap.values()];

  const { compositeScore, subscores } = computeCompositeScore(mergedCases);

  return {
    compositeScore,
    subscores,
    perCase: mergedCases,
    totalTokens: baseline.totalTokens + targeted.totalTokens,
    estimatedCostUsd: baseline.estimatedCostUsd + targeted.estimatedCostUsd,
    durationMs: baseline.durationMs + targeted.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runOvernightTuning(
  config: Partial<TuningConfig> = {},
): Promise<TuneRun> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startMs = Date.now();
  const runId = `tune-${Date.now()}`;
  const cost = new CostTracker(cfg.maxCostUsd);

  console.log(`\n[tuning] Starting overnight run ${runId}`);
  console.log(
    `[tuning] Config: ${cfg.maxExperiments} max experiments, $${cfg.maxCostUsd} budget, ${cfg.surfaces.join("+")}`,
  );

  // Create run record
  const run: TuneRun = {
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
  };
  insertRun(run);

  // --- Step 1: Baseline evaluation ---
  console.log("[tuning] Running baseline evaluation...");
  const baseline = await runEvaluation({}, undefined, cfg.evalInferFn);
  cost.recordEvaluation(baseline.totalTokens, baseline.estimatedCostUsd);

  run.baseline_score = baseline.compositeScore;
  run.best_score = baseline.compositeScore;
  updateRun(runId, {
    baseline_score: baseline.compositeScore,
    best_score: baseline.compositeScore,
    total_cost_usd: cost.getTotalCost(),
  });

  console.log(`[tuning] Baseline: ${baseline.compositeScore.toFixed(1)} / 100`);

  // --- Step 2: Experiment loop ---
  let bestScore = baseline.compositeScore;
  let bestSandbox: SandboxConfig = {};
  let consecutiveRegressions = 0;
  let experimentsRun = 0;
  let experimentsWon = 0;

  for (let i = 0; i < cfg.maxExperiments; i++) {
    // Check stopping conditions
    if (!cost.hasBudget()) {
      console.log("[tuning] Budget exceeded — stopping");
      run.status = "budget_exceeded";
      break;
    }
    if (Date.now() - startMs > cfg.maxDurationMs) {
      console.log("[tuning] Time limit reached — stopping");
      run.status = "completed";
      break;
    }
    if (consecutiveRegressions >= cfg.stalledAfterN) {
      console.log(
        `[tuning] Stalled after ${cfg.stalledAfterN} consecutive regressions — stopping`,
      );
      run.status = "completed";
      break;
    }

    console.log(`\n[tuning] === Experiment ${i + 1}/${cfg.maxExperiments} ===`);

    // Get recent experiment history for context
    const history = getRecentExperiments(20);

    // Ask meta-agent for a mutation
    const ctx: MetaAgentContext = {
      compositeScore: bestScore,
      worstCases: baseline.perCase.filter((c) => c.score < 1.0),
      experimentHistory: history,
      surfaces: cfg.surfaces,
    };

    const { mutation, tokensUsed: metaTokens } = await proposeMutation(
      ctx,
      cfg.metaInferFn,
    );
    cost.recordMetaAgent(metaTokens);

    if (!mutation) {
      console.warn(
        "[tuning] Meta-agent failed to propose a mutation — skipping",
      );
      consecutiveRegressions++;
      continue;
    }

    console.log(
      `[tuning] Proposed: ${mutation.surface}/${mutation.target} — ${mutation.hypothesis}`,
    );

    // Get current value for recording
    const originalValue = getCurrentValue(mutation);

    // Apply mutation to sandbox
    const sandbox = applySandbox(bestSandbox, mutation);

    // Identify affected cases for targeted re-eval
    const affectedCaseIds = identifyAffectedCases(mutation, baseline.perCase);
    console.log(
      `[tuning] Re-evaluating ${affectedCaseIds.length} affected cases`,
    );

    // Run targeted evaluation
    let targeted: EvalResult;
    try {
      targeted = await runEvaluation(
        sandbox,
        { caseIds: affectedCaseIds },
        cfg.evalInferFn,
      );
    } catch (err) {
      console.error(`[tuning] Evaluation error: ${err}`);
      const expId = `${runId}-exp-${i}`;
      insertExperiment({
        experiment_id: expId,
        run_id: runId,
        surface: mutation.surface,
        target: mutation.target,
        mutation_type: mutation.mutation_type,
        original_value: originalValue,
        mutated_value: mutation.mutated_value,
        hypothesis: mutation.hypothesis,
        baseline_score: bestScore,
        mutated_score: null,
        status: "error",
      });
      experimentsRun++;
      consecutiveRegressions++;
      continue;
    }

    cost.recordEvaluation(targeted.totalTokens, targeted.estimatedCostUsd);

    // Merge targeted results into baseline to get full composite
    const merged = mergeResults(baseline, targeted);
    const newScore = merged.compositeScore;
    const delta = newScore - bestScore;

    // Record experiment
    const expId = `${runId}-exp-${i}`;
    const passed = delta >= cfg.minDeltaToKeep;
    const status = passed ? "passed" : "regressed";

    insertExperiment({
      experiment_id: expId,
      run_id: runId,
      surface: mutation.surface,
      target: mutation.target,
      mutation_type: mutation.mutation_type,
      original_value: originalValue,
      mutated_value: mutation.mutated_value,
      hypothesis: mutation.hypothesis,
      baseline_score: bestScore,
      mutated_score: newScore,
      status,
    });

    experimentsRun++;

    if (passed) {
      console.log(
        `[tuning] ✓ KEEP: ${bestScore.toFixed(1)} → ${newScore.toFixed(1)} (+${delta.toFixed(1)})`,
      );
      bestScore = newScore;
      bestSandbox = sandbox;
      experimentsWon++;
      consecutiveRegressions = 0;
    } else {
      console.log(
        `[tuning] ✗ DISCARD: ${newScore.toFixed(1)} (delta ${delta.toFixed(1)} < ${cfg.minDeltaToKeep})`,
      );
      consecutiveRegressions++;
    }

    // Update run record incrementally
    updateRun(runId, {
      best_score: bestScore,
      experiments_run: experimentsRun,
      experiments_won: experimentsWon,
      total_cost_usd: cost.getTotalCost(),
    });
  }

  // --- Step 3: Generate report ---
  if (run.status === "running") run.status = "completed";

  const experiments = getExperimentsByRun(runId);
  const report = generateReport(
    {
      ...run,
      best_score: bestScore,
      experiments_run: experimentsRun,
      experiments_won: experimentsWon,
      total_cost_usd: cost.getTotalCost(),
    },
    experiments,
  );

  updateRun(runId, {
    status: run.status,
    best_score: bestScore,
    experiments_run: experimentsRun,
    experiments_won: experimentsWon,
    total_cost_usd: cost.getTotalCost(),
    report,
    completed_at: new Date().toISOString(),
  });

  console.log(
    `\n[tuning] Run complete: ${baseline.compositeScore.toFixed(1)} → ${bestScore.toFixed(1)}`,
  );
  console.log(
    `[tuning] ${experimentsRun} experiments, ${experimentsWon} wins, $${cost.getTotalCost().toFixed(2)} spent`,
  );
  console.log(
    `[tuning] Report stored in tune_runs.report for run_id: ${runId}`,
  );

  return {
    run_id: runId,
    status: run.status,
    baseline_score: baseline.compositeScore,
    best_score: bestScore,
    experiments_run: experimentsRun,
    experiments_won: experimentsWon,
    total_cost_usd: cost.getTotalCost(),
    report,
    started_at: run.started_at,
    completed_at: new Date().toISOString(),
  };
}
