/**
 * Reaction store — SQLite CRUD for the reactions table.
 *
 * Self-creating table (same pattern as the events table in bus.ts).
 * No schema.sql modification required.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type {
  ReactionTrigger,
  ReactionAction,
  ReactionStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactionRow {
  id: number;
  reaction_id: string;
  trigger_type: string;
  source_task_id: string;
  spawned_task_id: string | null;
  action: string;
  status: string;
  attempt: number;
  max_attempts: number;
  metadata: string;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Table creation
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reaction_id     TEXT UNIQUE NOT NULL,
  trigger_type    TEXT NOT NULL,
  source_task_id  TEXT NOT NULL,
  spawned_task_id TEXT,
  action          TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',
  attempt         INTEGER DEFAULT 1,
  max_attempts    INTEGER DEFAULT 3,
  metadata        TEXT DEFAULT '{}',
  created_at      TEXT DEFAULT (datetime('now')),
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reactions_source ON reactions(source_task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reactions_status ON reactions(status);
`;

/**
 * Ensure the reactions table and required indexes exist. Idempotent.
 * Also adds indexes on existing tables needed by reaction queries
 * (avoids schema.sql changes that require DB reset).
 */
export function ensureReactionsTable(db: Database.Database): void {
  db.exec(CREATE_TABLE_SQL);

  // Indexes for reaction engine queries on existing tables.
  // task_outcomes: countRecentClassificationFailures() filters on (classified_as, success, created_at)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_outcomes_classified_date ON task_outcomes(classified_as, success, created_at DESC)`,
  );
  // tasks: checkStuckTasks() filters on (status, started_at) for running tasks
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_status_started ON tasks(status, started_at)`,
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Record a new reaction. Returns the generated reaction_id. */
export function recordReaction(
  db: Database.Database,
  params: {
    trigger: ReactionTrigger;
    sourceTaskId: string;
    spawnedTaskId?: string | null;
    action: ReactionAction;
    attempt: number;
    maxAttempts?: number;
    metadata?: Record<string, unknown>;
  },
): string {
  const reactionId = randomUUID();
  db.prepare(
    `INSERT INTO reactions (reaction_id, trigger_type, source_task_id, spawned_task_id, action, status, attempt, max_attempts, metadata)
     VALUES (?, ?, ?, ?, ?, 'executing', ?, ?, ?)`,
  ).run(
    reactionId,
    params.trigger,
    params.sourceTaskId,
    params.spawnedTaskId ?? null,
    params.action,
    params.attempt,
    params.maxAttempts ?? 3,
    JSON.stringify(params.metadata ?? {}),
  );
  return reactionId;
}

/** Get all reactions for a source task, ordered by creation time. */
export function getReactionsBySourceTask(
  db: Database.Database,
  sourceTaskId: string,
): ReactionRow[] {
  return db
    .prepare(
      "SELECT * FROM reactions WHERE source_task_id = ? ORDER BY created_at ASC",
    )
    .all(sourceTaskId) as ReactionRow[];
}

/** Count reactions for a source task (for attempt tracking). */
export function countReactionsForTask(
  db: Database.Database,
  sourceTaskId: string,
): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM reactions WHERE source_task_id = ?")
    .get(sourceTaskId) as { cnt: number };
  return row.cnt;
}

/**
 * Count failures in the last 24h for a given classification.
 * Uses task_outcomes table (existing infrastructure).
 */
export function countRecentClassificationFailures(
  db: Database.Database,
  classifiedAs: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM task_outcomes
       WHERE classified_as = ? AND success = 0
       AND created_at >= datetime('now', '-1 day')`,
    )
    .get(classifiedAs) as { cnt: number };
  return row.cnt;
}

/** Update the status of a reaction. */
export function updateReactionStatus(
  db: Database.Database,
  reactionId: string,
  status: ReactionStatus,
): void {
  const completedAt =
    status === "completed" || status === "failed" ? "datetime('now')" : "NULL";
  db.prepare(
    `UPDATE reactions SET status = ?, completed_at = ${completedAt} WHERE reaction_id = ?`,
  ).run(status, reactionId);
}

/** Get the most recent reaction for a source task (for cooldown checks). */
export function getLatestReaction(
  db: Database.Database,
  sourceTaskId: string,
): ReactionRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM reactions WHERE source_task_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sourceTaskId) as ReactionRow) ?? null
  );
}
