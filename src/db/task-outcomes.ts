/**
 * Task outcome tracking — SQLite CRUD for the task_outcomes table.
 *
 * Records classification decisions, runner performance, and user feedback
 * for each completed messaging task. Feeds the adaptive classifier (v2.9.3)
 * and enrichment service (v2.9.2).
 */

import { getDatabase } from "./index.js";

export interface TaskOutcome {
  task_id: string;
  classified_as: string;
  ran_on: string;
  tools_used: string[];
  duration_ms: number;
  success: boolean;
  tags: string[];
}

export interface OutcomeFilter {
  ran_on?: string;
  tags?: string[];
  success?: boolean;
  limit?: number;
  days?: number;
}

export interface OutcomeRow {
  id: number;
  task_id: string;
  classified_as: string;
  ran_on: string;
  tools_used: string;
  duration_ms: number;
  success: number;
  feedback_signal: string;
  tags: string;
  created_at: string;
}

/** Record a task outcome after completion. */
export function recordOutcome(outcome: TaskOutcome): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    outcome.task_id,
    outcome.classified_as,
    outcome.ran_on,
    JSON.stringify(outcome.tools_used),
    outcome.duration_ms,
    outcome.success ? 1 : 0,
    JSON.stringify(outcome.tags),
  );
}

/** Query recent outcomes with optional filters. */
export function queryOutcomes(filter: OutcomeFilter = {}): OutcomeRow[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.ran_on) {
    conditions.push("ran_on = ?");
    params.push(filter.ran_on);
  }

  if (filter.success !== undefined) {
    conditions.push("success = ?");
    params.push(filter.success ? 1 : 0);
  }

  if (filter.days) {
    conditions.push("created_at >= datetime('now', '-' || ? || ' days')");
    params.push(filter.days);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 50;
  params.push(limit);

  return db
    .prepare(
      `SELECT * FROM task_outcomes ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as OutcomeRow[];
}

/** Update feedback signal for a task outcome. */
export function updateFeedback(
  taskId: string,
  signal: "positive" | "negative" | "rephrase" | "neutral",
): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE task_outcomes SET feedback_signal = ? WHERE task_id = ?",
  ).run(signal, taskId);
}
