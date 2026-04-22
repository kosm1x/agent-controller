/**
 * Task dispatcher.
 *
 * Manages the full task lifecycle: creation, classification, runner routing,
 * concurrency control, and status updates. All state is persisted to SQLite.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "../db/index.js";
import { getEventBus } from "../lib/event-bus.js";
import { classify } from "./classifier.js";
import { getConfig } from "../config.js";
import { checkoutTask } from "./checkout.js";
import {
  isAnyWindowExceeded,
  getThreeWindowStatus,
  recordCost,
} from "../budget/service.js";
import { taskStarted, taskCompleted } from "../observability/prometheus.js";
import type { AgentType, RunnerInput, Runner } from "../runners/types.js";
import { createLogger } from "../lib/logger.js";
import { SONNET_MODEL_ID } from "../inference/claude-sdk.js";

const log = createLogger("dispatch");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSubmission {
  title: string;
  description: string;
  priority?: "critical" | "high" | "medium" | "low";
  agentType?: string;
  tags?: string[];
  tools?: string[];
  input?: unknown;
  parentTaskId?: string;
  spawnType?: "root" | "subtask" | "user-background";
  /** Prior conversation turns for thread continuity (chat tasks). */
  conversationHistory?: import("../runners/types.js").ConversationTurn[];
  /** Tools that MUST appear in toolCalls for the task to be considered successful. */
  requiredTools?: string[];
  /** Streaming callback — receives text chunks as the LLM generates them. */
  onTextChunk?: (text: string) => void;
  /** Abort controller for task cancellation (v6.2 S2). Caller creates and retains it. */
  abortController?: AbortController;
  /** Whether the task has an interactive user who can confirm high-risk actions.
   *  Defaults to true. Scheduled tasks, rituals set this to false. */
  interactive?: boolean;
  /** @internal Set by dispatcher on auto-retry to prevent infinite retry loops. */
  _isRequiredToolRetry?: boolean;
}

