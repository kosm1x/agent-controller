/**
 * tasks/runs retention — archive-then-delete of aged-out terminal tasks.
 *
 * Why (2026-07-05 efficiency audit, Phase 4.4): `tasks` (140 MB) + `runs`
 * (138 MB) were 62% of the whole DB and grew unbounded — ballooning the WAL,
 * the nightly offsite backups, and every scan. Operator-approved window:
 * 90 days (2026-07-05).
 *
 * Safety invariants:
 *  - Only TERMINAL statuses are ever touched (completed, completed_with_concerns,
 *    failed, cancelled). In-flight work (running/pending/queued/needs_context)
 *    is excluded by the status filter, not by timing.
 *  - A parent task is only deleted when its ENTIRE subtree is also being
 *    deleted (fixpoint exclusion) — no orphaned children, and an old parent
 *    with a live retry-child survives.
 *  - Rows are archived to a gzipped JSONL under data/archive/ BEFORE deletion.
 *  - Deletes run in batched transactions via writeWithRetry, runs before
 *    tasks (runs.task_id has an FK on tasks).
 *  - task_outcomes rows for deleted tasks are pruned too (analytics windows
 *    are ≤30d; keeping 90d+ orphaned outcome rows only skews joins).
 *    cost_ledger is NEVER touched — spend history stays complete.
 *
 * Disk note: SQLite reuses freed pages, so the file stops GROWING but does
 * not shrink without a manual VACUUM (operator action — blocks writes).
 */

import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, writeWithRetry } from "./index.js";

/**
 * Operator-approved retention window (2026-07-05). Env-overridable, read per
 * sweep so tests and live re-tuning don't need a restart. Guard rail: never
 * allow a window under 14 days — a typo'd "9" or "0" must not mass-delete
 * recent history.
 */
function retentionDays(): number {
  const raw = process.env.TASKS_RETENTION_DAYS;
  const n = raw ? Number(raw) : 90;
  return Number.isFinite(n) && n >= 14 ? Math.floor(n) : 90;
}

const TERMINAL_STATUSES = [
  "completed",
  "completed_with_concerns",
  "failed",
  "cancelled",
] as const;

/** Per-transaction delete batch — bounds write-lock hold time. */
const BATCH_SIZE = 500;

export interface RetentionReport {
  cutoff: string;
  candidates: number;
  skippedParents: number;
  tasksDeleted: number;
  runsDeleted: number;
  outcomesDeleted: number;
  archivePath: string | null;
}

/**
 * Run one retention sweep. Returns counts; writes the archive file only when
 * there is something to delete. Exported for tests and the daily cron.
 */
export function runTasksRetention(
  dataDir = "./data",
  now = new Date(),
): RetentionReport {
  const db = getDatabase();
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  const statusList = TERMINAL_STATUSES.map(() => "?").join(",");
  // Age by the latest lifecycle timestamp we have — a task completed recently
  // but created long ago must NOT be deleted.
  const candidates = db
    .prepare(
      `SELECT task_id, parent_task_id FROM tasks
       WHERE status IN (${statusList})
         AND COALESCE(completed_at, updated_at, created_at) < ?`,
    )
    .all(...TERMINAL_STATUSES, cutoff) as Array<{
    task_id: string;
    parent_task_id: string | null;
  }>;

  const report: RetentionReport = {
    cutoff,
    candidates: candidates.length,
    skippedParents: 0,
    tasksDeleted: 0,
    runsDeleted: 0,
    outcomesDeleted: 0,
    archivePath: null,
  };
  if (candidates.length === 0) return report;

  // Fixpoint exclusion: drop any candidate that has a child OUTSIDE the
  // delete set (in-flight or too recent). Loop because removing a parent
  // can expose ITS parent to the same rule.
  const deletable = new Set(candidates.map((c) => c.task_id));
  const childrenByParent = db
    .prepare(
      `SELECT parent_task_id AS parent, task_id AS child FROM tasks
       WHERE parent_task_id IS NOT NULL`,
    )
    .all() as Array<{ parent: string; child: string }>;
  let changed = true;
  while (changed) {
    changed = false;
    for (const { parent, child } of childrenByParent) {
      if (deletable.has(parent) && !deletable.has(child)) {
        deletable.delete(parent);
        report.skippedParents++;
        changed = true;
      }
    }
  }
  if (deletable.size === 0) return report;

  const ids = [...deletable];

  // Archive BEFORE delete: full task + run rows as JSONL, gzipped.
  const archiveDir = join(dataDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const archivePath = join(archiveDir, `tasks-retention-${stamp}.jsonl.gz`);
  const lines: string[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const ph = batch.map(() => "?").join(",");
    for (const row of db
      .prepare(`SELECT * FROM tasks WHERE task_id IN (${ph})`)
      .all(...batch)) {
      lines.push(JSON.stringify({ table: "tasks", row }));
    }
    for (const row of db
      .prepare(`SELECT * FROM runs WHERE task_id IN (${ph})`)
      .all(...batch)) {
      lines.push(JSON.stringify({ table: "runs", row }));
    }
  }
  writeFileSync(archivePath, gzipSync(lines.join("\n") + "\n"));
  report.archivePath = archivePath;

  // Batched deletes: runs first (FK), then outcomes, then tasks. Counts are
  // RETURNED from the retry callback, never accumulated inside it — on a
  // SQLITE_BUSY retry the tx rolls back but an outer `+=` would keep the
  // failed attempt's count (see feedback_accumulator_outside_retry).
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const ph = batch.map(() => "?").join(",");
    const res = writeWithRetry(() =>
      db.transaction(() => {
        const runs = db
          .prepare(`DELETE FROM runs WHERE task_id IN (${ph})`)
          .run(...batch).changes;
        const outcomes = db
          .prepare(`DELETE FROM task_outcomes WHERE task_id IN (${ph})`)
          .run(...batch).changes;
        const tasks = db
          .prepare(`DELETE FROM tasks WHERE task_id IN (${ph})`)
          .run(...batch).changes;
        return { runs, outcomes, tasks };
      })(),
    );
    report.runsDeleted += res.runs;
    report.outcomesDeleted += res.outcomes;
    report.tasksDeleted += res.tasks;
  }

  return report;
}
