/**
 * Atomic task checkout using SQLite UPDATE WHERE as a Compare-And-Swap (CAS).
 *
 * Prevents double-dispatch by ensuring only one runner can transition a task
 * from 'queued' to 'running'. Uses the existing `assigned_to` column.
 */

import { getDatabase } from "../db/index.js";

export interface CheckoutResult {
  success: boolean;
  taskId: string;
  reason?: "already_claimed" | "not_found" | "invalid_status";
}

/**
 * Atomically transition a task from 'queued' to 'running'.
 * Returns success=false if the task is not in 'queued' status.
 */
export function checkoutTask(
  taskId: string,
  claimedBy: string,
): CheckoutResult {
  const db = getDatabase();

  const result = db
    .prepare(
      `UPDATE tasks
       SET status = 'running',
           assigned_to = ?,
           started_at = datetime('now'),
           updated_at = datetime('now')
       WHERE task_id = ? AND status = 'queued'`,
    )
    .run(claimedBy, taskId);

  if (result.changes === 0) {
    const row = db
      .prepare("SELECT status FROM tasks WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;

    if (!row) return { success: false, taskId, reason: "not_found" };
    return { success: false, taskId, reason: "already_claimed" };
  }

  return { success: true, taskId };
}

/**
 * Release a checkout, returning the task to 'queued'.
 * Only succeeds if the task is 'running' AND assigned_to matches.
 */
export function releaseCheckout(taskId: string, claimedBy: string): boolean {
  const db = getDatabase();

  const result = db
    .prepare(
      `UPDATE tasks
       SET status = 'queued',
           assigned_to = NULL,
           started_at = NULL,
           updated_at = datetime('now')
       WHERE task_id = ? AND status = 'running' AND assigned_to = ?`,
    )
    .run(taskId, claimedBy);

  return result.changes > 0;
}