export interface TaskRow {
  id: number;
  task_id: string;
  parent_task_id: string | null;
  spawn_type: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  agent_type: string | null;
  classification: string | null;
  assigned_to: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  progress: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface RunRow {
  id: number;
  run_id: string;
  task_id: string;
  agent_type: string;
  status: string;
  phase: string | null;
  trace: string | null;
  goal_graph: string | null;
  input: string;
  output: string | null;
  error: string | null;
  token_usage: string | null;
  duration_ms: number | null;
  container_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Runner registry
// ---------------------------------------------------------------------------

const runners = new Map<AgentType, Runner>();

/** Register a runner implementation. Called at startup by each runner module. */
export function registerRunner(runner: Runner): void {
  runners.set(runner.type, runner);
}

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

let activeContainers = 0;
let maxContainers = 5;

export function setMaxContainers(max: number): void {
  maxContainers = max;
}

function acquireContainerSlot(): boolean {
  if (activeContainers >= maxContainers) return false;
  activeContainers++;
  return true;
}

function releaseContainerSlot(): void {
  if (activeContainers > 0) activeContainers--;
  drainContainerQueue();
}

/** Returns true if the runner type requires a container slot. */
function needsContainer(agentType: AgentType): boolean {
  if (agentType === "nanoclaw") return true;
  if (agentType === "heavy") return getConfig().heavyRunnerContainerized;
  return false;
}

// ---------------------------------------------------------------------------
// Container queue — retries queued tasks when a slot frees up
// ---------------------------------------------------------------------------

interface QueuedContainerTask {
  taskId: string;
  agentType: AgentType;
  submission: TaskSubmission;
}

const containerQueue: QueuedContainerTask[] = [];

function enqueueContainerTask(
  taskId: string,
  agentType: AgentType,
  submission: TaskSubmission,
): void {
  containerQueue.push({ taskId, agentType, submission });
  log.info(
    { taskId, queueLength: containerQueue.length },
    "task queued for container slot",
  );
}

function drainContainerQueue(): void {
  while (containerQueue.length > 0) {
    const next = containerQueue[0];
    if (!acquireContainerSlot()) break;
    containerQueue.shift();
    log.info(
      { taskId: next.taskId },
      "dequeued task — container slot acquired",
    );
    dispatchWithSlot(next.taskId, next.agentType, next.submission).catch(
      (err) => {
        log.error({ err, taskId: next.taskId }, "queued task failed");
        updateTaskStatus(next.taskId, "failed", undefined, String(err));
        releaseContainerSlot();
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------

/**
 * Submit a new task. Classifies it, persists it, and dispatches to the
 * appropriate runner asynchronously.
 */
export async function submitTask(submission: TaskSubmission): Promise<{
  taskId: string;
  agentType: AgentType;
  classification: { score: number; reason: string; explicit: boolean };
}> {
  const db = getDatabase();
  const taskId = randomUUID();

  // Classify
  const classification = classify({
    title: submission.title,
    description: submission.description,
    tags: submission.tags,
    priority: submission.priority,
    agentType: submission.agentType,
  });

  // Insert task
  db.prepare(
    `
    INSERT INTO tasks (task_id, parent_task_id, spawn_type, title, description, priority, status, agent_type, classification, input, metadata)
    VALUES (@taskId, @parentTaskId, @spawnType, @title, @description, @priority, 'queued', @agentType, @classification, @input, @metadata)
  `,
  ).run({
    taskId,
    parentTaskId: submission.parentTaskId ?? null,
    spawnType: submission.spawnType ?? "root",
    title: submission.title,
    description: submission.description,
    priority: submission.priority ?? "medium",
    agentType: classification.agentType,
    classification: JSON.stringify(classification),
    input: submission.input ? JSON.stringify(submission.input) : null,
    metadata: submission.tags
      ? JSON.stringify({ tags: submission.tags, tools: submission.tools })
      : null,
  });

  // Emit event
  try {
    getEventBus().emitEvent("task.created", {
      task_id: taskId,
      title: submission.title,
      description: submission.description,
      priority: submission.priority ?? "medium",
      tags: submission.tags ?? [],
      created_by: "api",
    });
  } catch {
    // Event bus emission should not block task creation
  }

  // Dispatch asynchronously
  dispatchTask(taskId, classification.agentType, submission).catch((err) => {
    log.error({ err, taskId }, "failed to dispatch task");
    updateTaskStatus(taskId, "failed", undefined, String(err));
  });

  return {
    taskId,
    agentType: classification.agentType,
    classification: {
      score: classification.score,
      reason: classification.reason,
      explicit: classification.explicit,
    },
  };
}

/**
 * Dispatch a task to its runner. Handles concurrency for container-based runners.
 */
async function dispatchTask(
  taskId: string,
  agentType: AgentType,
  submission: TaskSubmission,
): Promise<void> {
  const runner = runners.get(agentType);
  if (!runner) {
    updateTaskStatus(
      taskId,
      "failed",
      undefined,
      `No runner registered for type: ${agentType}`,
    );
    return;
  }

  // Budget enforcement — block new tasks if any spending window exceeded
  const config = getConfig();
  if (config.budgetEnabled && isAnyWindowExceeded()) {
    const windows = getThreeWindowStatus();
    const exceeded = windows.hourly.exceeded
      ? `hourly ($${windows.hourly.limit.toFixed(2)})`
      : windows.daily.exceeded
        ? `daily ($${windows.daily.limit.toFixed(2)})`
        : `monthly ($${windows.monthly.limit.toFixed(2)})`;
    log.info({ taskId, exceeded }, "task blocked: budget exceeded");
    updateTaskStatus(
      taskId,
      "blocked",
      undefined,
      `Budget exceeded: ${exceeded} limit reached`,
    );
    return;
  }

  // Container concurrency check
  if (needsContainer(agentType)) {
    if (!acquireContainerSlot()) {
      enqueueContainerTask(taskId, agentType, submission);
      return;
    }
  }

  await dispatchWithSlot(taskId, agentType, submission);
}

/**
 * Execute a task that already has any required container slot acquired.
 * Releases the slot on completion.
 */
async function dispatchWithSlot(
  taskId: string,
  agentType: AgentType,
  submission: TaskSubmission,
): Promise<void> {
  const runner = runners.get(agentType);
  if (!runner) {
    updateTaskStatus(
      taskId,
      "failed",
      undefined,
      `No runner registered for type: ${agentType}`,
    );
    return;
  }

  const db = getDatabase();
  const runId = randomUUID();

  // Create run row
  db.prepare(
    `
    INSERT INTO runs (run_id, task_id, agent_type, status, input)
    VALUES (@runId, @taskId, @agentType, 'running', @input)
  `,
  ).run({
    runId,
    taskId,
    agentType,
    input: JSON.stringify({
      title: submission.title,
      description: submission.description,
    }),
  });

  // Atomic checkout: queued → running (CAS prevents double-dispatch)
  const claimId = `runner:${agentType}:${runId}`;
  const checkout = checkoutTask(taskId, claimId);
  if (!checkout.success) {
    log.info({ taskId, reason: checkout.reason }, "task checkout failed");
    // Roll back the run row we just created
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    if (needsContainer(agentType)) releaseContainerSlot();
    return;
  }

  const input: RunnerInput = {
    taskId,
    runId,
    title: submission.title,
    description: submission.description,
    tools: submission.tools,
    input: submission.input,
    parentTaskId: submission.parentTaskId,
    modelTier: getModelTierFromTask(taskId),
    conversationHistory: submission.conversationHistory,
    onTextChunk: submission.onTextChunk,
    signal: submission.abortController?.signal,
    interactive: submission.interactive,
  };

  taskStarted(agentType);
  try {
    const start = Date.now();
    const result = await runner.execute(input);
    const durationMs = Date.now() - start;

    // Update run
    db.prepare(
      `
      UPDATE runs SET
        status = @status,
        runner_status = @runnerStatus,
        output = @output,
        error = @error,
        token_usage = @tokenUsage,
        goal_graph = @goalGraph,
        trace = @trace,
        duration_ms = @durationMs,
        completed_at = datetime('now')
      WHERE run_id = @runId
    `,
    ).run({
      runId,
      status: result.success ? "completed" : "failed",
      runnerStatus: result.status ?? null,
      output: result.output ? JSON.stringify(result.output) : null,
      error: result.error ?? null,
      tokenUsage: result.tokenUsage ? JSON.stringify(result.tokenUsage) : null,
      goalGraph: result.goalGraph ? JSON.stringify(result.goalGraph) : null,
      trace: result.trace ? JSON.stringify(result.trace) : null,
      durationMs,
    });

    // Map runner status to task status
    let taskStatus: string;
    if (result.success) {
      taskStatus =
        result.status === "DONE_WITH_CONCERNS"
          ? "completed_with_concerns"
          : "completed";
    } else {
      if (result.status === "NEEDS_CONTEXT") taskStatus = "needs_context";
      else if (result.status === "BLOCKED") taskStatus = "blocked";
      else taskStatus = "failed";
    }

    // Required tool validation: check that critical tools were actually called
    if (submission.requiredTools?.length && result.success) {
      const calledTools = result.toolCalls ?? [];
      const missing = submission.requiredTools.filter(
        (t) => !calledTools.includes(t),
      );
      if (missing.length > 0) {
        if (submission._isRequiredToolRetry) {
          // Retry also failed — alert and give up
          log.error(
            { taskId, missingTools: missing },
            "required tools still missing after retry",
          );
          try {
            getEventBus().emitEvent("notification.warning", {
              title: "Required tools not called",
              message: `Task "${submission.title}" completed without calling: ${missing.join(", ")} (even after retry)`,
              source: "dispatcher",
              context: { taskId, missing },
            });
          } catch {
            /* event emission should not block */
          }
          updateTaskStatus(
            taskId,
            "failed",
            result.output,
            `Required tools not called after retry: ${missing.join(", ")}`,
          );
          return;
        }

        // First attempt — auto-retry once with explicit instruction
        log.warn(
          { taskId, missingTools: missing },
          "required tools missing, auto-retrying once",
        );
        const retrySubmission: TaskSubmission = {
          ...submission,
          description: `${submission.description}\n\nCRITICAL: You MUST call the following tools before completing this task: ${missing.join(", ")}. The previous attempt completed without calling them. Do not skip these tools.`,
          _isRequiredToolRetry: true,
        };
        submitTask(retrySubmission).catch((err) => {
          log.error({ err, taskId }, "required-tool retry failed");
        });
        // Mark original as failed with clear reason
        updateTaskStatus(
          taskId,
          "failed",
          result.output,
          `Required tools not called: ${missing.join(", ")}`,
        );
        return;
      }
    }

    updateTaskStatus(taskId, taskStatus, result.output, result.error);

    // Record cost in ledger (if budget feature is available and we have token data)
    if (result.tokenUsage) {
      try {
        // Prefer the model ID the inference layer actually invoked over the
        // config-derived label — under claude-sdk, cfg.inferencePrimaryModel
        // is an unused/stale string and would mislabel every row.
        const model = result.tokenUsage.actualModel ?? getModelFromTask(taskId);
        recordCost({
          runId,
          taskId,
          agentType,
          model,
          promptTokens: result.tokenUsage.promptTokens,
          completionTokens: result.tokenUsage.completionTokens,
          // Prefer provider-reported cost. The Anthropic SDK reports $0 under
          // Max auth (accurate) where calculateCost() would overstate using a
          // generic API rate card. Falls back to the pricing-table compute
          // when actualCostUsd is undefined (openai path, older callers).
          ...(result.tokenUsage.actualCostUsd !== undefined && {
            costUsdOverride: result.tokenUsage.actualCostUsd,
          }),
        });
      } catch {
        // Cost recording should never block task completion
      }
    }

    // Emit completion event
    try {
      if (result.success) {
        getEventBus().emitEvent("task.completed", {
          task_id: taskId,
          agent_id: agentType,
          result: result.output,
          duration_ms: durationMs,
        });
      } else {
        getEventBus().emitEvent("task.failed", {
          task_id: taskId,
          agent_id: agentType,
          error: result.error ?? "Unknown error",
          recoverable: false,
          attempts: 1,
        });
      }
    } catch {
      // Event emission should not block
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `
      UPDATE runs SET status = 'failed', error = @error, completed_at = datetime('now')
      WHERE run_id = @runId
    `,
    ).run({ runId, error: errorMsg });

    updateTaskStatus(taskId, "failed", undefined, errorMsg);
  } finally {
    taskCompleted(agentType);
    if (needsContainer(agentType)) {
      releaseContainerSlot();
    }
  }
}

// ---------------------------------------------------------------------------
// Model tier helper
// ---------------------------------------------------------------------------

/** Extract modelTier from the task's persisted classification JSON. */
function getModelTierFromTask(taskId: string): string | undefined {
  const task = getTask(taskId);
  if (!task?.classification) return undefined;
  try {
    const parsed = JSON.parse(task.classification);
    return parsed.modelTier;
  } catch {
    return undefined;
  }
}

/**
 * Extract the inference model name used for a task (for cost tracking).
 *
 * Called only as a fallback — callers prefer `result.tokenUsage.actualModel`
 * when the inference layer reports one. This function handles older paths
 * that don't thread actualModel through.
 *
 * Under `inferencePrimaryProvider='claude-sdk'`, `cfg.inferencePrimaryModel`
 * is typically empty string or a stale qwen-era value (the SDK auths via
 * ~/.claude/.credentials.json and picks its own model). Labeling every SDK
 * row with that stale string mislabels Sonnet traffic as qwen. Returning the
 * canonical Sonnet ID keeps `cost_ledger.model` attribution coherent.
 */
function getModelFromTask(taskId: string): string {
  const cfg = getConfig();
  if (cfg.inferencePrimaryProvider === "claude-sdk") {
    return SONNET_MODEL_ID;
  }
  const tier = getModelTierFromTask(taskId);
  if (tier === "capable" || tier === "standard")
    return cfg.inferencePrimaryModel;
  if (tier === "flash" && cfg.inferenceFallbackModel)
    return cfg.inferenceFallbackModel;
  return cfg.inferencePrimaryModel;
}

// ---------------------------------------------------------------------------
// Task status helpers
// ---------------------------------------------------------------------------

function updateTaskStatus(
  taskId: string,
  status: string,
  output?: unknown,
  error?: string,
): void {
  const db = getDatabase();

  if (status === "running") {
    db.prepare(
      `UPDATE tasks SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE task_id = ?`,
    ).run(taskId);
  } else if (status === "completed") {
    db.prepare(
      `UPDATE tasks SET status = 'completed', progress = 100, output = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ?`,
    ).run(output ? JSON.stringify(output) : null, taskId);
  } else if (status === "completed_with_concerns") {
    db.prepare(
      `UPDATE tasks SET status = 'completed_with_concerns', progress = 100, output = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ?`,
    ).run(output ? JSON.stringify(output) : null, taskId);
  } else if (status === "needs_context" || status === "blocked") {
    db.prepare(
      `UPDATE tasks SET status = ?, error = ?, updated_at = datetime('now') WHERE task_id = ?`,
    ).run(status, error ?? null, taskId);
  } else if (status === "failed") {
    db.prepare(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ?`,
    ).run(error ?? null, taskId);
  } else {
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE task_id = ?`,
    ).run(status, taskId);
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function getTask(taskId: string): TaskRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow) ?? null
  );
}

export function listTasks(filters: {
  status?: string;
  agentType?: string;
  parentTaskId?: string;
  limit?: number;
  offset?: number;
}): TaskRow[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.status) {
    conditions.push("status = @status");
    params.status = filters.status;
  }
  if (filters.agentType) {
    conditions.push("agent_type = @agentType");
    params.agentType = filters.agentType;
  }
  if (filters.parentTaskId) {
    conditions.push("parent_task_id = @parentTaskId");
    params.parentTaskId = filters.parentTaskId;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  return db
    .prepare(
      `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as TaskRow[];
}

export function getTaskWithRuns(
  taskId: string,
): { task: TaskRow; runs: RunRow[]; subtasks: TaskRow[] } | null {
  const task = getTask(taskId);
  if (!task) return null;

  const db = getDatabase();
  const runs = db
    .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC")
    .all(taskId) as RunRow[];
  const subtasks = db
    .prepare(
      "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
    )
    .all(taskId) as TaskRow[];

  return { task, runs, subtasks };
}

/**
 * Cancel a task and all its sub-tasks (cascade).
 */
export function cancelTask(taskId: string): boolean {
  const db = getDatabase();
  const task = getTask(taskId);
  if (!task) return false;
  if (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  ) {
    return false;
  }

  // Atomic cancel: task + runs + subtask cascade in one transaction
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ?`,
    ).run(taskId);

    db.prepare(
      `UPDATE runs SET status = 'cancelled', completed_at = datetime('now') WHERE task_id = ? AND status = 'running'`,
    ).run(taskId);

    const subtasks = db
      .prepare(
        "SELECT task_id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
      )
      .all(taskId) as { task_id: string }[];
    for (const sub of subtasks) {
      cancelTask(sub.task_id);
    }
  })();

  try {
    getEventBus().emitEvent("task.cancelled", {
      task_id: taskId,
      cancelled_by: "api",
      reason: "User requested cancellation",
    });
  } catch {
    // Event emission should not block
  }

  return true;
}
