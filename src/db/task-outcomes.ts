/**
 * Task outcome tracking — SQLite CRUD for the task_outcomes table.
 *
 * Records classification decisions, runner performance, and user feedback
 * for each completed messaging task. Feeds the adaptive classifier (v2.9.3)
 * and enrichment service (v2.9.2).
 */

import { getDatabase, writeWithRetry } from "./index.js";

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
  writeWithRetry(() =>
    db
      .prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.task_id,
        outcome.classified_as,
        outcome.ran_on,
        JSON.stringify(outcome.tools_used),
        outcome.duration_ms,
        outcome.success ? 1 : 0,
        JSON.stringify(outcome.tags),
      ),
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

// ---------------------------------------------------------------------------
// Aggregation queries (feeds evolution ritual)
// ---------------------------------------------------------------------------

export interface ToolEffectiveness {
  tool: string;
  classified_as: string;
  total_uses: number;
  success_count: number;
  success_rate: number;
}

/** Per-tool success rate grouped by classification. Uses json_each() on tools_used. */
export function aggregateToolEffectiveness(days: number): ToolEffectiveness[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT
         j.value AS tool,
         classified_as,
         COUNT(*) AS total_uses,
         SUM(success) AS success_count,
         ROUND(CAST(SUM(success) AS REAL) / COUNT(*) * 100, 1) AS success_rate
       FROM task_outcomes, json_each(tools_used) AS j
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY j.value, classified_as
       ORDER BY total_uses DESC
       LIMIT 30`,
    )
    .all(days) as ToolEffectiveness[];
}

export interface RunnerPerformance {
  ran_on: string;
  total: number;
  successes: number;
  avg_duration_ms: number;
  success_rate: number;
}

/** Daily runner performance summary over the last N days. */
export function aggregateRunnerPerformance(days: number): RunnerPerformance[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT
         ran_on,
         COUNT(*) AS total,
         SUM(success) AS successes,
         ROUND(AVG(duration_ms)) AS avg_duration_ms,
         ROUND(CAST(SUM(success) AS REAL) / COUNT(*) * 100, 1) AS success_rate
       FROM task_outcomes
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY ran_on
       ORDER BY ran_on DESC`,
    )
    .all(days) as RunnerPerformance[];
}

// ---------------------------------------------------------------------------
// Enhanced classifier feedback queries
// ---------------------------------------------------------------------------

export interface RunnerStats {
  ran_on: string;
  total: number;
  successes: number;
  avg_duration_ms: number;
  success_rate: number;
  avg_cost_usd: number;
}

/**
 * Per-runner stats for the last N days, with optional cost data.
 * LEFT JOINs cost_ledger — returns 0 cost if table is empty or doesn't exist.
 */
export function queryRunnerStats(days: number): RunnerStats[] {
  const db = getDatabase();
  try {
    return db
      .prepare(
        `SELECT
           o.ran_on,
           COUNT(*) AS total,
           SUM(o.success) AS successes,
           ROUND(AVG(o.duration_ms)) AS avg_duration_ms,
           ROUND(CAST(SUM(o.success) AS REAL) / COUNT(*), 3) AS success_rate,
           ROUND(COALESCE(AVG(cl.cost_usd), 0), 6) AS avg_cost_usd
         FROM task_outcomes o
         LEFT JOIN cost_ledger cl ON cl.task_id = o.task_id
         WHERE o.created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY o.ran_on
         ORDER BY total DESC`,
      )
      .all(days) as RunnerStats[];
  } catch {
    // cost_ledger may not exist — fall back to query without JOIN
    return db
      .prepare(
        `SELECT
           ran_on,
           COUNT(*) AS total,
           SUM(success) AS successes,
           ROUND(AVG(duration_ms)) AS avg_duration_ms,
           ROUND(CAST(SUM(success) AS REAL) / COUNT(*), 3) AS success_rate,
           0 AS avg_cost_usd
         FROM task_outcomes
         WHERE created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY ran_on
         ORDER BY total DESC`,
      )
      .all(days) as RunnerStats[];
  }
}

export interface KeywordOutcomeRow {
  task_id: string;
  ran_on: string;
  success: number;
  duration_ms: number;
}

/**
 * Find outcomes for tasks whose titles contain any of the given keywords.
 * Used by the classifier to bias runner choice based on similar historical tasks.
 */
export function queryOutcomesByKeywords(
  keywords: string[],
  days: number,
  limit: number,
): KeywordOutcomeRow[] {
  if (keywords.length === 0) return [];
  const db = getDatabase();

  // Build OR conditions for keyword LIKE matching against task title
  const likeClauses = keywords.map(() => "t.title LIKE ?");
  const params = keywords.map((k) => `%${k}%`);

  return db
    .prepare(
      `SELECT o.task_id, o.ran_on, o.success, o.duration_ms
       FROM task_outcomes o
       JOIN tasks t ON t.task_id = o.task_id
       WHERE o.created_at >= datetime('now', '-' || ? || ' days')
         AND (${likeClauses.join(" OR ")})
       ORDER BY o.created_at DESC
       LIMIT ?`,
    )
    .all(days, ...params, limit) as KeywordOutcomeRow[];
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
