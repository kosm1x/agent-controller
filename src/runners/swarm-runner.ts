/**
 * Swarm Runner — Plan decomposition + parallel sub-task fan-out.
 *
 * Uses the Prometheus planner to decompose a task into a goal graph.
 * Each independent goal becomes a sub-task routed back through the dispatcher.
 * Sub-tasks are auto-classified (may become fast, heavy, or even swarm).
 * Progress is tracked by polling sub-task statuses from the database.
 */

import { registerRunner } from "../dispatch/dispatcher.js";
import {
  submitTask,
  getTask,
  getRunToolCalls,
} from "../dispatch/dispatcher.js";
import type { TaskRow } from "../dispatch/dispatcher.js";
import { getEventBus } from "../lib/event-bus.js";
import { plan } from "../prometheus/planner.js";
import { reflect } from "../prometheus/reflector.js";
import { resolveUseOpus } from "../prometheus/model-tier.js";
import { GoalGraph } from "../prometheus/goal-graph.js";
import { GoalStatus } from "../prometheus/types.js";
import type { Goal, ExecutionResult, GoalResult } from "../prometheus/types.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import { CACHE_BREAK_MARKER } from "../messaging/router.js";
import {
  classifyRetry,
  buildRetryDescription,
  MAX_RETRIES_PER_GOAL,
} from "./swarm-retry-policy.js";
import { recordSwarmSubtaskRetry } from "../observability/prometheus.js";
import { errMsg } from "../lib/err-msg.js";
import { renderConversationContext } from "./conversation-context.js";
import { collectFinalAnswer } from "../prometheus/final-answer.js";
import { extractDeliverableText } from "../lib/deliverable.js";

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
/** @internal Exported for testing. */
export function buildSubTaskDescription(
  goal: Goal,
  graph: GoalGraph,
  trackers: Map<string, SubTaskTracker>,
): string {
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

  // Sibling context: other goals at same level (not dependencies)
  const allGoals = graph.getAll();
  const siblings = allGoals.filter(
    (g) =>
      g.id !== goal.id &&
      g.parentId === goal.parentId &&
      !goal.dependsOn.includes(g.id),
  );

  if (siblings.length > 0) {
    const siblingLines: string[] = [];
    for (const sib of siblings) {
      const tracker = trackers.get(sib.id);
      const status = tracker?.status ?? "pending";
      let line = `- ${sib.description} [${status}]`;
      if (tracker?.status === "completed" && tracker.output) {
        const summary = tracker.output.slice(0, 200);
        line += ` — Result: ${summary}`;
      }
      siblingLines.push(line);
    }
    parts.push(
      "\n## Sibling goals (for coordination, not your responsibility)",
    );
    parts.push(...siblingLines);
  }

  return parts.join("\n");
}

/**
 * @internal Exported for testing.
 *
 * Poll task status from the database and update tracker + graph accordingly.
 *
 * Hermes v0.13 May Tier-2 #5 audit (2026-05-23): added recognition of three
 * additional terminal/quasi-terminal task statuses the dispatcher writes but
 * this sync previously ignored. Before the fix, a sub-task in any of these
 * states would leave the tracker stuck non-terminal until MAX_POLL_DURATION_MS
 * (10 min) — and for `completed_with_concerns` specifically that meant a
 * SUCCESSFUL sub-task was treated as not-ok by the reflector. Now:
 *   - `completed_with_concerns` → tracker `completed` (output IS available).
 *   - `needs_context`           → tracker `failed` (paused for user; won't auto-resume).
 *   - `blocked`                 → tracker `failed` (task-level block, distinct
 *                                 from goal-graph BLOCKED; won't auto-resume).
 * Pre-running statuses (`pending`, `classifying`, `queued`) intentionally
 * stay un-mapped — the tracker keeps its prior state and `countActive` waits.
 */
/**
 * Classify a failed sub-task via the retry-policy module + record telemetry +
 * (when env flag is on) re-spawn the work as a fresh task. Returns true iff
 * a respawn fired (tracker has been rewired to the new task_id and reset to
 * "pending"); false iff the caller should proceed with the existing FAILED
 * bookkeeping. Always emits exactly one Prometheus counter increment + one
 * structured `[swarm-retry]` log line per call.
 *
 * queue #231 design: docs/planning/swarm-retry.md.
 */
