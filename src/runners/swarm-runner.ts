/**
 * Swarm Runner — Plan decomposition + parallel sub-task fan-out.
 *
 * Uses the Prometheus planner to decompose a task into a goal graph.
 * Each independent goal becomes a sub-task routed back through the dispatcher.
 * Sub-tasks are auto-classified (may become fast, heavy, or even swarm).
 * Progress is tracked by polling sub-task statuses from the database.
 */

import { registerRunner } from "../dispatch/dispatcher.js";
import { submitTask, getTask } from "../dispatch/dispatcher.js";
import type { TaskRow } from "../dispatch/dispatcher.js";
import { getEventBus } from "../lib/event-bus.js";
import { plan } from "../prometheus/planner.js";
import { reflect } from "../prometheus/reflector.js";
import { GoalGraph } from "../prometheus/goal-graph.js";
import { GoalStatus } from "../prometheus/types.js";
import type { Goal, ExecutionResult, GoalResult } from "../prometheus/types.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_DURATION_MS = 600_000; // 10 minutes
const MAX_CONCURRENT_SUBTASKS = 10;
const MAX_SWARM_DEPTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubTaskTracker {
  goalId: string;
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
}

// goalId -> taskId
type GoalTaskMap = Map<string, string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a sub-task description from a goal, including criteria and
 * context from completed dependency goals.
 */
function buildSubTaskDescription(goal: Goal, graph: GoalGraph): string {
  const parts: string[] = [goal.description];

  if (goal.completionCriteria.length > 0) {
    parts.push("\n## Completion Criteria");
    for (const criterion of goal.completionCriteria) {
      parts.push(`- ${criterion}`);
    }
  }

  // Add context from completed dependencies
  if (goal.dependsOn.length > 0) {
    const depContext: string[] = [];
    for (const depId of goal.dependsOn) {
      const dep = graph.findGoal(depId);
      if (dep && dep.status === GoalStatus.COMPLETED) {
        depContext.push(`- ${dep.description} (completed)`);
      }
    }
    if (depContext.length > 0) {
      parts.push("\n## Context from completed dependencies");
      parts.push(...depContext);
    }
  }

  return parts.join("\n");
}

/**
 * Poll task status from the database and update tracker + graph accordingly.
 */
function syncSubTaskStatuses(
  goalTaskMap: GoalTaskMap,
  graph: GoalGraph,
  trackers: Map<string, SubTaskTracker>,
): void {
  for (const [goalId, taskId] of goalTaskMap) {
    const tracker = trackers.get(goalId);
    if (!tracker) continue;

    // Skip already terminal trackers
    if (
      tracker.status === "completed" ||
      tracker.status === "failed" ||
      tracker.status === "cancelled"
    ) {
      continue;
    }

    const task = getTask(taskId) as TaskRow | null;
    if (!task) continue;

    if (task.status === "completed") {
      tracker.status = "completed";
      tracker.output = task.output ?? undefined;
      graph.updateStatus(goalId, GoalStatus.COMPLETED);
    } else if (task.status === "failed") {
      tracker.status = "failed";
      tracker.error = task.error ?? "Sub-task failed";
      graph.updateStatus(goalId, GoalStatus.FAILED);
    } else if (task.status === "cancelled") {
      tracker.status = "cancelled";
      tracker.error = "Sub-task cancelled";
      graph.updateStatus(goalId, GoalStatus.FAILED);
    } else if (task.status === "running") {
      tracker.status = "running";
    }
  }
}

/**
 * Count active (non-terminal) trackers.
 */
