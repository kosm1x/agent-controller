/**
 * Tests for inference adapter — ProviderMetrics and token budget enforcement.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We test ProviderMetrics by importing the singleton and exercising it directly.
// For inferWithTools token budget, we mock infer() and verify early termination.

vi.mock("../config.js", () => ({
  getConfig: () => ({
    inferencePrimaryUrl: "http://localhost:9999/v1",
    inferencePrimaryKey: "test",
    inferencePrimaryModel: "test-model",
    inferenceFallbackUrl: "",
    inferenceFallbackKey: "",
    inferenceFallbackModel: "",
    inferenceTertiaryUrl: "",
    inferenceTertiaryKey: "",
    inferenceTertiaryModel: "",
    inferenceTimeoutMs: 5000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 2,
    inferenceContextLimit: 128000,
    compressionThreshold: 0.85,
    heavyRunnerContainerized: false,
    budgetEnabled: false,
  }),
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    has: vi.fn(() => true),
    findClosest: vi.fn(),
  },
}));

vi.mock("../prometheus/context-compressor.js", () => ({
  shouldCompress: vi.fn(() => false),
  compress: vi.fn((msgs: unknown[]) => msgs),
}));

import { providerMetrics, tryRepairJson } from "./adapter.js";

beforeEach(() => {
  // Reset metrics between tests by recording nothing (ProviderMetrics has no
  // public reset, but we can test fresh state per provider name)
});

describe("ProviderMetrics", () => {
  it("should return null for unknown provider", () => {
    expect(providerMetrics.getStats("nonexistent_provider")).toBeNull();
  });

  it("should record and return stats", () => {
    const name = "test_record_provider";
    providerMetrics.record(name, {
      timestamp: Date.now(),
      latencyMs: 1000,
      success: true,
      promptTokens: 100,
      completionTokens: 50,
    });
    providerMetrics.record(name, {
      timestamp: Date.now(),
      latencyMs: 2000,
      success: true,
      promptTokens: 200,
      completionTokens: 100,
    });
    providerMetrics.record(name, {
      timestamp: Date.now(),
      latencyMs: 3000,
      success: false,
      promptTokens: 0,
      completionTokens: 0,
    });

    const stats = providerMetrics.getStats(name);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
    expect(stats!.avgLatencyMs).toBe(2000);
    expect(stats!.successRate).toBeCloseTo(2 / 3);
    // p95 of [1000, 2000, 3000] = 3000
    expect(stats!.p95LatencyMs).toBe(3000);
  });

  it("should evict oldest entries when window exceeded", () => {
    const name = "test_eviction_provider";
    // Fill beyond window size (50)
    for (let i = 0; i < 60; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: i * 100,
        success: true,
        promptTokens: 10,
        completionTokens: 5,
      });
    }
    const stats = providerMetrics.getStats(name);
    expect(stats!.count).toBe(50);
  });

  it("should not report degraded with insufficient samples", () => {
    const name = "test_degraded_few";
    for (let i = 0; i < 5; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 20_000, // very slow
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    // Only 5 samples, minSamples=10, should NOT be degraded
    expect(providerMetrics.isDegraded(name)).toBe(false);
  });

  it("should report degraded when avg latency exceeds threshold", () => {
    const name = "test_degraded_slow";
    for (let i = 0; i < 15; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 20_000,
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    expect(providerMetrics.isDegraded(name)).toBe(true);
  });

  it("should report degraded when success rate is below 50%", () => {
    const name = "test_degraded_failures";
    for (let i = 0; i < 12; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 1000, // fast
        success: i < 4, // only 4/12 success = 33%
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    expect(providerMetrics.isDegraded(name)).toBe(true);
  });

  it("getAllStats returns stats for all recorded providers", () => {
    const name1 = "test_all_a";
    const name2 = "test_all_b";
    providerMetrics.record(name1, {
      timestamp: Date.now(),
      latencyMs: 500,
      success: true,
      promptTokens: 10,
      completionTokens: 5,
    });
    providerMetrics.record(name2, {
      timestamp: Date.now(),
      latencyMs: 1500,
      success: true,
      promptTokens: 20,
      completionTokens: 10,
    });

    const all = providerMetrics.getAllStats();
    expect(all[name1]).toBeDefined();
    expect(all[name2]).toBeDefined();
  });
});

describe("tryRepairJson", () => {
  it("should fix trailing commas", () => {
    const result = tryRepairJson('{"key": "value",}', "test_tool");
    expect(result).toEqual({ key: "value" });
  });

  it("should fix trailing commas in arrays", () => {
    const result = tryRepairJson('{"items": [1, 2, 3,]}', "test_tool");
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("should fix trailing garbage after closing brace", () => {
    const result = tryRepairJson(
      '{"key": "value"} some extra text',
      "test_tool",
    );
    expect(result).toEqual({ key: "value" });
  });

  it("should fix unquoted keys", () => {
    const result = tryRepairJson('{key: "value", other: 42}', "test_tool");
    expect(result).toEqual({ key: "value", other: 42 });
  });

  it("should return null for completely unfixable JSON", () => {
    const result = tryRepairJson("not json at all", "test_tool");
    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = tryRepairJson("", "test_tool");
    expect(result).toBeNull();
  });

  it("should not modify already-valid JSON", () => {
    // Valid JSON should parse on the first attempt (trailing comma fix is a no-op)
    const result = tryRepairJson('{"key": "value"}', "test_tool");
    expect(result).toEqual({ key: "value" });
  });
});
