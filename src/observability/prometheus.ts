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

// --- Webhook events ---
const webhookEventsTotal = new client.Gauge({
  name: "mc_webhook_events_total",
  help: "Total webhook events processed",
});

// --- KB drift (queue #12, 2026-05-07) ---
// Hourly kb-reindex ritual surfaces these so silent-state regressions (FS files
// orphaned to the DB) become visible before operators have to ask. Alert in
// monitoring/alerts.yml fires if drift > 10 for two consecutive runs.
const kbReindexDrift = new client.Gauge({
  name: "mc_kb_reindex_drift",
  help: "FS-only files not yet present in jarvis_files (last reindex run)",
});
const kbReindexFsCount = new client.Gauge({
  name: "mc_kb_reindex_fs_files",
  help: "Total .md files on disk under the jarvis-kb mirror root",
});
const kbReindexDbCount = new client.Gauge({
  name: "mc_kb_reindex_db_files",
  help: "Rows in jarvis_files at last reindex run",
});
const kbReindexErrored = new client.Gauge({
  name: "mc_kb_reindex_errored",
  help: "Files that errored during reindex (read fail or upsert exception)",
});

/** Record the result of a kb-reindex ritual run. Called from scheduler.ts. */
export function recordKbReindex(result: {
  drift: number;
  fsCount: number;
  dbCount: number;
  errored: number;
}): void {
  kbReindexDrift.set(result.drift);
  kbReindexFsCount.set(result.fsCount);
  kbReindexDbCount.set(result.dbCount);
  kbReindexErrored.set(result.errored);
}

// --- Outcome totals (queue #7 part 3, 2026-05-07) ---
// Counters bumped at logRecall / retain time so outcome distribution is
// observable in Prometheus without scrape-time SQL. Drives the
// RetainOutcomeConcerns alert + cross-references the outcome bias from
// queue #7 part 2.
const recallOutcomeTotal = new client.Counter({
  name: "mc_recall_outcome_total",
  help: "Total recall results bucketed by outcome class (post-bias)",
  labelNames: ["outcome", "bank"] as const,
});
const retainOutcomeTotal = new client.Counter({
  name: "mc_retain_outcome_total",
  help: "Total retain calls bucketed by outcome class derived from tags",
  labelNames: ["outcome", "bank"] as const,
});

// W4 audit fix (queue #7 part 3): bound the bank label cardinality so a
// typo'd producer can't accumulate dead label sets in prom-client memory
// until process restart. Unknown banks fold to "unknown".
const KNOWN_BANKS = new Set(["mc-jarvis", "mc-operational", "mc-system"]);
function safeBank(bank: string): string {
  return KNOWN_BANKS.has(bank) ? bank : "unknown";
}

/** Record a per-recall outcome distribution. Called from logRecall. */
export function recordRecallOutcomes(
  bank: string,
  breakdown: {
    success: number;
    concerns: number;
    failed: number;
    unknown: number;
  },
): void {
  const b = safeBank(bank);
  if (breakdown.success > 0)
    recallOutcomeTotal.inc({ outcome: "success", bank: b }, breakdown.success);
  if (breakdown.concerns > 0)
    recallOutcomeTotal.inc(
      { outcome: "concerns", bank: b },
      breakdown.concerns,
    );
  if (breakdown.failed > 0)
    recallOutcomeTotal.inc({ outcome: "failed", bank: b }, breakdown.failed);
  if (breakdown.unknown > 0)
    recallOutcomeTotal.inc({ outcome: "unknown", bank: b }, breakdown.unknown);
}

/** Record a single retain by its outcome tag (extracted from tags array).
 *  Multiple outcome:* tags on one retain is not produced today; first match
 *  wins to match the recall-side `findOutcomeTag` semantics. */
export function recordRetainOutcome(
  bank: string,
  tags: string[] | undefined,
): void {
  let outcome = "unknown";
  if (tags) {
    for (const t of tags) {
      if (t === "outcome:success") {
        outcome = "success";
        break;
      } else if (t === "outcome:concerns") {
        outcome = "concerns";
        break;
      } else if (t === "outcome:failed") {
        outcome = "failed";
        break;
      } else if (t === "outcome:unknown") {
        outcome = "unknown";
        break;
      }
    }
  }
  retainOutcomeTotal.inc({ outcome, bank: safeBank(bank) }, 1);
}

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

  // Webhook events
  const eventSummary = eventMetrics.getSummary();
  webhookEventsTotal.set(eventSummary.totalProcessed);

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