function countActive(trackers: Map<string, SubTaskTracker>): number {
  let count = 0;
  for (const t of trackers.values()) {
    if (
      t.status !== "completed" &&
      t.status !== "failed" &&
      t.status !== "cancelled"
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Build ExecutionResult from tracker data for the reflector.
 */
function buildExecutionResults(
  graph: GoalGraph,
  trackers: Map<string, SubTaskTracker>,
): ExecutionResult {
  const goalResults: Record<string, GoalResult> = {};
  let totalToolCalls = 0;

  for (const [goalId, tracker] of trackers) {
    const ok = tracker.status === "completed";
    goalResults[goalId] = {
      goalId,
      ok,
      result: tracker.output,
      error: tracker.error,
      durationMs: 0, // Not tracked per sub-task
      toolCalls: 0,
      toolFailures: ok ? 0 : 1,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
    };
    if (ok) totalToolCalls++;
  }

  return {
    goalResults,
    summary: graph.summary(),
    totalToolCalls,
    totalToolFailures: Object.values(goalResults).filter((r) => !r.ok).length,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
  };
}

function emitSwarmProgress(
  taskId: string,
  progress: number,
  message: string,
): void {
  try {
    getEventBus().emitEvent("task.progress", {
      task_id: taskId,
      agent_id: "swarm",
      progress,
      phase: "execute",
      message,
    });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const swarmRunner: Runner = {
  type: "swarm",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();
    const taskDescription = `${input.title}\n\n${input.description}`;

    // --- DEPTH GUARD ---
    // Prevent recursive swarm spawning beyond MAX_SWARM_DEPTH levels.
    // Walk the parent chain via getTask() to count nesting.
    let depth = 0;
    let parentId = input.parentTaskId;
    while (parentId && depth < MAX_SWARM_DEPTH + 1) {
      const parent = getTask(parentId);
      if (!parent) break;
      if (parent.agent_type === "swarm") depth++;
      parentId = parent.parent_task_id ?? undefined;
    }
    if (depth >= MAX_SWARM_DEPTH) {
      return {
        success: false,
        error: `Swarm depth limit (${MAX_SWARM_DEPTH}) exceeded — refusing to spawn nested swarm`,
        durationMs: Date.now() - start,
      };
    }

    // --- PHASE 1: PLAN ---
    let graph: GoalGraph;
    try {
      const planResult = await plan(taskDescription);
      graph = planResult.graph;
    } catch (err) {
      return {
        success: false,
        error: `Swarm planning failed: ${err instanceof Error ? err.message : err}`,
        durationMs: Date.now() - start,
      };
    }

    // Empty graph — nothing to do
    if (graph.size === 0) {
      return {
        success: true,
        output: {
          content: "No goals generated — task may be too simple for swarm.",
        },
        durationMs: Date.now() - start,
        goalGraph: graph.toJSON(),
      };
    }

    emitSwarmProgress(input.taskId, 15, `Planned ${graph.size} goals`);
    console.log(`[swarm] Task ${input.taskId}: planned ${graph.size} goals`);

    // --- PHASE 2: FAN-OUT ---
    const goalTaskMap: GoalTaskMap = new Map();
    const trackers = new Map<string, SubTaskTracker>();
    const pollStart = Date.now();

    while (Date.now() - pollStart < MAX_POLL_DURATION_MS) {
      // Update blocked statuses
      graph.getBlocked();

      // Sync existing sub-task statuses from DB
      syncSubTaskStatuses(goalTaskMap, graph, trackers);

      const ready = graph.getReady();
      const summary = graph.summary();

      // Check if we're done (all goals terminal)
      const allTerminal =
        summary.completed + summary.failed + summary.blocked === summary.total;
      if (allTerminal && ready.length === 0 && countActive(trackers) === 0) {
        break;
      }

      // If nothing is ready and nothing is active, but not all terminal — blocked state
      if (ready.length === 0 && countActive(trackers) === 0) {
        // Re-check blocked
        graph.getBlocked();
        const updatedSummary = graph.summary();
        if (
          updatedSummary.completed +
            updatedSummary.failed +
            updatedSummary.blocked ===
          updatedSummary.total
        ) {
          break;
        }
      }

      // Submit ready goals as sub-tasks (respect concurrency limit)
      const activeCount = countActive(trackers);
      const slotsAvailable = Math.max(0, MAX_CONCURRENT_SUBTASKS - activeCount);
      const toSubmit = ready.slice(0, slotsAvailable);

      for (const goal of toSubmit) {
        graph.updateStatus(goal.id, GoalStatus.IN_PROGRESS);

        try {
          const result = await submitTask({
            title: `[Swarm] ${goal.description.slice(0, 100)}`,
            description: buildSubTaskDescription(goal, graph),
            parentTaskId: input.taskId,
            spawnType: "subtask",
            tools: input.tools,
            // agentType NOT set — classifier auto-routes
          });

          goalTaskMap.set(goal.id, result.taskId);
          trackers.set(goal.id, {
            goalId: goal.id,
            taskId: result.taskId,
            status: "pending",
          });

          console.log(
            `[swarm] Task ${input.taskId}: submitted sub-task ${result.taskId} for goal ${goal.id} (${result.agentType})`,
          );
        } catch (err) {
          graph.updateStatus(goal.id, GoalStatus.FAILED);
          trackers.set(goal.id, {
            goalId: goal.id,
            taskId: "",
            status: "failed",
            error: `Failed to submit sub-task: ${err instanceof Error ? err.message : err}`,
          });
        }
      }

      // Emit progress
      const currentSummary = graph.summary();
      const completionPct =
        currentSummary.total > 0
          ? Math.round((currentSummary.completed / currentSummary.total) * 70) +
            15
          : 15;
      emitSwarmProgress(
        input.taskId,
        Math.min(completionPct, 85),
        `${currentSummary.completed}/${currentSummary.total} goals completed, ${countActive(trackers)} active`,
      );

      // Wait before next poll
      await sleep(POLL_INTERVAL_MS);
    }

    // --- PHASE 3: REFLECT ---
    const executionResults = buildExecutionResults(graph, trackers);

    let reflectionResult;
    try {
      const { result } = await reflect(
        taskDescription,
        graph,
        executionResults,
      );
      reflectionResult = result;
    } catch (err) {
      console.warn(
        `[swarm] Task ${input.taskId}: reflection failed: ${err instanceof Error ? err.message : err}`,
      );
      const heuristicScore =
        graph.summary().total > 0
          ? graph.summary().completed / graph.summary().total
          : 0;
      reflectionResult = {
        success: heuristicScore >= 0.8,
        score: heuristicScore,
        learnings: ["Reflection failed; using heuristic score"],
        summary: `Completed ${graph.summary().completed}/${graph.summary().total} goals`,
      };
    }

    emitSwarmProgress(input.taskId, 100, "Swarm complete");

    const summary = graph.summary();
    console.log(
      `[swarm] Task ${input.taskId}: complete — ${summary.completed}/${summary.total} goals, score=${reflectionResult.score.toFixed(2)}`,
    );

    return {
      success: reflectionResult.success,
      output: {
        content: reflectionResult.summary,
        score: reflectionResult.score,
        learnings: reflectionResult.learnings,
        goalSummary: summary,
      },
      durationMs: Date.now() - start,
      goalGraph: graph.toJSON(),
      trace: Array.from(trackers.entries()).map(([goalId, t]) => ({
        type: "subtask",
        goalId,
        taskId: t.taskId,
        status: t.status,
      })),
    };
  },
};

// Auto-register on import
registerRunner(swarmRunner);
