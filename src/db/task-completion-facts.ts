/**
 * Completion facts — one row per finished task in task_completion_facts:
 * the build the process ran on and the first runner concern, for every kind
 * of task (chat, ritual, scheduled, proactive, swarm child, API) that ends on
 * the dispatcher's normal terminal path; a thrown, cancelled or required-tools
 * end, and a watchdog or start-up orphan close, gets no row. Storage only: no
 * tool, prompt or route reads this table.
 */

import { getDatabase } from "./index.js";
import { cleanConcernDetail } from "./task-outcomes.js";

export interface CompletionFacts {
  /** Short commit id of the running build; null when unknown. */
  build: string | null;
  /** The runner's first concern, raw; stored cleaned by cleanConcernDetail. */
  concernDetail: unknown;
}

/** Writes (or replaces) the task's row. Throws on a database failure. */
export function recordCompletionFacts(
  taskId: string,
  facts: CompletionFacts,
): void {
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO task_completion_facts (task_id, build, concern_detail) VALUES (?, ?, ?)",
    )
    .run(taskId, facts.build, cleanConcernDetail(facts.concernDetail));
}
