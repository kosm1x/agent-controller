/**
 * Stalled-task detector — V8.1 Phase 5, spec §8 Layer 1 (the SQL pre-filter).
 *
 * Catches silent abandonment: a task left running / queued / needs_context /
 * blocked with no activity for over a week. Cheap and deterministic.
 *
 * RECONCILIATION vs spec §8: the spec's Layer 2 (the LLM-judged tri-boolean
 * progress ledger — `task_progress_ledgers`, `n_stalls`/`max_stalls`) is an
 * LLM judgment, not a query; it is not in §12's Phase 5 task list and is
 * deferred to the judgment phase (Phase 6). Also: §8's SQL references the
 * `days_since_activity` alias in its own WHERE — SQLite does not allow a
 * SELECT alias in WHERE, so the expression is repeated.
 */

import { getDatabase } from "../db/index.js";
import type { StalledTaskSignal } from "./signals.js";

/** A task is "stalled" once it has been non-terminal and untouched this long. */
const STALLED_DAYS = 7;
/** Non-terminal statuses a stalled task can sit in (spec §8). */
const STALLED_STATUSES = ["running", "queued", "needs_context", "blocked"];
/** Defensive cap — the briefing only needs the worst offenders. */
const MAX_SIGNALS = 100;

interface StalledRow {
  task_id: string;
  title: string;
  status: string;
  priority: string;
  days_since_activity: number;
}

/**
 * Detect stalled tasks (spec §8 Layer 1).
 *
 * @param stalledDays - activity-gap threshold in days (default 7).
 */
export function detectStalledTasks(
  stalledDays: number = STALLED_DAYS,
): StalledTaskSignal[] {
  const placeholders = STALLED_STATUSES.map(() => "?").join(",");
  // RECONCILIATION: §8's `ORDER BY priority DESC` is wrong — `priority` is a
  // TEXT enum, so DESC sorts it alphabetically (medium > low > high >
  // critical), not by severity. Rank it with an explicit CASE instead.
  const rows = getDatabase()
    .prepare(
      `SELECT task_id, title, status, priority,
              (julianday('now') - julianday(updated_at)) AS days_since_activity
         FROM tasks
        WHERE status IN (${placeholders})
          AND (julianday('now') - julianday(updated_at)) > ?
        ORDER BY CASE priority
                   WHEN 'critical' THEN 4 WHEN 'high' THEN 3
                   WHEN 'medium'   THEN 2 WHEN 'low'  THEN 1
                   ELSE 0 END DESC,
                 days_since_activity DESC
        LIMIT ?`,
    )
    .all(...STALLED_STATUSES, stalledDays, MAX_SIGNALS) as StalledRow[];

  return rows.map((r) => {
    const days = Math.floor(r.days_since_activity);
    return {
      kind: "stalled_task",
      severity: "at_risk",
      summary: `Task "${r.title}" (${r.priority}) stalled ${days}d in status ${r.status}`,
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      daysSinceActivity: days,
    };
  });
}
