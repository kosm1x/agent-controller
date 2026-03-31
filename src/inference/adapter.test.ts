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

import {
  providerMetrics,
  tryRepairJson,
  allToolCallsReadOnly,
  allResultsAreErrors,
  stripStaleSignals,
  stripThinkBlocks,
} from "./adapter.js";

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

// ---------------------------------------------------------------------------
// Loop guard helpers
// ---------------------------------------------------------------------------

describe("allToolCallsReadOnly", () => {
  const tc = (name: string) => ({ function: { name } });

  it("should return true when all tools are read-only", () => {
    expect(
      allToolCallsReadOnly([tc("file_read"), tc("grep"), tc("glob")]),
    ).toBe(true);
  });

  it("should return false when any tool is an action tool", () => {
    expect(allToolCallsReadOnly([tc("file_read"), tc("file_edit")])).toBe(
      false,
    );
  });

  it("should return true for read-only browser MCP tools", () => {
    expect(
      allToolCallsReadOnly([
        tc("browser__goto"),
        tc("browser__markdown"),
        tc("browser__links"),
      ]),
    ).toBe(true);
  });

  it("should return false for action browser MCP tools", () => {
    expect(
      allToolCallsReadOnly([tc("browser__goto"), tc("browser__click")]),
    ).toBe(false);
  });

  it("should return true for empty array (vacuous truth)", () => {
    expect(allToolCallsReadOnly([])).toBe(true);
  });

  it("should return false for unknown tools (not in read-only set)", () => {
    expect(allToolCallsReadOnly([tc("some_new_tool")])).toBe(false);
  });
});

