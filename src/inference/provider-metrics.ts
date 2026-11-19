/**
 * Per-provider health and latency bookkeeping for inference calls: a rolling
 * window of samples per provider, the health class that /health and /metrics
 * report, and the degradation check that routing uses for preemptive
 * failover. One shared singleton, `providerMetrics`.
 *
 * A leaf module: it imports only the pricing function, so the inference paths
 * that record samples and the readers of the stats reach the singleton without
 * loading the OpenAI-compatible adapter. adapter-openai.ts and adapter.ts
 * re-export it for their existing importers.
 */

import { calculateCost } from "../budget/pricing.js";

// ---------------------------------------------------------------------------
// Provider latency tracking — rolling window for health + preemptive failover
// ---------------------------------------------------------------------------

interface LatencyEntry {
  timestamp: number;
  latencyMs: number;
  success: boolean;
  promptTokens: number;
  completionTokens: number;
  /** Optional task ID for per-task failure dedup in isDegraded(). */
  taskId?: string;
}

/** Provider health classification (v6.2 S1). */
export type ProviderHealth = "healthy" | "degraded" | "unhealthy";

export interface ProviderStats {
  count: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  /** Health classification based on baseline thresholds. */
  health: ProviderHealth;
  /** Estimated cost in USD for this window. */
  costUsd: number;
  /** Total tokens in this window. */
  totalTokens: number;
  /** True when no sample fell inside the health window and the figures
   *  come from the older full list (stale, not current). */
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Health thresholds — recalibrated for SDK + OpenAI-compatible providers
// (2026-04-13 review)
//
// Original baseline (2026-04-06): qwen 98.8%/59.4s, kimi 100%/76.6s
// Post Claude Agent SDK migration: SDK runs include subprocess management
// (spawn, MCP bridge, abort plumbing) which adds occasional transient failures
// not present in raw HTTP calls. With small sample windows (10-20 calls), a
// single transient failure was tripping the old 3% threshold and flapping
// providers between healthy/degraded.
//
// New thresholds give SDK paths breathing room while still alerting on real
// regressions. The degraded zone is now 5-15% error rate, 90-180s latency.
// ---------------------------------------------------------------------------

/** Avg latency below this = healthy. */
const LATENCY_HEALTHY_MS = 90_000;
/** Avg latency above this = unhealthy. */
const LATENCY_UNHEALTHY_MS = 180_000;
/** Error rate below this = healthy. */
const ERROR_RATE_HEALTHY = 0.07;
/** Error rate above this = unhealthy. */
const ERROR_RATE_UNHEALTHY = 0.2;
/** Minimum samples before health classification applies. */
const MIN_HEALTH_SAMPLES = 5;
/** Rolling window for health stats/dashboard (10 min). */
const HEALTH_WINDOW_MS = 600_000;
/**
 * Degradation routing uses shorter window + higher error threshold than
 * dashboard health to prevent scheduled task failures (which produce
 * 5-10 timeout entries in rapid succession) from contaminating
 * interactive traffic for 10 minutes.
 */
const DEGRADATION_WINDOW_MS = 180_000; // 3 min
const DEGRADATION_ERROR_THRESHOLD = 0.25; // 25%

// Pricing is delegated to src/budget/pricing.ts (calculateCost) — the
// adapter used to carry its own per-1M table, which had already drifted
// from the budget ledger in both coverage (missing every post-2026-05-06
// Fireworks alias) and values, so the provider-health dashboard reported
// costs that disagreed with the budget and ignored BUDGET_PRICING_JSON.
// One pricing source of truth now.

function classifyHealth(
  avgLatencyMs: number,
  errorRate: number,
  sampleCount: number,
): ProviderHealth {
  if (sampleCount < MIN_HEALTH_SAMPLES) return "healthy"; // not enough data
  if (avgLatencyMs > LATENCY_UNHEALTHY_MS || errorRate > ERROR_RATE_UNHEALTHY)
    return "unhealthy";
  if (avgLatencyMs > LATENCY_HEALTHY_MS || errorRate > ERROR_RATE_HEALTHY)
    return "degraded";
  return "healthy";
}

class ProviderMetrics {
  private entries = new Map<string, LatencyEntry[]>();
  private readonly windowSize = 50;
  /** Model name per provider — set on first successful call. */
  private models = new Map<string, string>();

