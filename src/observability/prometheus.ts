/**
 * Prometheus metrics exporter — /metrics endpoint.
 *
 * Bridges existing in-memory metrics (tool, provider, event) and SQLite
 * aggregations (budget, outcomes, cost) to Prometheus text format.
 *
 * Metrics are collected on-demand when /metrics is scraped — no background
 * polling. prom-client handles formatting and default Node.js metrics.
 */

import client from "prom-client";
import { toolMetrics } from "./tool-metrics.js";
import { eventMetrics } from "./event-metrics.js";
import { providerMetrics } from "../inference/adapter.js";
import { getBudgetStatus, getThreeWindowStatus } from "../budget/service.js";
import { getDatabase } from "../db/index.js";

// Default Node.js metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics({ prefix: "mc_" });

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

// --- Inference providers ---
const providerLatencyAvg = new client.Gauge({
  name: "mc_provider_latency_avg_ms",
  help: "Average inference latency per provider (ms)",
  labelNames: ["provider"] as const,
});

const providerLatencyP95 = new client.Gauge({
  name: "mc_provider_latency_p95_ms",
  help: "P95 inference latency per provider (ms)",
  labelNames: ["provider"] as const,
});

const providerSuccessRate = new client.Gauge({
  name: "mc_provider_success_rate",
  help: "Provider success rate (0-1)",
  labelNames: ["provider"] as const,
});

const providerRequestCount = new client.Gauge({
  name: "mc_provider_requests_total",
  help: "Total provider requests in rolling window",
  labelNames: ["provider"] as const,
});

// --- Budget (three-window) ---
const budgetDailySpend = new client.Gauge({
  name: "mc_budget_daily_spend_usd",
  help: "Today's total spend in USD",
});

const budgetDailyLimit = new client.Gauge({
  name: "mc_budget_daily_limit_usd",
  help: "Daily budget limit in USD",
});

const budgetRemaining = new client.Gauge({
  name: "mc_budget_remaining_usd",
  help: "Remaining budget today in USD",
});

const budgetHourlySpend = new client.Gauge({
  name: "mc_budget_hourly_spend_usd",
  help: "Current hour spend in USD",
});

const budgetHourlyLimit = new client.Gauge({
  name: "mc_budget_hourly_limit_usd",
  help: "Hourly budget limit in USD",
});

const budgetMonthlySpend = new client.Gauge({
  name: "mc_budget_monthly_spend_usd",
  help: "Current month spend in USD",
});

const budgetMonthlyLimit = new client.Gauge({
  name: "mc_budget_monthly_limit_usd",
  help: "Monthly budget limit in USD",
});

// --- Concurrency ---
const tasksActive = new client.Gauge({
  name: "mc_tasks_active",
  help: "Currently executing tasks",
});

const tasksActiveByRunner = new client.Gauge({
  name: "mc_tasks_active_by_runner",
  help: "Currently executing tasks by runner type",
  labelNames: ["runner"] as const,
});

// --- Tools ---
const toolCallsTotal = new client.Gauge({
  name: "mc_tool_calls_total",
  help: "Total tool calls in rolling window",
  labelNames: ["tool"] as const,
});

const toolErrorsTotal = new client.Gauge({
  name: "mc_tool_errors_total",
  help: "Total tool errors in rolling window",
  labelNames: ["tool"] as const,
});

const toolLatencyAvg = new client.Gauge({
  name: "mc_tool_latency_avg_ms",
  help: "Average tool execution latency (ms)",
  labelNames: ["tool"] as const,
});

// --- Tasks (from SQLite — persistent) ---
const tasksCompletedTotal = new client.Gauge({
  name: "mc_tasks_completed_total",
  help: "Total completed tasks (all time)",
  labelNames: ["status"] as const,
});

const tasksDurationAvg = new client.Gauge({
  name: "mc_tasks_duration_avg_ms",
  help: "Average task duration by runner (last 7 days)",
  labelNames: ["runner"] as const,
});

const tasksSuccessRate = new client.Gauge({
  name: "mc_tasks_success_rate",
  help: "Task success rate by runner (last 7 days)",
  labelNames: ["runner"] as const,
});

// --- Tokens (from SQLite — persistent) ---
const tokensPromptTotal = new client.Gauge({
  name: "mc_tokens_prompt_total",
  help: "Total prompt tokens today",
  labelNames: ["model"] as const,
});

const tokensCompletionTotal = new client.Gauge({
  name: "mc_tokens_completion_total",
  help: "Total completion tokens today",
  labelNames: ["model"] as const,
});

const costTotalUsd = new client.Gauge({
  name: "mc_cost_total_usd",
  help: "Total cost today by model (USD)",
  labelNames: ["model"] as const,
});

// --- Memory ---
const conversationsTotal = new client.Gauge({
  name: "mc_conversations_total",
  help: "Total conversations stored",
});

