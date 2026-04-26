/**
 * Prometheus Snapshot — persist and restore execution state for resume.
 *
 * When orchestrate() exits early (timeout, budget, abort), the full state
 * is saved to SQLite. A subsequent run can resume from where it left off
 * because GoalGraph.getReady() naturally skips completed goals.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import type { Goal, GoalResult, OrchestratorConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrometheusSnapshot {
  taskId: string;
  goalGraph: { goals: Record<string, Goal> };
  goalResults: Record<string, GoalResult>;
  executionState: {
    budgetConsumed: number;
    replanCount: number;
    tokenUsage: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    };
    traceEvents: Array<Record<string, unknown>>;
  };
  taskDescription: string;
  toolNames: string[] | null;
  config: Partial<OrchestratorConfig> | null;
  exitReason: "timeout" | "budget_exhausted" | "aborted";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_TTL_MS = 60 * 60_000; // 1 hour

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save execution state for potential resume.
 */
export function saveSnapshot(snapshot: PrometheusSnapshot): void {
  const db = getDatabase();
  // Clear prior snapshots for this task to prevent unbounded accumulation
  writeWithRetry(() =>
    db
      .prepare("DELETE FROM prometheus_snapshots WHERE task_id = ?")
      .run(snapshot.taskId),
  );
  writeWithRetry(() =>
    db
      .prepare(
        `INSERT INTO prometheus_snapshots
         (task_id, goal_graph, goal_results, execution_state, task_description, tool_names, config, exit_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.taskId,
        JSON.stringify(snapshot.goalGraph),
        JSON.stringify(snapshot.goalResults),
        JSON.stringify(snapshot.executionState),
        snapshot.taskDescription,
        snapshot.toolNames ? JSON.stringify(snapshot.toolNames) : null,
        snapshot.config ? JSON.stringify(snapshot.config) : null,
        snapshot.exitReason,
      ),
  );
  console.log(
    `[snapshot] Saved for task ${snapshot.taskId} (${snapshot.exitReason}, ${Object.keys(snapshot.goalResults).length} completed goals)`,
  );
}

/**
 * Load the most recent snapshot for a task (within TTL).
 * Returns null if no snapshot exists or it's expired.
 */
export function loadSnapshot(taskId: string): PrometheusSnapshot | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM prometheus_snapshots
       WHERE task_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(taskId) as
    | {
        task_id: string;
        goal_graph: string;
        goal_results: string;
        execution_state: string;
        task_description: string;
        tool_names: string | null;
        config: string | null;
        exit_reason: string;
        created_at: string;
      }
    | undefined;

  if (!row) return null;

  // TTL check
  const age = Date.now() - new Date(row.created_at + "Z").getTime();
  if (age > SNAPSHOT_TTL_MS) {
    clearSnapshot(taskId);
    return null;
  }

  return {
    taskId: row.task_id,
    goalGraph: JSON.parse(row.goal_graph),
    goalResults: JSON.parse(row.goal_results),
    executionState: JSON.parse(row.execution_state),
    taskDescription: row.task_description,
    toolNames: row.tool_names ? JSON.parse(row.tool_names) : null,
    config: row.config ? JSON.parse(row.config) : null,
    exitReason: row.exit_reason as PrometheusSnapshot["exitReason"],
    createdAt: row.created_at,
  };
}

/**
 * Delete all snapshots for a task (after successful resume or cleanup).
 */
export function clearSnapshot(taskId: string): void {
  try {
    const db = getDatabase();
    writeWithRetry(() =>
      db
        .prepare("DELETE FROM prometheus_snapshots WHERE task_id = ?")
        .run(taskId),
    );
  } catch {
    // best-effort
  }
}
