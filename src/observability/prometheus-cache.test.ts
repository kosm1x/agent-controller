/**
 * Prompt-cache gauges (2026-09-12): cost_ledger → mc_inference_cache_read_*.
 * Uses a real :memory: database so the SQL and the migration that adds
 * cache_read_tokens are both exercised, not mocked.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import client from "prom-client";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
// collectMetrics also reads the budget service, which loads config (and
// with it every required inference env var). The budget gauges are not
// under test here, so stub the module.
vi.mock("../budget/service.js", () => ({
  getBudgetStatus: () => ({ dailySpend: 0, dailyLimit: 1, remaining: 1 }),
  getThreeWindowStatus: () => ({
    hourly: { spend: 0, limit: 1 },
    monthly: { spend: 0, limit: 1 },
  }),
}));

import { collectMetrics } from "./prometheus.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

afterAll(() => {
  client.register.resetMetrics();
});

function gauge(name: string, model: string): number | undefined {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return undefined;
  const data = (
    metric as unknown as {
      hashMap: Record<string, { value: number; labels: Record<string, string> }>;
    }
  ).hashMap;
  return Object.values(data).find((e) => e.labels.model === model)?.value;
}

function ledgerRow(model: string, prompt: number, cacheRead: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO cost_ledger (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd, cache_read_tokens)
       VALUES (@run, @task, 'fast', @model, @prompt, 10, 0.01, @cache)`,
    )
    .run({ run: `r-${Math.random()}`, task: "t1", model, prompt, cache: cacheRead });
}

describe("mc_inference_cache_read_* gauges", () => {
  it("exports cache-read tokens and the hit ratio per model over 24h", () => {
    ledgerRow("claude-sonnet-5", 8_000, 6_000);
    ledgerRow("claude-sonnet-5", 2_000, 2_000);
    ledgerRow("qwen3", 5_000, 0);
    collectMetrics();
    expect(gauge("mc_inference_cache_read_tokens_24h", "claude-sonnet-5")).toBe(8_000);
    expect(gauge("mc_inference_cache_read_ratio_24h", "claude-sonnet-5")).toBeCloseTo(0.8, 5);
    expect(gauge("mc_inference_cache_read_ratio_24h", "qwen3")).toBe(0);
  });

  it("reports ratio 0 (never NaN) when a model has no prompt tokens", () => {
    ledgerRow("empty-model", 0, 0);
    collectMetrics();
    expect(gauge("mc_inference_cache_read_ratio_24h", "empty-model")).toBe(0);
  });
});
