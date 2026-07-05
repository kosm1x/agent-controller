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
 *  - Rows are archived to a gzipped JSONL under data/archive/ BEFORE deletion
 *    (archives themselves rotate after a year — no unbounded artifact).
 *  - FK discipline under foreign_keys=ON: within each batch tx, FK-holding
 *    rows delete first (runs, a2a_contexts) and ACROSS batches tasks delete
 *    leaf-first (depth sort), so a parent is never removed in an earlier
 *    batch than one of its children (tasks.parent_task_id is a self-FK).
 *  - task_outcomes rows for deleted tasks are pruned too (analytics windows
 *    are ≤30d; keeping 90d+ orphaned outcome rows only skews joins).
 *    cost_ledger is NEVER touched — spend history stays complete.
 *
 * Disk note: SQLite reuses freed pages, so the file stops GROWING but does
 * not shrink without a manual VACUUM (operator action — blocks writes).
 */

import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { getDatabase, writeWithRetry } from "./index.js";

/** Keep sweep archives for a year, then drop them (best-effort). */
const ARCHIVE_RETENTION_MS = 365 * 86_400_000;

function pruneOldArchives(archiveDir: string, now: Date): void {
  try {
    for (const f of readdirSync(archiveDir)) {
      if (!f.startsWith("tasks-retention-")) continue;
      const p = join(archiveDir, f);
      if (now.getTime() - statSync(p).mtimeMs > ARCHIVE_RETENTION_MS) {
        rmSync(p, { force: true });
      }
    }
  } catch {
    // best-effort — never fail a sweep over archive housekeeping
  }
}

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

  // LEAF-FIRST ordering (R1 audit fix): tasks.parent_task_id is a
  // self-referential FK with foreign_keys=ON, and deletes run in 500-row
  // batches, each its own transaction. A parent deleted in batch N while its
  // child waits in batch N+1 fails the FK check at statement end. Sorting by
  // subtree depth (deepest first) guarantees every child is deleted in the
  // same or an earlier batch than its parent. (Within one statement SQLite
  // checks immediate FKs at statement conclusion, so same-batch pairs are
  // fine in either order — the sort covers the cross-batch case.)
  const parentOf = new Map<string, string>();
  for (const { parent, child } of childrenByParent) {
    if (deletable.has(child) && deletable.has(parent)) {
      parentOf.set(child, parent);
    }
  }
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const hit = depthCache.get(id);
    if (hit !== undefined) return hit;
    const parent = parentOf.get(id);
    const d = parent ? depthOf(parent) + 1 : 0;
    depthCache.set(id, d);
    return d;
  };
  const ids = [...deletable].sort((x, y) => depthOf(y) - depthOf(x));

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

  // Batched deletes: FK holders first (runs, a2a_contexts), then outcomes,
  // then tasks (leaf-first across batches — see the sort above). Counts are
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
        db.prepare(`DELETE FROM a2a_contexts WHERE task_id IN (${ph})`).run(
          ...batch,
        );
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

  // Archive rotation (R1 audit fix): without this, data/archive/ grows one
  // gzip per sweep forever — a retention feature must not spawn its own
  // unbounded artifact. 365d keeps a year of recovery window.
  pruneOldArchives(archiveDir, now);

  return report;
}
