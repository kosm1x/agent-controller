/**
 * Completion facts — one row per task that started running, in
 * task_completion_facts, for every kind of task (chat, ritual, scheduled,
 * proactive, swarm child, API). The dispatcher writes the row with the build
 * the process runs when it marks the task running, so a task that later
 * throws, is cancelled, misses its required tools or is closed by the
 * watchdog or the start-up orphan close keeps the build it started on. The
 * first runner concern is added when the task ends on the dispatcher's normal
 * terminal path. A task that never starts running (no runner, blocked by the
 * budget, cancelled while queued) has no row: it ran on no build. No tool,
 * prompt or route of the service reads this table; the operator's complaints
 * digest (scripts/complaints-digest.sh, its SQL in src/complaints/query.ts)
 * reads it read-only for the concern text and the build, and the operator's
 * one-off password scrub (scripts/prune-mailbox-passwords.ts) rewrites
 * matching values in its concern text.
 */

import { getDatabase } from "./index.js";
import { cleanConcernDetail } from "./task-outcomes.js";

export interface CompletionFacts {
  /** Short commit id of the running build; null when unknown. */
  build: string | null;
  /** The runner's first concern, raw; stored cleaned by cleanConcernDetail. */
  concernDetail: unknown;
}

/**
 * Writes the task's row when it is marked running: the build, no concern
 * detail, the database's own time. One row per task id: a second call
 * replaces it. Throws on a database failure.
 */
export function recordTaskBuild(taskId: string, build: string | null): void {
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO task_completion_facts (task_id, build, concern_detail) VALUES (?, ?, NULL)",
    )
    .run(taskId, build);
}

/**
 * Adds the concern detail at the normal end. An existing row keeps the build
 * and creation time written at the start; with no row (the start write
 * failed) the full row is written. Throws on a database failure.
 */
export function recordCompletionFacts(
  taskId: string,
  facts: CompletionFacts,
): void {
  getDatabase()
    .prepare(
      "INSERT INTO task_completion_facts (task_id, build, concern_detail) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET concern_detail = excluded.concern_detail",
    )
    .run(taskId, facts.build, cleanConcernDetail(facts.concernDetail));
}