  record(provider: string, entry: LatencyEntry, model?: string): void {
    let list = this.entries.get(provider);
    if (!list) {
      list = [];
      this.entries.set(provider, list);
    }
    list.push(entry);
    if (list.length > this.windowSize) {
      list.splice(0, list.length - this.windowSize);
    }
    if (model) this.models.set(provider, model);
  }

  getStats(provider: string): ProviderStats | null {
    const list = this.entries.get(provider);
    if (!list || list.length === 0) return null;

    // Use time-windowed data (C2 audit fix: match isDegraded's window
    // so health classification and routing decisions use the same data)
    const cutoff = Date.now() - HEALTH_WINDOW_MS;
    const recent = list.filter((e) => e.timestamp >= cutoff);
    // Fall back to full list if no recent entries (show stale stats vs nothing)
    const stale = recent.length === 0;
    const data = stale ? list : recent;

    const latencies = data.map((e) => e.latencyMs).sort((a, b) => a - b);
    const successes = data.filter((e) => e.success).length;
    const p95Idx = Math.min(
      Math.floor(latencies.length * 0.95),
      latencies.length - 1,
    );
    const avgLatencyMs = Math.round(
      latencies.reduce((a, b) => a + b, 0) / latencies.length,
    );
    const errorRate = 1 - successes / data.length;

    const model = this.models.get(provider) ?? "";
    const totalPrompt = data.reduce((s, e) => s + e.promptTokens, 0);
    const totalCompletion = data.reduce((s, e) => s + e.completionTokens, 0);

    return {
      count: data.length,
      avgLatencyMs,
      p95LatencyMs: latencies[p95Idx],
      successRate: successes / data.length,
      health: classifyHealth(avgLatencyMs, errorRate, data.length),
      costUsd: calculateCost(model, totalPrompt, totalCompletion),
      totalTokens: totalPrompt + totalCompletion,
      stale,
    };
  }

  getAllStats(): Record<string, ProviderStats> {
    const result: Record<string, ProviderStats> = {};
    for (const [name] of this.entries) {
      const stats = this.getStats(name);
      if (stats) result[name] = stats;
    }
    return result;
  }

  /**
   * True if provider should be skipped (degraded or unhealthy).
   *
   * Uses a SHORTER window (3 min) and HIGHER error threshold (25%) than
   * dashboard health classification. This prevents a single burst of
   * failures (e.g. a scheduled task timing out 5-10 times in 60s) from
   * marking the provider degraded for interactive traffic.
   *
   * Dashboard health uses the wider 10-min/3% window for visibility —
   * routing decisions use the tighter window for resilience.
   */
  isDegraded(provider: string): boolean {
    const list = this.entries.get(provider);
    if (!list || list.length === 0) return false;

    const cutoff = Date.now() - DEGRADATION_WINDOW_MS;
    const recent = list.filter((e) => e.timestamp >= cutoff);
    if (recent.length < MIN_HEALTH_SAMPLES) return false;

    // v6.4 OH1.5: Per-task failure cap — a single failing task that produces
    // 10 timeout entries shouldn't flood the degradation window. Cap failures
    // at 2 per taskId so one bad scheduled task can't mark a provider degraded.
    const MAX_FAILURES_PER_TASK = 2;
    const failureCountByTask = new Map<string, number>();
    let cappedFailures = 0;
    let totalCapped = 0;
    let cappedLatencySum = 0;
    for (const e of recent) {
      if (e.success) {
        totalCapped++;
        cappedLatencySum += e.latencyMs;
        continue;
      }
      const key = e.taskId ?? "unknown";
      const count = failureCountByTask.get(key) ?? 0;
      if (count < MAX_FAILURES_PER_TASK) {
        failureCountByTask.set(key, count + 1);
        cappedFailures++;
        totalCapped++;
        cappedLatencySum += e.latencyMs;
      }
      // else: skip this entry entirely — not counted in latency or error rate
    }

    if (totalCapped < MIN_HEALTH_SAMPLES) return false;

    // Both metrics use the same population (capped entries only)
    const avgLatencyMs = Math.round(cappedLatencySum / totalCapped);
    const errorRate = cappedFailures / totalCapped;

    return (
      avgLatencyMs > LATENCY_UNHEALTHY_MS ||
      errorRate > DEGRADATION_ERROR_THRESHOLD
    );
  }
}

export const providerMetrics = new ProviderMetrics();