const embeddingsTotal = new client.Gauge({
  name: "mc_embeddings_total",
  help: "Total conversation embeddings stored",
});

// --- COMMIT events ---
const commitEventsTotal = new client.Gauge({
  name: "mc_commit_events_total",
  help: "Total COMMIT webhook events processed",
});

// ---------------------------------------------------------------------------
// Collect on scrape
// ---------------------------------------------------------------------------

/**
 * Refresh all custom metrics from in-memory singletons + SQLite.
 * Called before each /metrics scrape.
 */
export function collectMetrics(): void {
  // Provider metrics
  const providerStats = providerMetrics.getAllStats();
  for (const [name, stats] of Object.entries(providerStats)) {
    providerLatencyAvg.set({ provider: name }, stats.avgLatencyMs);
    providerLatencyP95.set({ provider: name }, stats.p95LatencyMs);
    providerSuccessRate.set({ provider: name }, stats.successRate);
    providerRequestCount.set({ provider: name }, stats.count);
  }

  // Budget (three-window)
  const budget = getBudgetStatus();
  budgetDailySpend.set(budget.dailySpend);
  budgetDailyLimit.set(budget.dailyLimit);
  budgetRemaining.set(budget.remaining);

  const threeWindow = getThreeWindowStatus();
  budgetHourlySpend.set(threeWindow.hourly.spend);
  budgetHourlyLimit.set(threeWindow.hourly.limit);
  budgetMonthlySpend.set(threeWindow.monthly.spend);
  budgetMonthlyLimit.set(threeWindow.monthly.limit);

  // Tool metrics
  const toolSummary = toolMetrics.getSummary();
  for (const t of toolSummary.topByLatency) {
    toolLatencyAvg.set({ tool: t.name }, t.avgLatencyMs);
  }
  for (const t of toolSummary.topByErrors) {
    toolErrorsTotal.set({ tool: t.name }, t.failures);
  }
  toolCallsTotal.set({ tool: "_total" }, toolSummary.totalCalls);

  // COMMIT events
  const eventSummary = eventMetrics.getSummary();
  commitEventsTotal.set(eventSummary.totalProcessed);

  // SQLite queries (lightweight — cached by DB page cache)
  try {
    const db = getDatabase();

    // Task counts by status
    const taskCounts = db
      .prepare("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;
    for (const row of taskCounts) {
      tasksCompletedTotal.set({ status: row.status }, row.cnt);
    }

    // Runner performance (last 7 days)
    const runnerStats = db
      .prepare(
        `SELECT ran_on, COUNT(*) as total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
                AVG(duration_ms) as avg_ms
         FROM task_outcomes
         WHERE created_at >= datetime('now', '-7 days')
         GROUP BY ran_on`,
      )
      .all() as Array<{
      ran_on: string;
      total: number;
      successes: number;
      avg_ms: number;
    }>;
    for (const row of runnerStats) {
      tasksDurationAvg.set({ runner: row.ran_on }, row.avg_ms);
      tasksSuccessRate.set(
        { runner: row.ran_on },
        row.total > 0 ? row.successes / row.total : 0,
      );
    }

    // Token usage + cost today (by model)
    const tokenStats = db
      .prepare(
        `SELECT model,
                SUM(prompt_tokens) as prompt_total,
                SUM(completion_tokens) as completion_total,
                SUM(cost_usd) as cost_total
         FROM cost_ledger
         WHERE created_at >= datetime('now', '-1 day')
         GROUP BY model`,
      )
      .all() as Array<{
      model: string;
      prompt_total: number;
      completion_total: number;
      cost_total: number;
    }>;
    for (const row of tokenStats) {
      tokensPromptTotal.set({ model: row.model }, row.prompt_total);
      tokensCompletionTotal.set({ model: row.model }, row.completion_total);
      costTotalUsd.set({ model: row.model }, row.cost_total);
    }

    // Memory stats
    const convCount = db
      .prepare("SELECT COUNT(*) as cnt FROM conversations")
      .get() as { cnt: number };
    conversationsTotal.set(convCount.cnt);

    const embedCount = db
      .prepare("SELECT COUNT(*) as cnt FROM conversation_embeddings")
      .get() as { cnt: number };
    embeddingsTotal.set(embedCount.cnt);
  } catch {
    // DB not ready — metrics will be zero
  }
}

// --- Task lifecycle tracking (called from dispatcher) ---

export function taskStarted(runner: string): void {
  tasksActive.inc();
  tasksActiveByRunner.inc({ runner });
}

export function taskCompleted(runner: string): void {
  tasksActive.dec();
  tasksActiveByRunner.dec({ runner });
}

/** Return Prometheus-formatted metrics string. */
export async function getMetricsText(): Promise<string> {
  collectMetrics();
  return client.register.metrics();
}

/** Content-Type header for Prometheus scraping. */
export const metricsContentType = client.register.contentType;