// --- WhatsApp socket flap tracking ---
// Baileys disconnects ~8x/day on this account (reason codes 428/440/etc.)
// and auto-reconnects, so individual disconnects don't break delivery — but
// a sustained spike in the rate is the earliest signal that the session is
// degrading toward a re-auth requirement (logged out). Counter, not log,
// because at 8/day a log line per event is noise; rate() over a window in
// Grafana surfaces a real trend without polluting journald.
//
// The counter must also fire on initial-connect-failure and reconnect-
// failure paths — those bypass the post-connect "close" handler, so a
// session that fails to ever recover would otherwise flatline the metric
// (the opposite of the detection goal). See `recordWhatsappDisconnect`
// call sites in whatsapp.ts.
//
// will_reconnect is intentionally NOT a label: it's derivable from `reason`
// (only loggedOut prevents reconnect) and adds redundant series. The
// failure-class reasons below are self-explanatory.
const whatsappDisconnectsTotal = new client.Counter({
  name: "mc_whatsapp_disconnects_total",
  help: "WhatsApp socket disconnect / connect-failure events bucketed by reason",
  labelNames: ["reason"] as const,
});

/** Translate Baileys numeric `statusCode` into enum-name strings so Grafana
 * labels read like the source-of-truth enum (`loggedOut`, `restartRequired`)
 * instead of HTTP-looking integers that collide with operator muscle memory.
 * Codes pulled from @whiskeysockets/baileys DisconnectReason. */
const WA_REASON_NAME: Record<number, string> = {
  401: "loggedOut",
  403: "forbidden",
  408: "timedOut",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  503: "unavailableService",
  515: "restartRequired",
};

/** Reasons we expect to see in practice; anything else folds to "other"
 * so a cardinality bomb (e.g. transient codes from upstream changes)
 * can't fill prom-client memory. Includes the two synthetic
 * connect-failure markers bumped from whatsapp.ts catch handlers. */
const KNOWN_WA_REASONS = new Set([
  ...Object.values(WA_REASON_NAME),
  "connect_failed",
  "reconnect_failed",
  "unknown",
]);

// v7.7 Spine 2 Bundle 2 (S3-I2 fold): per-signal + per-cadence cron-tick
// failure counter. Closes the "silent failure in journalctl only" gap pinned
// in feedback_prometheus_counter_recovery_path.
//
// Two labels: `cadence` (hourly|every_4h|nightly|weekly) and `kind`:
//   - 'signal'    → one signal's evaluateSignal threw (per-signal isolation)
//   - 'tick'      → the cadence tick itself threw outside the per-signal loop
//   - 'burst'     → burst detection / persistence threw
// Closed cardinality: 4 cadences × 3 kinds = 12 distinct series.
const s3EvaluatorErrorsTotal = new client.Counter({
  name: "mc_s3_evaluator_errors_total",
  help: "S3 drift-detector cron-tick failures bucketed by cadence + failure kind",
  labelNames: ["cadence", "kind"] as const,
});

const KNOWN_S3_KINDS = new Set(["signal", "tick", "burst"]);
const KNOWN_S3_CADENCES = new Set(["hourly", "every_4h", "nightly", "weekly"]);

export function recordS3EvaluatorError(cadence: string, kind: string): void {
  const c = KNOWN_S3_CADENCES.has(cadence) ? cadence : "unknown";
  const k = KNOWN_S3_KINDS.has(kind) ? kind : "unknown";
  s3EvaluatorErrorsTotal.inc({ cadence: c, kind: k });
}

// v7.7 Spine 2 Bundle 3: P0 push dispatch failures bucketed by channel
// or failure kind. Closed cardinality: {broadcast | router_unavailable | unknown}.
const s3PushErrorsTotal = new client.Counter({
  name: "mc_s3_push_errors_total",
  help: "S3 P0-push dispatch failures bucketed by failure channel",
  labelNames: ["channel"] as const,
});

const KNOWN_S3_PUSH_CHANNELS = new Set(["broadcast", "router_unavailable"]);

export function recordS3PushError(channel: string): void {
  const c = KNOWN_S3_PUSH_CHANNELS.has(channel) ? channel : "unknown";
  s3PushErrorsTotal.inc({ channel: c });
}

// v7.7 Spine 1 Phase 2b: community-reply write-gate verdicts.
// One label `verdict` with closed cardinality (pass | fail | error). Used to
// monitor false-positive rate (fail % of non-error replies) and infra health
// (error % of total). Reset to zero on each restart per prom-client default.
const communityGateVerdictTotal = new client.Counter({
  name: "mc_community_gate_verdict_total",
  help: "Community-manager email reply write-gate verdicts bucketed by outcome",
  labelNames: ["verdict"] as const,
});