function attemptSubtaskRetry(
  goalId: string,
  failedTask: TaskRow,
  goalTaskMap: GoalTaskMap,
  graph: GoalGraph,
  trackers: Map<string, SubTaskTracker>,
  retryContext: SwarmRetryContext,
): boolean {
  const toolCalls = getRunToolCalls(failedTask.task_id);
  const decision = classifyRetry({
    error: failedTask.error,
    toolCalls,
    retryCount: failedTask.retry_count,
  });

  // Default: not retried unless env flag is on AND decision says retry.
  const envFlagOn = process.env.SWARM_SUBTASK_RETRY_ENABLED === "true";
  const willRespawn = decision.decision === "retried" && envFlagOn;
  const finalDecision =
    decision.decision === "retried" && !envFlagOn
      ? "shadow_skipped"
      : decision.decision;

  // qa-audit W3 fold 2026-05-23: preserve recoveryMode in shadow rows so
  // the operator can see WHAT mode would have fired (plain vs hallucination).
  // The `decision` axis already encodes "did/didn't happen"; recovery_mode
  // is the orthogonal "what mode" axis and shouldn't collapse to "none"
  // just because the env flag is off. Only collapse to "none" when the
  // classifier itself returned a non-retry decision (skipped_* paths) —
  // those legitimately have no recovery mode to record.
  const telemetryRecoveryMode =
    decision.decision === "retried" ? decision.recoveryMode : "none";
  recordSwarmSubtaskRetry({
    decision: finalDecision,
    reason: decision.reason,
    recoveryMode: telemetryRecoveryMode,
  });
  console.log(
    `[swarm-retry] goal=${goalId} task=${failedTask.task_id} ` +
      `decision=${finalDecision} reason=${decision.reason} ` +
      `recovery=${willRespawn ? decision.recoveryMode : "none"} ` +
      `retry_count=${failedTask.retry_count}/${MAX_RETRIES_PER_GOAL} ` +
      `tools_called=${toolCalls.length} ` +
      `flag=${envFlagOn ? "on" : "off"} ` +
      `rationale="${decision.rationale}"`,
  );

  if (!willRespawn) return false;

  // Re-build the sub-task description from the original goal, applying the
  // hallucination addendum when needed. Then submit as a NEW task with
  // retry_count bumped so the budget cap holds.
  const goal = retryContext.goalsById.get(goalId);
  if (!goal) {
    console.warn(
      `[swarm-retry] goal=${goalId} not in goalsById — respawn aborted, falling through to FAILED`,
    );
    return false;
  }
  const baseDescription = buildSubTaskDescription(goal, graph, trackers);
  const retryDescription = buildRetryDescription(
    baseDescription,
    decision.recoveryMode,
  );

  // submitTask is async; fire-and-forget here matches the existing
  // dispatcher pattern at dispatcher.ts:471 (_isRequiredToolRetry path).
  // The tracker rewire happens synchronously below so the next poll sees
  // the new state.
  //
  // Forward `failedTask.agent_type` so the classifier honors the original
  // explicit pick (sibling fix to the reactions-manager forwarding —
  // commit `ef5b04e` follow-on). Without this, swarm sub-task retries
  // re-classify and can land on the wrong runner the same way ritual
  // retries did (the skill-evolution heavy → nanoclaw cascade). Note: this
  // path does NOT forward `ritualId` — sub-tasks aren't currently tagged
  // with the parent's ritualId in this codebase. If a future swarm-class
  // ritual is added, plumb ritualId through SwarmRetryContext.
  submitTask({
    title: `[Swarm-retry] ${goal.description.slice(0, 100)}`,
    description: retryDescription,
    parentTaskId: retryContext.parentTaskId,
    spawnType: "subtask",
    agentType: failedTask.agent_type ?? undefined,
    tools: retryContext.tools,
    retryCount: failedTask.retry_count + 1,
  })
    .then((result) => {
      goalTaskMap.set(goalId, result.taskId);
      console.log(
        `[swarm-retry] respawned goal=${goalId}: ` +
          `${failedTask.task_id} (retry_count=${failedTask.retry_count}) → ` +
          `${result.taskId} (retry_count=${failedTask.retry_count + 1}) ` +
          `agent=${result.agentType}`,
      );
    })
    .catch((err) => {
      console.error(
        `[swarm-retry] respawn submitTask failed goal=${goalId}: ` +
          `${errMsg(err)}`,
      );
      // Couldn't submit the retry — mark the goal FAILED now so the
      // parent doesn't hang waiting. Best-effort; if the tracker has
      // already moved on this is a no-op.
      const t = trackers.get(goalId);
      if (t && t.status === "pending") {
        t.status = "failed";
        t.error = `Sub-task retry submission failed: ${errMsg(err)}`;
        graph.updateStatus(goalId, GoalStatus.FAILED);
      }
    });

  // Reset tracker to pending. The next poll cycle will see the new
  // task via goalTaskMap (once submitTask resolves above). In the
  // interval the goal stays IN_PROGRESS (no graph.updateStatus call).
  const tracker = trackers.get(goalId);
  if (tracker) {
    tracker.status = "pending";
    tracker.error = undefined;
  }
  return true;
}

