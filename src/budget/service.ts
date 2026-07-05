/**
 * Budget enforcement service.
 *
 * Records per-run costs and checks daily spend against a configurable limit.
 * All queries use the indexed `created_at` column for fast lookups.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { getConfig } from "../config.js";
import { calculateCost } from "./pricing.js";
import { errMsg } from "../lib/err-msg.js";

export interface CostRecord {
  runId: string;
  taskId: string;
  agentType: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * Optional provider-reported cost. When present, used verbatim instead of
   * computing from the local pricing table. Set by the claude-sdk path so
   * Max-auth ($0) is recorded faithfully and generic API rates don't get
   * applied. Undefined on the openai path (pricing table compute).
   */
  costUsdOverride?: number;
  /**
   * Cache-read tokens — input tokens served from Anthropic's prompt cache
   * (~10% rate). Persisted so cache-hit ratio (`cache_read_tokens /
   * prompt_tokens`) can be queried per model/window. Undefined on the
   * openai path; defaults to 0 in the ledger.
   */
  cacheReadTokens?: number;
  /**
   * Cache-creation tokens — input tokens billed at ~125% to populate the
   * prompt cache. High `cache_creation_tokens / prompt_tokens` indicates
   * a churning prefix (cache structure problem, not a hit-rate problem).
   */
  cacheCreationTokens?: number;
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
  const costUsd =
    record.costUsdOverride ??
    calculateCost(record.model, record.promptTokens, record.completionTokens);

  db.prepare(
    `INSERT INTO cost_ledger
       (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.runId,
    record.taskId,
    record.agentType,
    record.model,
    record.promptTokens,
    record.completionTokens,
    costUsd,
    record.cacheReadTokens ?? 0,
    record.cacheCreationTokens ?? 0,
  );
}

/**
 * `agent_type` prefix for every V8.1 reflection / briefing inference row.
 * `recordReflectionCost` writes `${PREFIX}<surface>`; the §13 activation gate
 * queries `agent_type LIKE '${PREFIX}%'`. Shared so the write and the read
 * cannot drift (the §13 gate silently reports `insufficient_data` forever if
 * they do — there is no CHECK on `cost_ledger.agent_type`).
 */
export const REFLECTION_AGENT_TYPE_PREFIX = "reflection:";

/**
 * Record cost for a V8.1 reflection / briefing inference call (spec §13).
 *
 * These calls run OUTSIDE the dispatcher — `runReflection` invokes
 * `fastRunner.execute` directly, `constructBriefing` invokes `infer()`
 * directly — so the dispatcher's `recordCost` (which fires only on a
 * dispatched runner completion) never sees them. Without this helper the §13
 * activation gate (cache-read ratio over `cost_ledger` rows where
 * `agent_type LIKE 'reflection:%'`) has zero rows to measure.
 *
 * `agent_type` is written as `reflection:<surface>` (e.g. `reflection:morning`,
 * `reflection:n-turn`). Best-effort — a cost-ledger write must never block a
 * briefing or a reflection pass, so every failure is swallowed + logged.
 */
export function recordReflectionCost(input: {
  /** Surface label — becomes `agent_type='reflection:<surface>'`. */
  surface: string;
  taskId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cost (claude-sdk path); omitted ⇒ pricing-table compute. */
  costUsd?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): void {
  try {
    recordCost({
      runId: `reflect-${randomUUID()}`,
      taskId: input.taskId,
      agentType: `${REFLECTION_AGENT_TYPE_PREFIX}${input.surface}`,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      ...(input.costUsd !== undefined && { costUsdOverride: input.costUsd }),
      ...(input.cacheReadTokens !== undefined && {
        cacheReadTokens: input.cacheReadTokens,
      }),
      ...(input.cacheCreationTokens !== undefined && {
        cacheCreationTokens: input.cacheCreationTokens,
      }),
    });
  } catch (err) {
    console.error(
      "[budget] recordReflectionCost failed (non-fatal):",
      errMsg(err),
    );
  }
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