const KNOWN_GATE_VERDICTS = new Set(["pass", "fail", "error"]);

export function recordCommunityGateVerdict(verdict: string): void {
  const bucket = KNOWN_GATE_VERDICTS.has(verdict) ? verdict : "error";
  communityGateVerdictTotal.inc({ verdict: bucket });
}

// v7.7 Spine 3 Phase 2 Bundle 2: skill test outcomes bucketed by result.
// One label `result` with closed cardinality (pass | fail | error | timeout).
// Bumped per skill_test_runs row write by the test-runner. The cron-sweep
// reads the same delta to detect decertification events.
const skillsTestRunsTotal = new client.Counter({
  name: "mc_skills_test_runs_total",
  help: "S5 skill test outcomes bucketed by result",
  labelNames: ["result"] as const,
});

const KNOWN_SKILL_TEST_RESULTS = new Set(["pass", "fail", "error", "timeout"]);

export function recordSkillTestResult(result: string): void {
  const bucket = KNOWN_SKILL_TEST_RESULTS.has(result) ? result : "error";
  skillsTestRunsTotal.inc({ result: bucket });
}

// v7.7 Spine 3 Phase 4 Bundle 1: skill_run outcomes by skill name + result.
// `name` is open cardinality (one bucket per distinct skill name); we
// cap potential explosion via the closed result allowlist + the
// skill-name length cap from frontmatter (≤64 chars). Operators with
// >1k distinct skills would need a separate aggregation strategy, but
// the V8.0 activation gate ceiling is "≥5 certified" — single-digit
// real-world cardinality through the V8.x horizon.
const skillsRunsTotal = new client.Counter({
  name: "mc_skills_run_total",
  help: "S5 skill_run outcomes by skill name + result class",
  labelNames: ["name", "result"] as const,
});

const KNOWN_SKILL_RUN_RESULTS = new Set([
  "ok",
  "skill_not_found",
  "skill_inactive",
  "no_active_version",
  "input_validation",
  "cycle_detected",
  "tool_unavailable",
  "wrong_output",
  "timeout",
  "other",
]);

export function recordSkillRun(name: string, result: string): void {
  const bucket = KNOWN_SKILL_RUN_RESULTS.has(result) ? result : "other";
  // Defensive: clip absurdly long names to the frontmatter cap so a
  // dispatcher call with a malformed `name` argument can't leak unbounded
  // label cardinality into prom-client.
  const safeName = String(name).slice(0, 64);
  skillsRunsTotal.inc({ name: safeName, result: bucket });
}

// v7.7 Spine 4 Bundle 3: general-events middle-layer activity, bucketed by
// op. Closed cardinality (4 buckets). `created`/`archived` track write-side
// growth of the ~30-50 row cohort; `retrieved` tracks how often the layer
// is queried. Today `retrieved` increments only from `mc-ctl events
// retrieve` — the V8.1 briefing path that will be its main driver is a
// later spine and not yet wired.
const generalEventsOpsTotal = new client.Counter({
  name: "mc_general_events_ops_total",
  help: "Conway Pattern 1 general-events operations bucketed by op",
  labelNames: ["op"] as const,
});

const KNOWN_GENERAL_EVENT_OPS = new Set([
  "created",
  "archived",
  "retrieved",
  "other",
]);

export function recordGeneralEventOp(op: string): void {
  const bucket = KNOWN_GENERAL_EVENT_OPS.has(op) ? op : "other";
  generalEventsOpsTotal.inc({ op: bucket });
}

export function recordWhatsappDisconnect(
  reasonCode: number | string | undefined,
): void {
  let raw: string;
  if (reasonCode === undefined) {
    raw = "unknown";
  } else if (typeof reasonCode === "number") {
    raw = WA_REASON_NAME[reasonCode] ?? String(reasonCode);
  } else {
    raw = reasonCode;
  }
  const reason = KNOWN_WA_REASONS.has(raw) ? raw : "other";
  whatsappDisconnectsTotal.inc({ reason });
}

/** Return Prometheus-formatted metrics string. */
export async function getMetricsText(): Promise<string> {
  collectMetrics();
  return client.register.metrics();
}

/** Content-Type header for Prometheus scraping. */
export const metricsContentType = client.register.contentType;
