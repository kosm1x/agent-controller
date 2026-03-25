/**
 * Orchestrator — Top-level Plan-Execute-Reflect loop.
 *
 * Wires the three phases together: plans a task into a goal graph,
 * executes goals with dependency ordering, reflects on results.
 * Supports automatic replanning on failure thresholds.
 */

import { randomUUID } from "crypto";
import { GoalGraph } from "./goal-graph.js";
import { IterationBudget } from "./budget.js";
import { Phase, defaultConfig } from "./types.js";
import type {
  OrchestratorConfig,
  OrchestratorResult,
  RunTrace,
  ExecutionResult,
} from "./types.js";
import { plan, replan } from "./planner.js";
import { executeGraph } from "./executor.js";
import { setMemoryTaskContext } from "../tools/builtin/memory.js";
import { reflect } from "./reflector.js";
import { eventBus } from "../lib/event-bus.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full Plan-Execute-Reflect loop for a task.
 */
export async function orchestrate(
  taskId: string,
  taskDescription: string,
  config?: Partial<OrchestratorConfig>,
  toolNames?: string[],
): Promise<OrchestratorResult> {
  const cfg = defaultConfig(config);
  const trace = createTrace();
  const budget = new IterationBudget(cfg.maxIterations);

  // Governance: set task context for memory store rate limiting
  setMemoryTaskContext(taskId);

  try {
    let replanCount = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Global timeout — abort the entire orchestration
    const timeoutController = new AbortController();
    const globalTimer = setTimeout(
      () => timeoutController.abort(),
      cfg.timeoutMs,
    );

    // --- PLAN ---
    emitProgress(taskId, Phase.PLAN, 10, "Planning task decomposition");
    traceRecord(trace, "phase_start", { phase: Phase.PLAN });

    let graph: GoalGraph;
    try {
      const { graph: g, usage: planUsage } = await plan(taskDescription);
      graph = g;
      totalPromptTokens += planUsage.promptTokens;
      totalCompletionTokens += planUsage.completionTokens;
    } catch (err) {
      traceRecord(trace, "phase_error", {
        phase: Phase.PLAN,
        error: String(err),
      });
      throw new Error(
        `Planning failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    traceRecord(trace, "phase_end", {
      phase: Phase.PLAN,
      goalCount: graph.size,
    });
    emitProgress(taskId, Phase.PLAN, 25, `Planned ${graph.size} goals`);

    console.log(`[orchestrator] Task ${taskId}: planned ${graph.size} goals`);

    // --- EXECUTE + REPLAN LOOP ---
    let executionResults: ExecutionResult = {
      goalResults: {},
      summary: graph.summary(),
      totalToolCalls: 0,
      totalToolNames: [],
      totalToolFailures: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      emitProgress(taskId, Phase.EXECUTE, 30, "Executing goals");
      traceRecord(trace, "phase_start", { phase: Phase.EXECUTE });

      // Check for global timeout before execution
      if (timeoutController.signal.aborted) {
        console.warn(`[orchestrator] Task ${taskId}: global timeout reached`);
        break;
      }

      executionResults = await executeGraph(
        graph,
        toolNames,
        budget,
        cfg.goalTimeoutMs,
        timeoutController.signal,
      );
      trace.totalToolCalls += executionResults.totalToolCalls;
      trace.totalToolFailures += executionResults.totalToolFailures;
      totalPromptTokens += executionResults.tokenUsage.promptTokens;
      totalCompletionTokens += executionResults.tokenUsage.completionTokens;

      traceRecord(trace, "phase_end", {
        phase: Phase.EXECUTE,
        summary: graph.summary(),
      });

      const summary = graph.summary();
      emitProgress(
        taskId,
        Phase.EXECUTE,
        70,
        `Executed: ${summary.completed}/${summary.total} completed, ${summary.failed} failed`,
      );

      console.log(
        `[orchestrator] Task ${taskId}: execution done — ${JSON.stringify(summary)}`,
      );

      // Check replan triggers
      const replanReason = checkReplan(graph, trace, executionResults, cfg);
      if (replanReason && replanCount < cfg.maxReplans) {
        replanCount++;
        traceRecord(trace, "replan", {
          reason: replanReason,
          attempt: replanCount,
        });
        emitProgress(
          taskId,
          Phase.PLAN,
          30,
          `Replanning (${replanCount}/${cfg.maxReplans}): ${replanReason}`,
        );

        console.log(
          `[orchestrator] Task ${taskId}: replanning (${replanCount}/${cfg.maxReplans}): ${replanReason}`,
        );

        try {
          const { graph: rg, usage: replanUsage } = await replan(
            taskDescription,
            graph,
            replanReason,
          );
          graph = rg;
          totalPromptTokens += replanUsage.promptTokens;
          totalCompletionTokens += replanUsage.completionTokens;
        } catch (err) {
          console.warn(
            `[orchestrator] Replan failed: ${err instanceof Error ? err.message : err}`,
          );
          break;
        }
        continue;
      }
      break;
    }

    // --- REFLECT ---
    emitProgress(taskId, Phase.REFLECT, 85, "Reflecting on execution");
    traceRecord(trace, "phase_start", { phase: Phase.REFLECT });

    const { result: reflection, usage: reflectUsage } = await reflect(
      taskDescription,
      graph,
      executionResults,
      taskId,
    );
    totalPromptTokens += reflectUsage.promptTokens;
    totalCompletionTokens += reflectUsage.completionTokens;

    traceRecord(trace, "phase_end", {
      phase: Phase.REFLECT,
      success: reflection.success,
      score: reflection.score,
    });

    trace.endTime = Date.now();
    clearTimeout(globalTimer);
    emitProgress(taskId, Phase.REFLECT, 100, "Complete");

    console.log(
      `[orchestrator] Task ${taskId}: complete — success=${reflection.success} score=${reflection.score.toFixed(2)} tokens=${totalPromptTokens + totalCompletionTokens} iterations=${budget.consumed}`,
    );

    return {
      success: reflection.success,
      goalGraph: graph.toJSON(),
      executionResults,
      reflection,
      trace: trace.events,
      traceId: trace.traceId,
      durationMs: trace.endTime - trace.startTime,
      tokenUsage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      },
      iterationsUsed: budget.consumed,
    };
  } finally {
    setMemoryTaskContext(null); // Governance: clear rate limit state on all paths
  }
}

// ---------------------------------------------------------------------------
// Trace helpers
// ---------------------------------------------------------------------------

function createTrace(): RunTrace {
  return {
    traceId: randomUUID(),
    events: [],
    startTime: Date.now(),
    endTime: null,
    totalToolCalls: 0,
    totalToolFailures: 0,
  };
}

function traceRecord(
  trace: RunTrace,
  type: string,
  data: Record<string, unknown> = {},
): void {
  trace.events.push({ type, timestamp: Date.now(), ...data });
}

// ---------------------------------------------------------------------------
// Replan check
// ---------------------------------------------------------------------------

function checkReplan(
  graph: GoalGraph,
  trace: RunTrace,
  _execResults: ExecutionResult,
  config: OrchestratorConfig,
): string | null {
  // Tool failure rate threshold
  if (trace.totalToolCalls > 0) {
    const rate = trace.totalToolFailures / trace.totalToolCalls;
    if (rate > config.replanThresholds.toolFailureRate) {
      return (
        `Tool failure rate ${(rate * 100).toFixed(0)}% exceeds ` +
        `${(config.replanThresholds.toolFailureRate * 100).toFixed(0)}% threshold`
      );
    }
  }

  // Convergence check: too many tool calls relative to goals — possible looping
  if (config.replanThresholds.toolCallsPerGoal > 0 && graph.size > 0) {
    const ratio = trace.totalToolCalls / graph.size;
    if (ratio > config.replanThresholds.toolCallsPerGoal) {
      return (
        `Tool call ratio ${ratio.toFixed(1)}/goal exceeds ` +
        `${config.replanThresholds.toolCallsPerGoal} threshold — possible looping`
      );
    }
  }

  // Blocked goals with no ready alternatives
  if (config.replanThresholds.goalBlocked) {
    const blocked = graph.getBlocked();
    const ready = graph.getReady();
    const summary = graph.summary();
    const allDone = summary.completed + summary.failed === summary.total;
    if (blocked.length > 0 && ready.length === 0 && !allDone) {
      return `Goals blocked with no ready alternatives: ${blocked.map((g) => g.id).join(", ")}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Progress events (best-effort)
// ---------------------------------------------------------------------------

function emitProgress(
  taskId: string,
  phase: Phase,
  progress: number,
  message: string,
): void {
  try {
    eventBus.emit("task.progress", {
      task_id: taskId,
      agent_id: "heavy",
      progress,
      phase,
      message,
    });
  } catch {
    // Progress emission is best-effort — don't crash the orchestrator
  }
}
