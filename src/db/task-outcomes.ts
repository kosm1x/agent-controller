/**
 * Task outcome tracking — SQLite CRUD for the task_outcomes table.
 *
 * Records classification decisions, runner performance, and user feedback
 * for each completed messaging task. Feeds the adaptive classifier (v2.9.3)
 * and enrichment service (v2.9.2).
 */

import { getDatabase, writeWithRetry } from "./index.js";
import { redactCredentialsForPersist } from "../api/mcp-server/redact.js";

export interface TaskOutcome {
  task_id: string;
  classified_as: string;
  ran_on: string;
  tools_used: string[];
  duration_ms: number;
  success: boolean;
  tags: string[];
  model_tier?: string;
  /** Phase 0: why a task landed with concerns (max_turns, tool_scope_block, …). */
  concern_reason?: string | null;
  /**
   * First runner concern of a successful run: the model's STATUS explanation
   * or a runner-generated note (promotion, container note). Storage only.
   */
  concern_detail?: string | null;
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
  model_tier: string | null;
  concern_reason: string | null;
  concern_detail: string | null;
  created_at: string;
}

/** Record a task outcome after completion. */
export function recordOutcome(outcome: TaskOutcome): void {
  const db = getDatabase();
  writeWithRetry(() =>
    db
      .prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags, model_tier, concern_reason, concern_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.task_id,
        outcome.classified_as,
        outcome.ran_on,
        JSON.stringify(outcome.tools_used),
        outcome.duration_ms,
        outcome.success ? 1 : 0,
        JSON.stringify(outcome.tags),
        outcome.model_tier ?? null,
        outcome.concern_reason ?? null,
        outcome.concern_detail ?? null,
      ),
  );
}

const CONCERN_DETAIL_MAX_CHARS = 500;
const MAX_PENDING_CONCERN_DETAILS = 256;

/**
 * First runner concern of a successful run — the model's STATUS explanation
 * or a runner-generated note (promotion, container note) — waiting for its
 * outcome row (taskId → detail). The
 * dispatcher notes it at completion; trackTaskOutcome takes it into
 * task_outcomes.concern_detail. Held in memory on purpose — the text is
 * storage only: the task.completed payload is persisted to `events` (returned
 * by the jarvis_recent_events MCP tool and the /api/events stream) and the
 * run row is served by getTaskWithRuns (API + A2A). Bounded, because tasks
 * the tracker never records (non-messaging) are never taken.
 */
const pendingConcernDetail = new Map<string, string>();

/**
 * Note the runner's concern for a task: credential-redacted, trimmed, capped
 * at 500 chars. A null/blank/non-string detail clears any earlier note.
 */
export function noteConcernDetail(taskId: string, detail: unknown): void {
  pendingConcernDetail.delete(taskId);
  if (typeof detail !== "string") return;
  // Redact BEFORE the cut: a fixed-length key rule misses a split key.
  const clean = redactCredentialsForPersist(detail)
    ?.trim()
    .slice(0, CONCERN_DETAIL_MAX_CHARS);
  if (!clean) return;
  pendingConcernDetail.set(taskId, clean);
  if (pendingConcernDetail.size > MAX_PENDING_CONCERN_DETAILS) {
    const oldest = pendingConcernDetail.keys().next().value;
    if (oldest !== undefined) pendingConcernDetail.delete(oldest);
  }
}

/** Returns the noted concern detail for the task (or null) and forgets it. */
export function takeConcernDetail(taskId: string): string | null {
  const detail = pendingConcernDetail.get(taskId) ?? null;
  pendingConcernDetail.delete(taskId);
  return detail;
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

/**
 * The task the operator's "excelente" praises when no 2-minute feedback window
 * is open: the NEWEST outcome row (by id) of a task on this thread within
 * `maxAgeHours`. Latest reply only — if that newest outcome failed, null
 * (praise never skips back over a failure to an older reply).
 */
export function findLatestOutcomeTaskForThread(
  threadId: string,
  maxAgeHours = 12,
): string | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT o.task_id, o.success
       FROM task_outcomes o
       JOIN tasks t ON t.task_id = o.task_id
       WHERE json_extract(t.metadata, '$.threadId') = ?
         AND o.created_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY o.id DESC
       LIMIT 1`,
    )
    .get(threadId, maxAgeHours) as
    | { task_id: string; success: number }
    | undefined;
  return row && row.success === 1 ? row.task_id : null;
}

/** Update feedback signal for a task outcome (explicit or implicit). */
export function updateFeedback(
  taskId: string,
  signal: import("../intelligence/feedback.js").AnyFeedbackSignal | string,
): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE task_outcomes SET feedback_signal = ? WHERE task_id = ?",
  ).run(signal, taskId);
}

// ---------------------------------------------------------------------------
// Feedback quality queries (S5 classifier calibration)
// ---------------------------------------------------------------------------

export interface FeedbackStats {
  ran_on: string;
  model_tier: string | null;
  total: number;
  negative_count: number;
  negative_rate: number;
}

/**
 * Per-runner + per-tier feedback quality stats for the last N days.
 * Only includes rows with actual feedback signals (excludes 'none').
 * Requires at least 3 rows per group (sparse data guard).
 */
export function queryFeedbackQuality(days: number): FeedbackStats[] {
  const db = getDatabase();
  try {
    return db
      .prepare(
        `SELECT
           ran_on,
           model_tier,
           COUNT(*) AS total,
           SUM(CASE WHEN feedback_signal IN ('negative', 'rephrase', 'implicit_rephrase') THEN 1 ELSE 0 END) AS negative_count,
           ROUND(CAST(SUM(CASE WHEN feedback_signal IN ('negative', 'rephrase', 'implicit_rephrase') THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 3) AS negative_rate
         FROM task_outcomes
         WHERE created_at >= datetime('now', '-' || ? || ' days')
           AND feedback_signal != 'none'
         GROUP BY ran_on, model_tier
         HAVING COUNT(*) >= 3
         ORDER BY negative_rate DESC`,
      )
      .all(days) as FeedbackStats[];
  } catch {
    return [];
  }
}