describe("allResultsAreErrors", () => {
  const r = (content: string) => ({ content });

  it("should return true when all results contain error indicators", () => {
    expect(
      allResultsAreErrors([
        r("Error: file not found"),
        r("ENOENT: no such file"),
      ]),
    ).toBe(true);
  });

  it("should return false when any result is success-like", () => {
    expect(
      allResultsAreErrors([
        r("Error: something failed"),
        r("Successfully created the file"),
      ]),
    ).toBe(false);
  });

  it("should detect HTTP status codes in JSON responses", () => {
    expect(
      allResultsAreErrors([r('{"error": "bad request", "status": 400}')]),
    ).toBe(true);
    expect(
      allResultsAreErrors([r('{"status": 500, "message": "internal"}')]),
    ).toBe(true);
  });

  it("should return false for normal content", () => {
    expect(
      allResultsAreErrors([
        r("Here is the file content:\nfunction hello() {}"),
      ]),
    ).toBe(false);
  });

  it("should handle large error results (>300 chars)", () => {
    const largeError = "Error: " + "x".repeat(500) + " permission denied";
    expect(allResultsAreErrors([r(largeError)])).toBe(true);
  });

  it("should return true for empty array (vacuous truth)", () => {
    expect(allResultsAreErrors([])).toBe(true);
  });

  it("should return false for non-string content", () => {
    expect(allResultsAreErrors([{ content: 42 }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale signal stripping (Hermes v0.5 pattern)
// ---------------------------------------------------------------------------

describe("stripStaleSignals", () => {
  it("should remove ALTO nudge messages", () => {
    const msgs = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: "do the task" },
      {
        role: "user" as const,
        content:
          "ALTO: Respondiste sin llamar herramientas. EJECUTA con tool calls AHORA.",
      },
      { role: "assistant" as const, content: "ok" },
    ];
    const removed = stripStaleSignals(msgs);
    expect(removed).toBe(1);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => !m.content.includes("ALTO"))).toBe(true);
  });

  it("should remove persistent failure advisory", () => {
    const msgs = [
      { role: "user" as const, content: "task" },
      {
        role: "user" as const,
        content:
          "SYSTEM: Multiple consecutive tool failures detected. Your current approach is not working.",
      },
    ];
    const removed = stripStaleSignals(msgs);
    expect(removed).toBe(1);
    expect(msgs).toHaveLength(1);
  });

  it("should not remove regular user messages", () => {
    const msgs = [
      { role: "user" as const, content: "Please search for something" },
      { role: "user" as const, content: "SYSTEM: This is from the user" },
    ];
    // "SYSTEM: This is from the user" does NOT start with our stale prefix
    const removed = stripStaleSignals(msgs);
    expect(removed).toBe(0);
    expect(msgs).toHaveLength(2);
  });

  it("should return 0 for empty array", () => {
    const msgs: Array<{
      role: "user" | "assistant" | "system" | "tool";
      content: string;
    }> = [];
    expect(stripStaleSignals(msgs)).toBe(0);
  });

  it("should remove multiple stale signals in one pass", () => {
    const msgs = [
      { role: "user" as const, content: "task" },
      {
        role: "user" as const,
        content:
          "ALTO: Respondiste sin llamar herramientas. EJECUTA con tool calls AHORA.",
      },
      { role: "assistant" as const, content: "thinking" },
      {
        role: "user" as const,
        content:
          "SYSTEM: Multiple consecutive tool failures detected. Try different.",
      },
    ];
    const removed = stripStaleSignals(msgs);
    expect(removed).toBe(2);
    expect(msgs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Think-block stripping (Hermes v0.5 pattern)
// ---------------------------------------------------------------------------

describe("stripThinkBlocks", () => {
  it("should strip <think> blocks", () => {
    const input = "<think>Let me reason about this...</think>The answer is 42.";
    expect(stripThinkBlocks(input)).toBe("The answer is 42.");
  });

  it("should strip <thinking> blocks (case insensitive)", () => {
    const input =
      "<THINKING>Deep analysis here</THINKING>\nHere is the result.";
    expect(stripThinkBlocks(input)).toBe("Here is the result.");
  });

  it("should strip <reasoning> blocks", () => {
    const input = "<reasoning>step 1, step 2</reasoning>Final output.";
    expect(stripThinkBlocks(input)).toBe("Final output.");
  });

  it("should strip multiline think blocks", () => {
    const input =
      "<think>\nLine 1\nLine 2\nLine 3\n</think>\nActual response here.";
    expect(stripThinkBlocks(input)).toBe("Actual response here.");
  });

  it("should return empty string when content is only think blocks", () => {
    const input = "<think>All reasoning, no output</think>";
    expect(stripThinkBlocks(input)).toBe("");
  });

  it("should handle content with no think blocks", () => {
    const input = "Normal response without any reasoning tags.";
    expect(stripThinkBlocks(input)).toBe(input);
  });

  it("should strip multiple think blocks", () => {
    const input =
      "<think>first</think>Middle text<thinking>second</thinking>End.";
    expect(stripThinkBlocks(input)).toBe("Middle textEnd.");
  });

  it("should return empty string for empty input", () => {
    expect(stripThinkBlocks("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Loop guard thresholds — tests for the constants and guard logic
// ---------------------------------------------------------------------------

describe("COMMIT tools in READ_ONLY_TOOLS", () => {
  const tc = (name: string) => ({ function: { name } });
  const r = (content: string) => ({ content });

  it("commit__list_tasks is read-only", () => {
    expect(allToolCallsReadOnly([tc("commit__list_tasks")])).toBe(true);
  });

  it("commit__get_daily_snapshot is read-only", () => {
    expect(allToolCallsReadOnly([tc("commit__get_daily_snapshot")])).toBe(true);
  });

  it("commit__list_goals + commit__list_objectives are read-only", () => {
    expect(
      allToolCallsReadOnly([
        tc("commit__list_goals"),
        tc("commit__list_objectives"),
      ]),
    ).toBe(true);
  });

  it("commit__update_status is NOT read-only", () => {
    expect(allToolCallsReadOnly([tc("commit__update_status")])).toBe(false);
  });

  it("commit__update_objective is NOT read-only", () => {
    expect(allToolCallsReadOnly([tc("commit__update_objective")])).toBe(false);
  });

  it("mixed COMMIT read + write returns false", () => {
    expect(
      allToolCallsReadOnly([
        tc("commit__list_tasks"),
        tc("commit__update_task"),
      ]),
    ).toBe(false);
  });

  it("gemini_research is read-only", () => {
    expect(allToolCallsReadOnly([tc("gemini_research")])).toBe(true);
  });
});
