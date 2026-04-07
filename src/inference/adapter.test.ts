/**
 * Tests for inference adapter — ProviderMetrics and token budget enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  estimateTokens: vi.fn(() => 0),
}));

import {
  providerMetrics,
  tryRepairJson,
  allToolCallsReadOnly,
  allResultsAreErrors,
  stripStaleSignals,
  stripThinkBlocks,
  salvageTruncatedContent,
} from "./adapter.js";

beforeEach(() => {
  // Reset metrics between tests by recording nothing (ProviderMetrics has no
  // public reset, but we can test fresh state per provider name)
});

afterEach(() => {
  vi.restoreAllMocks();
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
    for (let i = 0; i < 3; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 100_000, // above 90s healthy threshold
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    // Only 3 samples, minSamples=5, should NOT be degraded
    expect(providerMetrics.isDegraded(name)).toBe(false);
  });

  it("should report degraded when avg latency exceeds unhealthy threshold (180s)", () => {
    const name = "test_degraded_slow";
    for (let i = 0; i < 8; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 200_000, // 200s > 180s unhealthy threshold
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    expect(providerMetrics.isDegraded(name)).toBe(true);
  });

  it("should NOT report degraded at moderate latency (100s < 180s threshold)", () => {
    const name = "test_not_degraded_moderate";
    for (let i = 0; i < 8; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 100_000, // 100s < 180s threshold — not degraded
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    expect(providerMetrics.isDegraded(name)).toBe(false);
  });

  it("should report degraded when error rate exceeds 25%", () => {
    const name = "test_degraded_failures";
    for (let i = 0; i < 8; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 1000, // fast
        success: i < 5, // 5/8 success = 62.5%, error rate 37.5% > 25%
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    expect(providerMetrics.isDegraded(name)).toBe(true);
  });

  it("should NOT report degraded at moderate error rate (17% < 25% threshold)", () => {
    const name = "test_not_degraded_moderate_errors";
    for (let i = 0; i < 12; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 1000,
        success: i < 10, // 10/12 success = 83%, error rate 17% < 25%
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    expect(providerMetrics.isDegraded(name)).toBe(false);
  });

  it("caps failures per taskId — single task with 10 failures counts as 2 (v6.4 OH1.5)", () => {
    const name = "test_per_task_cap";
    // 5 successes from interactive traffic
    for (let i = 0; i < 5; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 1000,
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    // 10 failures from a single scheduled task — should be capped at 2
    for (let i = 0; i < 10; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 32000,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
        taskId: "scheduled-task-abc",
      });
    }
    // Without cap: 10/15 = 67% error rate → degraded
    // With cap: 2/(5+2) = 28.6% error rate → just over 25% threshold
    // BUT: this is close to the boundary. Let's add one more success to make it clear.
    providerMetrics.record(name, {
      timestamp: Date.now(),
      latencyMs: 1000,
      success: true,
      promptTokens: 100,
      completionTokens: 50,
    });
    // With cap: 2/(6+2) = 25% = NOT degraded (threshold is >25%, not >=)
    expect(providerMetrics.isDegraded(name)).toBe(false);
  });

  it("degrades when failures come from multiple tasks (not capped)", () => {
    const name = "test_multi_task_failures";
    // 3 successes
    for (let i = 0; i < 3; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 1000,
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    // 4 failures from 4 different tasks (1 each, all counted)
    for (let i = 0; i < 4; i++) {
      providerMetrics.record(name, {
        timestamp: Date.now(),
        latencyMs: 32000,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
        taskId: `task-${i}`,
      });
    }
    // 4/7 = 57% error rate → degraded
    expect(providerMetrics.isDegraded(name)).toBe(true);
  });

  it("classifies health as healthy/degraded/unhealthy", () => {
    // Healthy provider
    const healthy = "test_health_good";
    for (let i = 0; i < 10; i++) {
      providerMetrics.record(healthy, {
        timestamp: Date.now(),
        latencyMs: 30_000, // 30s < 90s
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    const goodStats = providerMetrics.getStats(healthy);
    expect(goodStats?.health).toBe("healthy");

    // Degraded provider
    const degraded = "test_health_degraded";
    for (let i = 0; i < 10; i++) {
      providerMetrics.record(degraded, {
        timestamp: Date.now(),
        latencyMs: 120_000, // 120s — between 90s and 180s
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    const degradedStats = providerMetrics.getStats(degraded);
    expect(degradedStats?.health).toBe("degraded");

    // Unhealthy provider
    const unhealthy = "test_health_bad";
    for (let i = 0; i < 10; i++) {
      providerMetrics.record(unhealthy, {
        timestamp: Date.now(),
        latencyMs: 200_000, // 200s > 180s
        success: true,
        promptTokens: 100,
        completionTokens: 50,
      });
    }
    const badStats = providerMetrics.getStats(unhealthy);
    expect(badStats?.health).toBe("unhealthy");
  });

  it("tracks cost per provider", () => {
    const name = "test_cost";
    for (let i = 0; i < 5; i++) {
      providerMetrics.record(
        name,
        {
          timestamp: Date.now(),
          latencyMs: 5000,
          success: true,
          promptTokens: 10_000,
          completionTokens: 500,
        },
        "qwen3.5-plus",
      );
    }
    const stats = providerMetrics.getStats(name);
    // 5 calls * (10K prompt/$0.80/M + 500 completion/$2.00/M) = 5 * $0.009 = $0.045
    expect(stats?.costUsd).toBeCloseTo(0.045, 4);
    expect(stats?.totalTokens).toBe(52_500); // 5 * (10000 + 500)
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

  it("should return false for empty array (no tools = no read-only claim)", () => {
    expect(allToolCallsReadOnly([])).toBe(false);
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

  it("should return false for empty array (no results = no error claim)", () => {
    expect(allResultsAreErrors([])).toBe(false);
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

describe("READ_ONLY_TOOLS classification", () => {
  const tc = (name: string) => ({ function: { name } });

  it("jarvis_file_read is read-only", () => {
    expect(allToolCallsReadOnly([tc("jarvis_file_read")])).toBe(true);
  });

  it("project_list + project_get are read-only", () => {
    expect(allToolCallsReadOnly([tc("project_list"), tc("project_get")])).toBe(
      true,
    );
  });

  it("file_write is NOT read-only", () => {
    expect(allToolCallsReadOnly([tc("file_write")])).toBe(false);
  });

  it("mixed read + write returns false", () => {
    expect(
      allToolCallsReadOnly([tc("jarvis_file_read"), tc("file_write")]),
    ).toBe(false);
  });

  it("gemini_research is read-only", () => {
    expect(allToolCallsReadOnly([tc("gemini_research")])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// salvageTruncatedContent
// ---------------------------------------------------------------------------

describe("salvageTruncatedContent", () => {
  it("extracts content from truncated gdocs_write args", () => {
    const raw =
      '{"document_id": "abc123", "text": "Hello world, this is a long document' +
      "x".repeat(300) +
      "...";
    const result = salvageTruncatedContent(raw);
    expect(result).not.toBeNull();
    expect(result!).toContain("Hello world");
    expect(result!.length).toBeGreaterThan(200);
  });

  it("extracts content field from truncated args", () => {
    const raw =
      '{"path": "/tmp/test.txt", "content": "Big file content here' +
      "y".repeat(300);
    const result = salvageTruncatedContent(raw);
    expect(result).not.toBeNull();
    expect(result!).toContain("Big file content here");
  });

  it("returns null when content is too short", () => {
    const raw = '{"text": "short"}';
    expect(salvageTruncatedContent(raw)).toBeNull();
  });

  it("returns null when no content field found", () => {
    const raw =
      '{"document_id": "abc123", "title": "something' + "x".repeat(300);
    expect(salvageTruncatedContent(raw)).toBeNull();
  });

  it("unescapes JSON newlines and quotes", () => {
    const raw =
      '{"text": "line1\\nline2\\tindented and a \\"quote\\"' + "x".repeat(300);
    const result = salvageTruncatedContent(raw);
    expect(result).not.toBeNull();
    expect(result!).toContain("line1\nline2"); // \n → actual newline
    expect(result!).toContain("line2\tindented"); // \t → actual tab
    expect(result!).toContain('"quote"'); // \" → actual quote
  });

  it("handles body field name", () => {
    const raw =
      '{"to": "test@test.com", "body": "Email body content here' +
      "z".repeat(300);
    const result = salvageTruncatedContent(raw);
    expect(result).not.toBeNull();
    expect(result!).toContain("Email body content here");
  });
});
