/**
 * Outcome-aware metadata tagging — derives a `outcome:*` tag from task status
 * so memories carry their origin's success/concerns/failed signal forward.
 *
 * Closes the poison-source class from Session 114: a task with
 * `status='completed_with_concerns'` whose body narrated a failure was
 * recalled later as a positive precedent because nothing on the memory row
 * distinguished "this is a success story" from "this is a failure story."
 *
 * Tagging happens at write time on every Hindsight retain call site (router
 * + auto-persist). The tag rides on the existing `tags` array so no schema
 * change is needed. Recall-side filtering on the tag is a follow-up that
 * benefits from a week of distribution data first.
 *
 * Coverage gap closed 2026-05-07 (queue item #7 part 1):
 *   `handleTaskFailed` and a new `handleTaskCancelled` in router.ts now both
 *   call `retain()` with the same outcome-tagged tags array, so
 *   `outcome:failed` rows populate in production. The recall-side bias that
 *   uses these rows lands in Part 2 of the same queue item (drop or
 *   down-rank `outcome:failed` recalls by default).
 */

import { getDatabase } from "../db/index.js";

export type OutcomeTag =
  | "outcome:success"
  | "outcome:concerns"
  | "outcome:failed"
  | "outcome:unknown";

/**
 * Map a tasks.status value to an outcome tag.
 * Pure function — exposed for testing without DB.
 *
 * Keep this switch in sync with `src/db/schema.sql:11` (tasks.status CHECK).
 * Status enum (observed in production 2026-04-29 + dispatcher.ts updates):
 *   completed              → success
 *   completed_with_concerns → concerns
 *   failed                  → failed
 *   blocked                 → failed (didn't reach success)
 *   cancelled               → failed (early termination)
 *   needs_context           → unknown (incomplete signal)
 *   running / pending / etc. → unknown (task hasn't terminated yet —
 *                              shouldn't happen at retain time but be safe)
 *   anything else / null    → unknown
 */
export function statusToOutcomeTag(
  status: string | null | undefined,
): OutcomeTag {
  if (!status) return "outcome:unknown";
  switch (status) {
    case "completed":
      return "outcome:success";
    case "completed_with_concerns":
      return "outcome:concerns";
    case "failed":
    case "blocked":
    case "cancelled":
      return "outcome:failed";
    default:
      return "outcome:unknown";
  }
}

/**
 * Look up a task's status from mc.db and return the corresponding outcome tag.
 * Fails safely to "outcome:unknown" — instrumentation must never break the
 * retain path (which is itself fire-and-forget upstream).
 *
 * Performance: tasks.task_id has both UNIQUE constraint and idx_tasks_task_id
 * (schema.sql:5 + 29) so this is an O(log n) point lookup. Better-sqlite3 in
 * WAL mode reads from a consistent snapshot, so a concurrent UPDATE on the
 * same row will not corrupt the read.
 */
export function getOutcomeTag(taskId: string | null | undefined): OutcomeTag {
  if (!taskId) return "outcome:unknown";
  try {
    const db = getDatabase();
    const row = db
      .prepare("SELECT status FROM tasks WHERE task_id = ?")
      .get(taskId) as { status: string | null } | undefined;
    return statusToOutcomeTag(row?.status);
  } catch {
    // DB not initialized, contention, or schema drift — degrade silently.
    return "outcome:unknown";
  }
}
