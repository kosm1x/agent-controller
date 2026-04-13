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
import { Phase, GoalStatus, defaultConfig } from "./types.js";
import type {
  OrchestratorConfig,
  OrchestratorResult,
  RunTrace,
  ExecutionResult,
} from "./types.js";
import { plan, replan } from "./planner.js";
import { executeGraph } from "./executor.js";
import { TaskExecutionContext } from "../inference/execution-context.js";
import { reflect } from "./reflector.js";
import { eventBus } from "../lib/event-bus.js";
import type { PrometheusSnapshot } from "./snapshot.js";

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
  snapshot?: PrometheusSnapshot,
): Promise<OrchestratorResult> {
  const cfg = defaultConfig(config);
  const trace = createTrace();
  const budget = new IterationBudget(cfg.maxIterations);

  // Per-task execution context: isolates mutable state for concurrent safety
  const _taskContext = new TaskExecutionContext(taskId);

  try {
    let replanCount = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    // Autoreason Phase 1: k=2 stability rule for soft replan signals.
    // Counter increments on each consecutive soft vote from checkReplan; the
    // replan only fires when the counter reaches 2. Any iteration with no
    // vote (or a hard vote that routes around this) resets to 0. Prevents
    // replan thrashing on transient single-pass metric blips.
    let consecutiveSoftReplanVotes = 0;

    // Global timeout — abort the entire orchestration
    const timeoutController = new AbortController();
    const globalTimer = setTimeout(
      () => timeoutController.abort(),
      cfg.timeoutMs,
    );

    let graph: GoalGraph;
    let executionResults: ExecutionResult;

    if (snapshot) {
      // --- RESUME PATH: restore state from snapshot ---
      graph = GoalGraph.fromJSON(snapshot.goalGraph);
      // Reset any IN_PROGRESS goals to PENDING (they were interrupted mid-execution)
      for (const goal of graph.getAll()) {
        if (goal.status === GoalStatus.IN_PROGRESS) {
          graph.updateStatus(goal.id, GoalStatus.PENDING);
        }
      }
      replanCount = snapshot.executionState.replanCount;
      totalPromptTokens = snapshot.executionState.tokenUsage.promptTokens;
      totalCompletionTokens =
        snapshot.executionState.tokenUsage.completionTokens;
      for (let i = 0; i < snapshot.executionState.budgetConsumed; i++) {
        budget.consume();
      }
      trace.events.push(
        ...(snapshot.executionState.traceEvents as Array<
          Record<string, unknown> & { type: string; timestamp: number }
        >),
      );
      executionResults = {
        goalResults: snapshot.goalResults,
        summary: graph.summary(),
        totalToolCalls: 0,
        totalToolNames: [],
        totalToolFailures: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
        toolRepairs: [],
      };
      traceRecord(trace, "resumed_from_snapshot", {
        taskId: snapshot.taskId,
        priorGoals: Object.keys(snapshot.goalResults).length,
      });
      console.log(
        `[orchestrator] Task ${taskId}: resumed from snapshot (${Object.keys(snapshot.goalResults).length} prior results, budget ${budget.remaining} remaining)`,
      );
      emitProgress(taskId, Phase.EXECUTE, 30, "Resuming from snapshot");
    } else {
      // --- PLAN ---
      emitProgress(taskId, Phase.PLAN, 10, "Planning task decomposition");
      traceRecord(trace, "phase_start", { phase: Phase.PLAN });

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

      executionResults = {
        goalResults: {},
        summary: graph.summary(),
        totalToolCalls: 0,
        totalToolNames: [],
        totalToolFailures: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
        toolRepairs: [],
      };
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      emitProgress(taskId, Phase.EXECUTE, 30, "Executing goals");
      traceRecord(trace, "phase_start", { phase: Phase.EXECUTE });

      // Check for global timeout before execution
      if (timeoutController.signal.aborted) {
        console.warn(`[orchestrator] Task ${taskId}: global timeout reached`);
        break;
      }

      const newExecResults = await executeGraph(
        graph,
        toolNames,
        budget,
        cfg.goalTimeoutMs,
        timeoutController.signal,
      );
      // Merge: keep prior snapshot results + add newly executed results
      executionResults = {
        ...newExecResults,
        goalResults: {
          ...executionResults.goalResults,
          ...newExecResults.goalResults,
        },
      };
      trace.totalToolCalls += newExecResults.totalToolCalls;
      trace.totalToolFailures += newExecResults.totalToolFailures;
      totalPromptTokens += executionResults.tokenUsage.promptTokens;
      totalCompletionTokens += executionResults.tokenUsage.completionTokens;

      // Record tool repairs to scope telemetry (non-fatal)
      if (executionResults.toolRepairs.length > 0) {
        try {
          const { recordToolRepairs } =
            await import("../intelligence/scope-telemetry.js");
          recordToolRepairs(taskId, executionResults.toolRepairs);
        } catch {
          /* telemetry should never block execution */
        }
      }

      // Record research provenance to database (non-fatal, S5c)
      if (
        executionResults.provenanceRecords &&
        executionResults.provenanceRecords.length > 0
      ) {
        try {
          const { insertProvenance } = await import("../db/provenance.js");
          insertProvenance(
            executionResults.provenanceRecords.map((r) => ({
              task_id: taskId,
              goal_id: r.goalId,
              tool_name: r.tool_name,
              url: r.url,
              query: r.query,
              status: r.status,
              content_hash: null,
              snippet: r.snippet,
            })),
          );
        } catch {
          /* provenance should never block execution */
        }
      }

      traceRecord(trace, "phase_end", {
        phase: Phase.EXECUTE,
        summary: graph.summary(),
      });

      const summary = graph.summary();
      // Progress label: count + last completed goal description (git-commit-subject style)
      // Pattern from Claude Code's ToolUseSummary: short, past-tense, names the thing.
      const lastCompleted = graph
        .getAll()
        .filter((g) => g.status === "completed")
        .pop();
      const progressLabel = lastCompleted
        ? `${summary.completed}/${summary.total} — ${lastCompleted.description.slice(0, 50)}`
        : `${summary.completed}/${summary.total} completed, ${summary.failed} failed`;
      emitProgress(taskId, Phase.EXECUTE, 70, progressLabel);

      console.log(
        `[orchestrator] Task ${taskId}: execution done — ${JSON.stringify(summary)}`,
      );

      // Check replan triggers. Soft votes are gated by the k=2 stability
      // rule: require two consecutive votes before firing a replan. Hard
      // votes (dead-end states) fire immediately.
      const vote = checkReplan(graph, trace, executionResults, cfg);

      if (!vote) {
        consecutiveSoftReplanVotes = 0;
        break;
      }

      // Soft votes: defer the first one, act on the second.
      if (vote.severity === "soft") {
        consecutiveSoftReplanVotes++;
        if (consecutiveSoftReplanVotes < 2) {
          // k=2 defer: skip this replan, give the current plan another
          // execution pass. If the metric washes out (transient), the next
          // iteration will reset the counter and exit normally.
          // Use executionResults.summary (the LAST execution's view) rather
          // than graph.summary() so deferral is gated on what the most
          // recent pass actually reported as remaining work.
          const summary = executionResults.summary;
          const workRemains =
            summary.pending > 0 ||
            summary.in_progress > 0 ||
            summary.blocked > 0;
          traceRecord(trace, "replan_deferred", {
            reason: vote.reason,
            votes: consecutiveSoftReplanVotes,
            workRemains,
          });
          console.log(
            `[orchestrator] Task ${taskId}: soft replan vote deferred (k=2 stability) — ${vote.reason}`,
          );
          if (!workRemains) {
            // Nothing left to re-execute — the deferred vote can't be
            // resolved by another pass. Exit cleanly.
            break;
          }
          continue;
        }
        // counter >= 2: act on the vote
        consecutiveSoftReplanVotes = 0;
      }

      if (replanCount < cfg.maxReplans) {
        replanCount++;
        traceRecord(trace, "replan", {
          reason: vote.reason,
          severity: vote.severity,
          attempt: replanCount,
        });
        emitProgress(
          taskId,
          Phase.PLAN,
          30,
          `Replanning (${replanCount}/${cfg.maxReplans}): ${vote.reason}`,
        );

        console.log(
          `[orchestrator] Task ${taskId}: replanning (${replanCount}/${cfg.maxReplans}, ${vote.severity}): ${vote.reason}`,
        );

        try {
          const { graph: rg, usage: replanUsage } = await replan(
            taskDescription,
            graph,
            vote.reason,
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

    // --- SNAPSHOT on early exit ---
    const postExecSummary = graph.summary();
    if (postExecSummary.pending > 0 || postExecSummary.in_progress > 0) {
      const exitReason = timeoutController.signal.aborted
        ? "timeout"
        : "budget_exhausted";
      try {
        const { saveSnapshot } = await import("./snapshot.js");
        saveSnapshot({
          taskId,
          goalGraph: graph.toJSON(),
          goalResults: executionResults.goalResults,
          executionState: {
            budgetConsumed: budget.consumed,
            replanCount,
            tokenUsage: {
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
            },
            traceEvents: trace.events,
          },
          taskDescription,
          toolNames: toolNames ?? null,
          config: config ?? null,
          exitReason: exitReason as "timeout" | "budget_exhausted",
          createdAt: new Date().toISOString(),
        });
        traceRecord(trace, "snapshot_saved", {
          exitReason,
          pending: postExecSummary.pending,
        });
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to save snapshot: ${err instanceof Error ? err.message : err}`,
        );
      }
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

    // H2 Layer 5: Drift detection — post-reflection, zero execution latency
    try {
      const { checkAndRecordDrift, pruneBaselines } =
        await import("./drift.js");
      const taskType =
        taskDescription.match(/^\[([^\]]+)\]/)?.[1]?.toLowerCase() ??
        taskDescription
          .split(/\s+/)
          .slice(0, 3)
          .join(" ")
          .toLowerCase()
          .slice(0, 50);
      const drift = checkAndRecordDrift(taskType, reflection.score);
      if (drift.drifting) {
        console.warn(
          `[orchestrator] DRIFT ALERT: "${taskType}" score ${drift.currentScore.toFixed(2)} ` +
            `< avg ${drift.rollingAvg.toFixed(2)} - 1σ (${drift.stdDev.toFixed(2)})`,
        );
        traceRecord(trace, "drift_alert", {
          taskType,
          currentScore: drift.currentScore,
          rollingAvg: drift.rollingAvg,
        });
      }
      pruneBaselines(taskType);
    } catch {
      // Drift detection is best-effort
    }

    trace.endTime = Date.now();
    clearTimeout(globalTimer);
    emitProgress(taskId, Phase.REFLECT, 100, "Complete");

    // Clear snapshot on successful completion (if we resumed from one)
    if (snapshot) {
      try {
        const { clearSnapshot } = await import("./snapshot.js");
        clearSnapshot(snapshot.taskId);
      } catch {
        /* best-effort */
      }
    }

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
    // TaskExecutionContext is GC'd with the task — no global cleanup needed
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

/**
 * Replan vote from checkReplan.
 *
 * severity:
 *  - "soft": cumulative metric (tool failure rate, tool-calls-per-goal) that
 *    can wash out with another execution pass. Gated by k=2 stability rule
 *    in the orchestrator loop — requires two consecutive votes before a
 *    replan fires. Rationale: autoreason paper Table 23 shows k=1
 *    termination is premature on 94% of runs; a single-pass metric blip is
 *    often transient. Mirrored here for replan triggers, which are the same
 *    class of decision.
 *  - "hard": dead-end state (all goals blocked with no ready alternatives).
 *    Another execution pass literally has nothing to run, so there's no
 *    point deferring — replan immediately.
 */
interface ReplanVote {
  reason: string;
  severity: "soft" | "hard";
}

function checkReplan(
  graph: GoalGraph,
  trace: RunTrace,
  _execResults: ExecutionResult,
  config: OrchestratorConfig,
): ReplanVote | null {
  // Tool failure rate threshold (soft — can improve with another pass)
  if (trace.totalToolCalls > 0) {
    const rate = trace.totalToolFailures / trace.totalToolCalls;
    if (rate > config.replanThresholds.toolFailureRate) {
      return {
        reason:
          `Tool failure rate ${(rate * 100).toFixed(0)}% exceeds ` +
          `${(config.replanThresholds.toolFailureRate * 100).toFixed(0)}% threshold`,
        severity: "soft",
      };
    }
  }

  // Convergence check: too many tool calls relative to goals — possible looping
  // (soft — also cumulative)
  if (config.replanThresholds.toolCallsPerGoal > 0 && graph.size > 0) {
    const ratio = trace.totalToolCalls / graph.size;
    if (ratio > config.replanThresholds.toolCallsPerGoal) {
      return {
        reason:
          `Tool call ratio ${ratio.toFixed(1)}/goal exceeds ` +
          `${config.replanThresholds.toolCallsPerGoal} threshold — possible looping`,
        severity: "soft",
      };
    }
  }

  // Blocked goals with no ready alternatives (hard — nothing can run)
  if (config.replanThresholds.goalBlocked) {
    const blocked = graph.getBlocked();
    const ready = graph.getReady();
    const summary = graph.summary();
    const allDone = summary.completed + summary.failed === summary.total;
    if (blocked.length > 0 && ready.length === 0 && !allDone) {
      return {
        reason: `Goals blocked with no ready alternatives: ${blocked.map((g) => g.id).join(", ")}`,
        severity: "hard",
      };
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
