/**
 * Budget enforcement service.
 *
 * Records per-run costs and checks daily spend against a configurable limit.
 * All queries use the indexed `created_at` column for fast lookups.
 */

import { getDatabase } from "../db/index.js";
import { getConfig } from "../config.js";
import { calculateCost } from "./pricing.js";

export interface CostRecord {
  runId: string;
  taskId: string;
  agentType: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface BudgetStatus {
  dailySpend: number;
  dailyLimit: number;
  remaining: number;
  exceeded: boolean;
}

export interface WindowStatus {
  spend: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
}

export interface ThreeWindowStatus {
  hourly: WindowStatus;
  daily: WindowStatus;
  monthly: WindowStatus;
}

/** Record cost for a completed run. */
export function recordCost(record: CostRecord): void {
  const db = getDatabase();
  const costUsd = calculateCost(
    record.model,
    record.promptTokens,
    record.completionTokens,
  );

  db.prepare(
    `INSERT INTO cost_ledger
       (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.runId,
    record.taskId,
    record.agentType,
    record.model,
    record.promptTokens,
    record.completionTokens,
    costUsd,
  );
}

/** Get total spend in the last 24 hours. */
export function getDailySpend(): number {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE created_at >= datetime('now', '-1 day')",
    )
    .get() as { total: number };
  return row.total;
}

/** Get total spend in the current clock hour. */
export function getHourlySpend(): number {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE created_at >= strftime('%Y-%m-%d %H:00:00', 'now')",
    )
    .get() as { total: number };
  return row.total;
}

/** Get total spend in the current calendar month. */
export function getMonthlySpend(): number {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE created_at >= strftime('%Y-%m-01', 'now')",
    )
    .get() as { total: number };
  return row.total;
}

/** Get status of all three spending windows. */
export function getThreeWindowStatus(): ThreeWindowStatus {
  const config = getConfig();
  const hourlySpend = getHourlySpend();
  const dailySpend = getDailySpend();
  const monthlySpend = getMonthlySpend();

  function windowStatus(spend: number, limit: number): WindowStatus {
    return {
      spend,
      limit,
      remaining: Math.max(0, limit - spend),
      exceeded: spend >= limit,
    };
  }

  return {
    hourly: windowStatus(hourlySpend, config.budgetHourlyLimitUsd),
    daily: windowStatus(dailySpend, config.budgetDailyLimitUsd),
    monthly: windowStatus(monthlySpend, config.budgetMonthlyLimitUsd),
  };
}

/** Check if any spending window is exceeded. */
export function isAnyWindowExceeded(): boolean {
  const status = getThreeWindowStatus();
  return (
    status.hourly.exceeded || status.daily.exceeded || status.monthly.exceeded
  );
}

/**
 * Pre-call budget gate: estimate if the next inference call would
 * push any window over its limit. Returns the window name if exceeded.
 */
export function wouldExceedBudget(
  model: string,
  estimatedPromptTokens: number,
  maxCompletionTokens: number,
): { exceeded: boolean; window?: string } {
  const estimatedCost = calculateCost(
    model,
    estimatedPromptTokens,
    Math.floor(maxCompletionTokens * 0.5), // conservative: assume 50% of max
  );

  const status = getThreeWindowStatus();

  if (status.hourly.spend + estimatedCost >= status.hourly.limit) {
    return { exceeded: true, window: "hourly" };
  }
  if (status.daily.spend + estimatedCost >= status.daily.limit) {
    return { exceeded: true, window: "daily" };
  }
  if (status.monthly.spend + estimatedCost >= status.monthly.limit) {
    return { exceeded: true, window: "monthly" };
  }
  return { exceeded: false };
}

/** Check if daily budget limit is exceeded. */
export function isBudgetExceeded(): boolean {
  const limit = getConfig().budgetDailyLimitUsd;
  return getDailySpend() >= limit;
}

/** Get full budget status summary. */
export function getBudgetStatus(): BudgetStatus {
  const dailySpend = getDailySpend();
  const dailyLimit = getConfig().budgetDailyLimitUsd;
  return {
    dailySpend,
    dailyLimit,
    remaining: Math.max(0, dailyLimit - dailySpend),
    exceeded: dailySpend >= dailyLimit,
  };
}
