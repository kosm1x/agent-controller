/**
 * Partial re-execution — reset a goal and its dependents, re-run only those.
 *
 * Upstream completed goals keep their cached results (feeding context to
 * downstream goals via buildContextFromResults). Only the target goal
 * and its transitive dependents re-execute.
 */

import { randomUUID } from "crypto";
import { GoalGraph } from "./goal-graph.js";
import { IterationBudget } from "./budget.js";
import { GoalStatus, defaultConfig } from "./types.js";
import type {
  OrchestratorConfig,
  OrchestratorResult,
  GoalResult,
  ExecutionResult,
} from "./types.js";
import { executeGraph } from "./executor.js";
import { reflect } from "./reflector.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reset a goal and all its transitive dependents to PENDING.
 * Returns the list of reset goal IDs (target + dependents).
 */
export function resetFromGoal(graph: GoalGraph, goalId: string): string[] {
  const dependents = graph.getDependents(goalId);
  const toReset = [goalId, ...dependents];

  for (const id of toReset) {
    graph.updateStatus(id, GoalStatus.PENDING);
  }

  return toReset;
}

/**
 * Re-execute from a specific goal, keeping upstream results cached.
 * Skips the plan phase — the graph already exists from the prior run.
 */
export async function resumeFromGoal(
  taskId: string,
  taskDescription: string,
  goalId: string,
  priorResult: OrchestratorResult,
  config?: Partial<OrchestratorConfig>,
  toolNames?: string[],
): Promise<OrchestratorResult> {
  const cfg = defaultConfig(config);
  const budget = new IterationBudget(cfg.maxIterations);
  const start = Date.now();

  // Restore graph and reset target + dependents
  const graph = GoalGraph.fromJSON(priorResult.goalGraph);
  const resetIds = resetFromGoal(graph, goalId);
  const resetSet = new Set(resetIds);

  console.log(
    `[resume] Task ${taskId}: re-executing from ${goalId}, reset ${resetIds.length} goals: ${resetIds.join(", ")}`,
  );

  // Keep prior results for non-reset goals (feeds buildContextFromResults)
  const keptResults: Record<string, GoalResult> = {};
  for (const [id, result] of Object.entries(
    priorResult.executionResults.goalResults,
  )) {
    if (!resetSet.has(id)) {
      keptResults[id] = result;
    }
  }

  // Execute — getReady() skips completed goals naturally
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), cfg.timeoutMs);

  let execResult: ExecutionResult;
  try {
    execResult = await executeGraph(
      graph,
      toolNames,
      budget,
      cfg.goalTimeoutMs,
      timeoutController.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  // Merge: kept prior results + newly executed results
  const mergedGoalResults = {
    ...keptResults,
    ...execResult.goalResults,
  };

  const mergedExecResult: ExecutionResult = {
    goalResults: mergedGoalResults,
    summary: graph.summary(),
    totalToolCalls: execResult.totalToolCalls,
    totalToolNames: execResult.totalToolNames,
    totalToolFailures: execResult.totalToolFailures,
    tokenUsage: execResult.tokenUsage,
    toolRepairs: execResult.toolRepairs,
    provenanceRecords: execResult.provenanceRecords,
  };

  // Reflect on merged results
  const { result: reflection, usage: reflectUsage } = await reflect(
    taskDescription,
    graph,
    mergedExecResult,
    taskId,
  );

  return {
    success: reflection.success,
    goalGraph: graph.toJSON(),
    executionResults: mergedExecResult,
    reflection,
    trace: [
      {
        type: "resumed_from_goal",
        timestamp: start,
        goalId,
        resetGoals: resetIds,
      },
    ],
    traceId: randomUUID(),
    durationMs: Date.now() - start,
    tokenUsage: {
      promptTokens:
        execResult.tokenUsage.promptTokens + reflectUsage.promptTokens,
      completionTokens:
        execResult.tokenUsage.completionTokens + reflectUsage.completionTokens,
    },
    iterationsUsed: budget.consumed,
  };
}
