/**
 * Dormant-objective detector — V8.1 Phase 5, spec §8.
 *
 * A NorthStar objective with no linked task activity for over two weeks (or
 * none ever) — momentum has quietly drained from a stated goal.
 *
 * RECONCILIATION vs spec §8:
 *   - The spec query filters `obj.qualifier != 'archived'`, but the
 *     `jarvis_files.qualifier` CHECK has no `'archived'` value (a known
 *     schema-enum gap). The filter is dropped; all `NorthStar/objectives/*`
 *     files are scanned. Archived-objective exclusion is a follow-up once
 *     the qualifier enum is reconciled.
 *   - The task↔objective link is `tasks.metadata LIKE '%<path>%'` — a coarse
 *     substring match (the spec's own join). It can miss a task that
 *     references the objective by id rather than path; it is the best signal
 *     available pre-Phase-6. `days_dormant` is computed in JS rather than via
 *     a SQL alias in HAVING.
 */

import { getDatabase } from "../db/index.js";
import type { DormantObjectiveSignal } from "./signals.js";

/** An objective is "dormant" after this many days with no task activity. */
const DORMANT_DAYS = 14;
const MS_PER_DAY = 86_400_000;

interface ObjectiveRow {
  path: string;
  title: string;
  last_task_activity: string | null;
}

/**
 * Detect dormant NorthStar objectives (spec §8).
 *
 * @param dormantDays - dormancy threshold in days (default 14).
 */
export function detectDormantObjectives(
  dormantDays: number = DORMANT_DAYS,
): DormantObjectiveSignal[] {
  const rows = getDatabase()
    .prepare(
      `SELECT obj.path, obj.title, MAX(t.updated_at) AS last_task_activity
         FROM jarvis_files obj
         LEFT JOIN tasks t ON t.metadata LIKE '%' || obj.path || '%'
        WHERE obj.path LIKE 'NorthStar/objectives/%'
        GROUP BY obj.path, obj.title`,
    )
    .all() as ObjectiveRow[];

  const now = Date.now();
  const signals: DormantObjectiveSignal[] = [];
  for (const r of rows) {
    let daysDormant: number | null = null;
    if (r.last_task_activity) {
      const ageMs = now - new Date(r.last_task_activity + "Z").getTime();
      daysDormant = Math.floor(ageMs / MS_PER_DAY);
    }
    // Flag: never had a task (null) OR dormant past the threshold.
    if (daysDormant !== null && daysDormant <= dormantDays) continue;

    signals.push({
      kind: "dormant_objective",
      severity: "info",
      summary:
        daysDormant === null
          ? `Objective "${r.title}" has no task activity on record`
          : `Objective "${r.title}" dormant ${daysDormant}d`,
      objectivePath: r.path,
      title: r.title,
      daysDormant,
      lastTaskActivity: r.last_task_activity,
    });
  }
  return signals;
}
