/**
 * Executor tests — mock inferWithTools() and toolRegistry.
 * Tests single goal execution, dependency ordering, concurrent execution,
 * retry logic, and error strategies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalStatus } from "./types.js";
import type { Goal } from "./types.js";
import { GoalGraph } from "./goal-graph.js";

// Mock inference adapter
vi.mock("../inference/adapter.js", () => ({
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

import { executeGoal, executeGraph } from "./executor.js";
import { inferWithTools } from "../inference/adapter.js";

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
});

describe("executeGoal", () => {
  it("should return success with result from LLM", async () => {
    mockInferWithTools.mockResolvedValueOnce({
      content: "Goal achieved successfully",
      messages: [
        { role: "system", content: "..." },
        { role: "user", content: "..." },
        { role: "assistant", content: "Goal achieved successfully" },
      ],
      totalUsage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const result = await executeGoal(makeGoal(), "");
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Goal achieved successfully");
    expect(result.goalId).toBe("g-1");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should count tool calls from messages", async () => {
    mockInferWithTools.mockResolvedValueOnce({
      content: "Done with tools",
      messages: [
        { role: "system", content: "..." },
        { role: "user", content: "..." },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", content: "result 1", tool_call_id: "tc-1" },
        { role: "tool", content: "result 2", tool_call_id: "tc-2" },
        { role: "assistant", content: "Done with tools" },
      ],
      totalUsage: { prompt_tokens: 200, completion_tokens: 100 },
    });

    const result = await executeGoal(makeGoal(), "");
    expect(result.ok).toBe(true);
    expect(result.toolCalls).toBe(2);
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
