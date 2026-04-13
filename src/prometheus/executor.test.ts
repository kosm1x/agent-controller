/**
 * Executor tests — mock inferWithTools() and toolRegistry.
 * Tests single goal execution, dependency ordering, concurrent execution,
 * retry logic, and error strategies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoalStatus } from "./types.js";
import type { Goal } from "./types.js";
import { GoalGraph } from "./goal-graph.js";

// Mock inference adapter
vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
  inferWithTools: vi.fn(),
}));

// Mock tool registry
vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    getDefinitions: vi.fn(() => [
      {
        type: "function",
        function: {
          name: "test_tool",
          description: "test",
          parameters: {},
        },
      },
    ]),
    execute: vi.fn(async () => "tool result"),
  },
}));

import { executeGoal, executeGraph, selfAssess } from "./executor.js";
import { infer, inferWithTools } from "../inference/adapter.js";

const mockInfer = vi.mocked(infer);
const mockInferWithTools = vi.mocked(inferWithTools);

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g-1",
    description: "Test goal",
    status: GoalStatus.PENDING,
    completionCriteria: ["criterion 1"],
    parentId: null,
    dependsOn: [],
    children: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: self-assessment says criteria are met (existing tests pass unmodified)
  mockInfer.mockResolvedValue({
    content: JSON.stringify({
      met: true,
      unmetCriteria: [],
      reasoning: "All criteria satisfied",
    }),
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    provider: "mock",
    latency_ms: 0,
  });
});

describe("executeGoal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("should return success with result from LLM", async () => {
    mockInferWithTools.mockResolvedValueOnce({
      content: "Goal achieved successfully",
      messages: [
        { role: "system", content: "..." },
        { role: "user", content: "..." },
        { role: "assistant", content: "Goal achieved successfully" },
      ],
      toolRepairs: [],
      totalUsage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const result = await executeGoal(makeGoal(), "");
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Goal achieved successfully");
    expect(result.goalId).toBe("g-1");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // 100 from inferWithTools + 20 from selfAssess = 120
    expect(result.tokenUsage.promptTokens).toBe(120);
    // 50 from inferWithTools + 10 from selfAssess = 60
    expect(result.tokenUsage.completionTokens).toBe(60);
  });

  it("should count tool calls and extract names from messages", async () => {
    mockInferWithTools.mockResolvedValueOnce({
      content: "Done with tools",
      messages: [
        { role: "system", content: "..." },
        { role: "user", content: "..." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "web_search", arguments: "{}" },
            },
            {
              id: "tc-2",
              type: "function",
              function: { name: "gmail_send", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result 1", tool_call_id: "tc-1" },
        { role: "tool", content: "result 2", tool_call_id: "tc-2" },
        { role: "assistant", content: "Done with tools" },
      ],
      toolRepairs: [],
      totalUsage: { prompt_tokens: 200, completion_tokens: 100 },
    });

    const result = await executeGoal(makeGoal(), "");
    expect(result.ok).toBe(true);
    expect(result.toolCalls).toBe(2);
    expect(result.toolNames).toEqual(["web_search", "gmail_send"]);
  });

  it("should retry on transient errors then succeed", async () => {
    mockInferWithTools
      .mockRejectedValueOnce(new Error("HTTP 429: rate limit"))
      .mockResolvedValueOnce({
        content: "Succeeded on retry",
        messages: [
          { role: "system", content: "..." },
          { role: "assistant", content: "Succeeded on retry" },
        ],
        toolRepairs: [],
        totalUsage: { prompt_tokens: 100, completion_tokens: 50 },
      });

    const result = await executeGoal(makeGoal(), "");
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Succeeded on retry");
    expect(mockInferWithTools).toHaveBeenCalledTimes(2);
  });

  it("should fail after max retries", async () => {
    mockInferWithTools
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await executeGoal(makeGoal(), "");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
    expect(result.toolFailures).toBe(1);
  });
});

describe("executeGraph", () => {
  it("should execute goals in dependency order", async () => {
    const callOrder: string[] = [];

    mockInferWithTools.mockImplementation(async (messages) => {
      // Extract goal ID from the system prompt
      const sys = messages[0]?.content as string;
      if (sys.includes("First")) callOrder.push("g-1");
      if (sys.includes("Second")) callOrder.push("g-2");

      return {
        content: "Done",
        messages: [{ role: "assistant", content: "Done" }],
        toolRepairs: [],
        totalUsage: { prompt_tokens: 50, completion_tokens: 25 },
      };
    });

    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "First goal" });
    graph.addGoal({
      id: "g-2",
      description: "Second goal",
      dependsOn: ["g-1"],
    });

    const result = await executeGraph(graph);

    expect(result.totalToolCalls).toBeGreaterThanOrEqual(0);
    expect(callOrder).toEqual(["g-1", "g-2"]); // g-1 before g-2
    expect(graph.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(graph.getGoal("g-2").status).toBe(GoalStatus.COMPLETED);
  });

  it("should execute independent goals concurrently", async () => {
    const startTimes: Record<string, number> = {};

    mockInferWithTools.mockImplementation(async (messages) => {
      const sys = messages[0]?.content as string;
      const id = sys.includes("Goal A") ? "a" : "b";
      startTimes[id] = Date.now();

      return {
        content: "Done",
        messages: [{ role: "assistant", content: "Done" }],
        toolRepairs: [],
        totalUsage: { prompt_tokens: 50, completion_tokens: 25 },
      };
    });

    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "Goal A" });
    graph.addGoal({ id: "g-2", description: "Goal B" });
    // No dependency — both should be ready

    const result = await executeGraph(graph);

    expect(graph.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(graph.getGoal("g-2").status).toBe(GoalStatus.COMPLETED);
    // Both started in the same iteration
    expect(Object.keys(startTimes).sort()).toEqual(["a", "b"]);
  });

  it("should mark dependent goals as blocked when dep fails", async () => {
    mockInferWithTools.mockRejectedValue(new Error("fatal error"));

    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "Will fail" });
    graph.addGoal({
      id: "g-2",
      description: "Depends on g-1",
      dependsOn: ["g-1"],
    });

    const result = await executeGraph(graph);

    expect(graph.getGoal("g-1").status).toBe(GoalStatus.FAILED);
    expect(graph.getGoal("g-2").status).toBe(GoalStatus.BLOCKED);
    expect(result.totalToolFailures).toBeGreaterThan(0);
  });

  it("should return empty results for empty graph", async () => {
    const graph = new GoalGraph();
    const result = await executeGraph(graph);

    expect(Object.keys(result.goalResults)).toHaveLength(0);
    expect(result.totalToolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Self-assessment tests
// ---------------------------------------------------------------------------

describe("selfAssess", () => {
  it("should return null assessment for goals with no criteria", async () => {
    const goal = makeGoal({ completionCriteria: [] });
    const { assessment, usage } = await selfAssess(goal, "some output");
    expect(assessment).toBeNull();
    expect(usage.promptTokens).toBe(0);
  });

  it("should return met=true when criteria satisfied", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        met: true,
        unmetCriteria: [],
        reasoning: "All criteria satisfied",
      }),
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      provider: "mock",
      latency_ms: 0,
    });

    const goal = makeGoal({ completionCriteria: ["must return a number"] });
    const { assessment, usage } = await selfAssess(goal, "The answer is 42");
    expect(assessment).not.toBeNull();
    expect(assessment!.met).toBe(true);
    expect(assessment!.unmetCriteria).toEqual([]);
    expect(usage.promptTokens).toBe(20);
  });

  it("should return met=false with unmet criteria list", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        met: false,
        unmetCriteria: ["must include a chart"],
        reasoning: "No chart was generated",
      }),
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      provider: "mock",
      latency_ms: 0,
    });

    const goal = makeGoal({
      completionCriteria: ["must return a number", "must include a chart"],
    });
    const { assessment } = await selfAssess(goal, "The answer is 42");
    expect(assessment!.met).toBe(false);
    expect(assessment!.unmetCriteria).toEqual(["must include a chart"]);
  });

  it("should return met=true when infer throws (graceful fallback)", async () => {
    mockInfer.mockRejectedValueOnce(new Error("LLM unavailable"));

    const goal = makeGoal({ completionCriteria: ["some criterion"] });
    const { assessment } = await selfAssess(goal, "output");
    expect(assessment!.met).toBe(true); // Assumes met on failure
  });

  it("should parse CoT-prefixed JSON responses (autoreason)", async () => {
    // With chain-of-thought judges, the model emits reasoning prose first,
    // then the JSON verdict. The parser must tolerate the leading prose.
    mockInfer.mockResolvedValueOnce({
      content:
        `Let me think step by step:\n` +
        `1. The output provides a numeric answer (42).\n` +
        `2. This is direct and verifiable.\n` +
        `3. A strict reviewer would accept this as "met".\n\n` +
        `{"met": true, "unmetCriteria": [], "reasoning": "numeric answer present"}`,
      usage: { prompt_tokens: 80, completion_tokens: 50, total_tokens: 130 },
      provider: "mock",
      latency_ms: 0,
    });

    const goal = makeGoal({ completionCriteria: ["must return a number"] });
    const { assessment } = await selfAssess(goal, "42");
    expect(assessment!.met).toBe(true);
    expect(assessment!.reasoning).toBe("numeric answer present");
  });

  it("should handle malformed LLM JSON with safe defaults", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({ met: false }), // missing unmetCriteria and reasoning
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      provider: "mock",
      latency_ms: 0,
    });

    const goal = makeGoal({ completionCriteria: ["criterion"] });
    const { assessment } = await selfAssess(goal, "output");
    expect(assessment!.met).toBe(false);
    expect(assessment!.unmetCriteria).toEqual([]); // safe default
    expect(assessment!.reasoning).toBe(""); // safe default
  });
});

describe("executeGoal self-assessment integration", () => {
  it("should re-run with reflection when criteria not met", async () => {
    // First inferWithTools: produces initial output
    mockInferWithTools
      .mockResolvedValueOnce({
        content: "Partial result without chart",
        messages: [
          { role: "system", content: "..." },
          { role: "assistant", content: "Partial result without chart" },
        ],
        toolRepairs: [],
        totalUsage: { prompt_tokens: 100, completion_tokens: 50 },
      })
      // Second inferWithTools: after reflection, produces complete output
      .mockResolvedValueOnce({
        content: "Complete result with chart included",
        messages: [
          { role: "system", content: "..." },
          { role: "assistant", content: "Complete result with chart included" },
        ],
        toolRepairs: [],
        totalUsage: { prompt_tokens: 150, completion_tokens: 60 },
      });

    // Self-assessment: first call says not met, second says met
    mockInfer
      .mockResolvedValueOnce({
        content: JSON.stringify({
          met: false,
          unmetCriteria: ["must include a chart"],
          reasoning: "No chart found in output",
        }),
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        provider: "mock",
        latency_ms: 0,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          met: true,
          unmetCriteria: [],
          reasoning: "All criteria satisfied",
        }),
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        provider: "mock",
        latency_ms: 0,
      });

    const goal = makeGoal({
      completionCriteria: ["must include a chart"],
    });

    const result = await executeGoal(goal, "");
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Complete result with chart included");
    expect(result.selfAssessRounds).toBe(1);
    // Token usage: inferWithTools(100+150) + selfAssess(20+20) = 290 prompt
    expect(result.tokenUsage.promptTokens).toBe(290);
    // Token usage: inferWithTools(50+60) + selfAssess(10+10) = 130 completion
    expect(result.tokenUsage.completionTokens).toBe(130);
    // inferWithTools called twice (initial + retry)
    expect(mockInferWithTools).toHaveBeenCalledTimes(2);
  });

  it("should skip self-assessment for goals without criteria", async () => {
    mockInferWithTools.mockResolvedValueOnce({
      content: "Done",
      messages: [{ role: "assistant", content: "Done" }],
      toolRepairs: [],
      totalUsage: { prompt_tokens: 50, completion_tokens: 25 },
    });

    const goal = makeGoal({ completionCriteria: [] });
    const result = await executeGoal(goal, "");
    expect(result.ok).toBe(true);
    expect(result.selfAssessRounds).toBe(0);
    // infer (selfAssess) should NOT be called
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("should cap at MAX_SELF_ASSESS rounds and return best-effort", async () => {
    // Initial inferWithTools
    mockInferWithTools.mockResolvedValue({
      content: "Still incomplete",
      messages: [{ role: "assistant", content: "Still incomplete" }],
      toolRepairs: [],
      totalUsage: { prompt_tokens: 50, completion_tokens: 25 },
    });

    // Self-assessment always says not met
    mockInfer.mockResolvedValue({
      content: JSON.stringify({
        met: false,
        unmetCriteria: ["must be complete"],
        reasoning: "Output is still incomplete",
      }),
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      provider: "mock",
      latency_ms: 0,
    });

    const goal = makeGoal({ completionCriteria: ["must be complete"] });
    const result = await executeGoal(goal, "");

    expect(result.ok).toBe(true); // Still returns ok — best effort
    expect(result.selfAssessRounds).toBe(2); // Capped at MAX_SELF_ASSESS
    // 1 initial + 2 retry rounds = 3 inferWithTools calls
    expect(mockInferWithTools).toHaveBeenCalledTimes(3);
  });
});