/**
 * Per-sub-task retry context passed by `swarm-runner.execute` to
 * `syncSubTaskStatuses`. When provided, the `failed` branch consults the
 * retry-policy classifier and may re-spawn the sub-task instead of marking
 * the goal FAILED (queue #231).
 *
 * Undefined in tests / non-swarm callers — preserves the legacy behavior
 * of "any failed sub-task → goal failed". The 3-arg call signature still
 * works for existing tests.
 */
export interface SwarmRetryContext {
  parentTaskId: string;
  tools: string[] | undefined;
  /** goalId → Goal lookup for re-building the retry submission description. */
  goalsById: Map<string, Goal>;
}

export function syncSubTaskStatuses(
  goalTaskMap: GoalTaskMap,
  graph: GoalGraph,
  trackers: Map<string, SubTaskTracker>,
  retryContext?: SwarmRetryContext,
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
    } else if (task.status === "completed_with_concerns") {
      // Terminal-with-warning. Output IS set by the dispatcher; the
      // reflector reads it. Map to tracker.completed so the parent stops
      // waiting and treats the work as done. The concerns are encoded
      // inside the output text (Jarvis convention).
      tracker.status = "completed";
      tracker.output = task.output ?? undefined;
      graph.updateStatus(goalId, GoalStatus.COMPLETED);
    } else if (task.status === "failed") {
      // queue #231: when the swarm provides a retryContext, consult the
      // per-sub-task retry-policy classifier before marking the goal
      // terminal. If the failure is retry-eligible AND the env flag
      // SWARM_SUBTASK_RETRY_ENABLED is "true" AND the predecessor's
      // retry_count is under MAX_RETRIES_PER_GOAL, respawn the work
      // under a NEW task_id and rewire goalTaskMap. Otherwise (shadow
      // mode, side-effect taint, terminal failure class, budget cap):
      // log the would-decision via Prometheus + structured log, then
      // mark the goal FAILED as today.
      if (retryContext) {
        const respawned = attemptSubtaskRetry(
          goalId,
          task,
          goalTaskMap,
          graph,
          trackers,
          retryContext,
        );
        if (respawned) {
          // tracker has been reset to "pending" with the new taskId;
          // next poll cycle picks up the new task. Skip the FAILED
          // bookkeeping for this iteration.
          continue;
        }
      }
      tracker.status = "failed";
      tracker.error = task.error ?? "Sub-task failed";
      graph.updateStatus(goalId, GoalStatus.FAILED);
    } else if (task.status === "cancelled") {
      tracker.status = "cancelled";
      tracker.error = "Sub-task cancelled";
      graph.updateStatus(goalId, GoalStatus.FAILED);
    } else if (task.status === "needs_context") {
      // Runner paused for user input. Will not auto-resume from the
      // sub-task side; treat as failed so the swarm stops waiting.
      tracker.status = "failed";
      tracker.error = task.error ?? "Sub-task needs additional user context";
      graph.updateStatus(goalId, GoalStatus.FAILED);
    } else if (task.status === "blocked") {
      // Task-level blocked (distinct from goal-graph BLOCKED — that one
      // describes dependency state). Treat as failed for swarm purposes.
      tracker.status = "failed";
      tracker.error = task.error ?? "Sub-task blocked";
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
      // Audit W1 (2026-07-12): tracker.output is the sub-task's PERSISTED
      // output — a JSON.stringify'd RunnerOutput.output blob (dispatcher
      // writes tasks.output that way). Joining raw blobs made finalAnswer
      // deliver `{"text":"..."}` fragments to the operator. Extract the
      // deliverable text per sub-task; fall back to the raw string only
      // when no canonical field exists.
      result: tracker.output
        ? (extractDeliverableText(tracker.output) ?? tracker.output)
        : tracker.output,
      error: tracker.error,
      durationMs: 0, // Not tracked per sub-task
      toolCalls: 0,
      toolNames: [],
      toolFailures: ok ? 0 : 1,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
    };
    if (ok) totalToolCalls++;
  }

  return {
    goalResults,
    summary: graph.summary(),
    totalToolCalls,
    totalToolNames: [],
    totalToolFailures: Object.values(goalResults).filter((r) => !r.ok).length,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    toolRepairs: [],
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
    // v8 S1: strip cache-break marker — swarm uses description as a single
    // blob fed to plan() and as text for sub-task descriptions.
    // 2026-07-12 (task 7416 class): chat-routed swarm tasks (isFanOutTask)
    // carry the current user message in conversationHistory, not description.
    const taskDescription = `${input.title}\n\n${input.description.replace(CACHE_BREAK_MARKER, "\n")}${renderConversationContext(input.conversationHistory)}`;

    // Model tier for swarm's own plan/reflect LLM calls (sub-tasks re-enter
    // dispatch and tier themselves). Swarm is the top complexity tier, so this
    // almost always resolves to Opus; the heuristic + kill switch keep it
    // consistent with the rest of Prometheus.
    const useOpus = resolveUseOpus(taskDescription);

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
      const planResult = await plan(taskDescription, useOpus);
      graph = planResult.graph;
    } catch (err) {
      return {
        success: false,
        error: `Swarm planning failed: ${errMsg(err)}`,
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

    // queue #231: build goalsById lookup ONCE per poll iteration for the
    // retry-policy respawn path. graph.getAll() is O(n); fine for swarm
    // sizes (planner caps at ~10 goals) but no reason to rebuild it inside
    // the inner failure branch.
    const buildGoalsById = (): Map<string, Goal> => {
      const m = new Map<string, Goal>();
      for (const g of graph.getAll()) m.set(g.id, g);
      return m;
    };

    while (Date.now() - pollStart < MAX_POLL_DURATION_MS) {
      // Update blocked statuses
      graph.getBlocked();

      // Sync existing sub-task statuses from DB. Pass retry context so the
      // failure branch can classify + respawn under the queue-#231 policy
      // (env-gated by SWARM_SUBTASK_RETRY_ENABLED; shadow mode logs only).
      syncSubTaskStatuses(goalTaskMap, graph, trackers, {
        parentTaskId: input.taskId,
        tools: input.tools,
        goalsById: buildGoalsById(),
      });

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
            description: buildSubTaskDescription(goal, graph, trackers),
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
            error: `Failed to submit sub-task: ${errMsg(err)}`,
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
        undefined,
        useOpus,
      );
      reflectionResult = result;
    } catch (err) {
      console.warn(
        `[swarm] Task ${input.taskId}: reflection failed: ${errMsg(err)}`,
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
        // Agent's actual report (joined per-goal answers) — the deliverable.
        // Without it, chat-routed swarm tasks (isFanOutTask) deliver the
        // reflector meta-summary (same class as the 07-11 heavy / 07-12
        // nanoclaw incidents; swarm was the last unswept producer).
        finalAnswer: collectFinalAnswer(executionResults),
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
