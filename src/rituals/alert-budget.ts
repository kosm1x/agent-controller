/**
 * F9 Morning/EOD Rituals — per-ritual daily token budget.
 *
 * Each ritual consumes a daily budget. When budget is exhausted, rituals
 * degrade gracefully to a one-line "budget exhausted" message instead of
 * firing the full LLM-heavy path.
 *
 * Budget resets at midnight America/New_York. Multiple consumptions per day
 * accumulate via UPSERT semantics.
 *
 * Design choices (see `22-f9-impl-plan.md` §D-D):
 *   - Tokens only at v1; USD cost attribution deferred (needs per-model
 *     price mapping which changes per provider release).
 *   - Per-ritual isolation — morning-scan hitting its limit doesn't affect
 *     eod-scan's budget.
 *   - Date granularity is NY-local day, matching market calendar + rituals.
 */

import { getDatabase } from "../db/index.js";
import { toNyDate } from "../finance/market-calendar.js";

/** Per-ritual default daily token limits. Extend as new rituals ship. */
export const DEFAULT_LIMITS: Record<string, number> = {
  "market-morning-scan": 10_000,
  "market-eod-scan": 8_000,
};

const FALLBACK_LIMIT = 10_000;

export interface BudgetStatus {
  date: string; // YYYY-MM-DD NY
  ritualId: string;
  consumed: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

interface BudgetRow {
  id: number;
  date: string;
  ritual_id: string;
  tokens_consumed: number;
  tokens_limit: number;
  exhausted_at: string | null;
  created_at: string;
}

function todayNY(): string {
  return toNyDate(new Date());
}

function rowToStatus(row: BudgetRow): BudgetStatus {
  const remaining = Math.max(0, row.tokens_limit - row.tokens_consumed);
  return {
    date: row.date,
    ritualId: row.ritual_id,
    consumed: row.tokens_consumed,
    limit: row.tokens_limit,
    remaining,
    exhausted: remaining === 0 || row.exhausted_at !== null,
  };
}

/**
 * Ensure a budget row exists for (date, ritualId). Idempotent. Returns the
 * current status after init. Uses DEFAULT_LIMITS or explicit `limit` override.
 */
export function initBudget(
  ritualId: string,
  opts?: { date?: string; limit?: number },
): BudgetStatus {
  const db = getDatabase();
  const date = opts?.date ?? todayNY();
  const limit = opts?.limit ?? DEFAULT_LIMITS[ritualId] ?? FALLBACK_LIMIT;
  db.prepare(
    `INSERT OR IGNORE INTO alert_budget (date, ritual_id, tokens_consumed, tokens_limit)
     VALUES (?, ?, 0, ?)`,
  ).run(date, ritualId, limit);
  return getBudgetStatus(ritualId, date)!;
}

/**
 * Record `tokens` against (date, ritualId). Inserts a row if none exists.
 * Sets `exhausted_at` ISO timestamp the first time consumed ≥ limit. Returns
 * the post-consume status.
 *
 * Invariants: tokens >= 0; non-finite tokens throw.
 */
export function consumeBudget(
  ritualId: string,
  tokens: number,
  opts?: { date?: string },
): BudgetStatus {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`consumeBudget: tokens must be finite >= 0, got ${tokens}`);
  }
  const db = getDatabase();
  const date = opts?.date ?? todayNY();
  // Ensure the row exists before we increment.
  initBudget(ritualId, { date });

  const row = db
    .prepare(`SELECT * FROM alert_budget WHERE date = ? AND ritual_id = ?`)
    .get(date, ritualId) as BudgetRow;
  const newConsumed = row.tokens_consumed + Math.round(tokens);
  const nowIso = new Date().toISOString();
  const exhaustedAt =
    row.exhausted_at ?? (newConsumed >= row.tokens_limit ? nowIso : null);
  db.prepare(
    `UPDATE alert_budget
       SET tokens_consumed = ?, exhausted_at = ?
     WHERE date = ? AND ritual_id = ?`,
  ).run(newConsumed, exhaustedAt, date, ritualId);
  return getBudgetStatus(ritualId, date)!;
}

/**
 * Return the status for (date, ritualId). Returns null if no row exists.
 */
export function getBudgetStatus(
  ritualId: string,
  date?: string,
): BudgetStatus | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM alert_budget WHERE date = ? AND ritual_id = ?`)
    .get(date ?? todayNY(), ritualId) as BudgetRow | undefined;
  return row ? rowToStatus(row) : null;
}

/** Return statuses for all rituals on the given date. */
export function getBudgetForDate(date?: string): BudgetStatus[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT * FROM alert_budget WHERE date = ? ORDER BY ritual_id`)
    .all(date ?? todayNY()) as BudgetRow[];
  return rows.map(rowToStatus);
}

/** Admin helper — reset all ritual budgets for a given date. */
export function resetBudgetForDate(date: string): number {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM alert_budget WHERE date = ?`)
    .run(date);
  return result.changes;
}

/**
 * Best-effort wiring from a completed ritual task to the budget ledger.
 * Looks up the run's `token_usage` (dispatcher persists it on `runs`), parses
 * the total, and calls `consumeBudget`. Returns the post-consume status or
 * null if no token-usage row is available.
 *
 * Invoked from `router.handleTaskCompleted` when a ritual task completes.
 * Failure here must never break ritual delivery — callers swallow errors.
 */
export function recordRitualTokensForTask(
  ritualId: string,
  taskId: string,
): BudgetStatus | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT token_usage FROM runs
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 1`,
    )
    .get(taskId) as { token_usage: string | null } | undefined;
  if (!row?.token_usage) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.token_usage);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const u = parsed as Record<string, unknown>;
  const prompt = typeof u.promptTokens === "number" ? u.promptTokens : 0;
  const completion =
    typeof u.completionTokens === "number" ? u.completionTokens : 0;
  const total = prompt + completion;
  if (total <= 0) return null;
  return consumeBudget(ritualId, total);
}
