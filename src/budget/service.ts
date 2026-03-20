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
