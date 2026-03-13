/**
 * Planner tests — mock infer() to return canned goal graphs.
 * Tests JSON parsing, fence-stripping, error handling, dependency resolution.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalStatus } from "./types.js";

// Mock the inference adapter before importing planner
vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

import { plan, replan } from "./planner.js";
import { infer } from "../inference/adapter.js";

const mockInfer = vi.mocked(infer);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("plan", () => {
  it("should parse a simple goal graph from LLM", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "First goal",
            completion_criteria: ["criterion 1"],
            parent_id: null,
            depends_on: [],
          },
          {
            id: "g-2",
            description: "Second goal",
            completion_criteria: ["criterion 2"],
            parent_id: null,
            depends_on: ["g-1"],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 100,
    });

    const { graph, usage } = await plan("Test task");
    expect(graph.size).toBe(2);
    expect(graph.getGoal("g-1").description).toBe("First goal");
    expect(graph.getGoal("g-2").dependsOn).toEqual(["g-1"]);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
  });

  it("should strip markdown fences from LLM output", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        '```json\n{"goals": [{"id": "g-1", "description": "Fenced goal", "completion_criteria": [], "parent_id": null, "depends_on": []}]}\n```',
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph } = await plan("Fenced test");
    expect(graph.size).toBe(1);
    expect(graph.getGoal("g-1").description).toBe("Fenced goal");
  });

  it("should handle parent-child relationships", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Parent",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
          {
            id: "g-2",
            description: "Child",
            completion_criteria: [],
            parent_id: "g-1",
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph } = await plan("Parent-child test");
    expect(graph.getGoal("g-2").parentId).toBe("g-1");
    expect(graph.getGoal("g-1").children).toContain("g-2");
  });

  it("should drop unresolvable dependency references", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Goal with bad dep",
            completion_criteria: [],
            parent_id: null,
            depends_on: ["g-999"], // doesn't exist
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph } = await plan("Bad dep test");
    expect(graph.size).toBe(1);
    // The unresolvable dep should be dropped
    expect(graph.getGoal("g-1").dependsOn).toEqual([]);
  });

  it("should throw on invalid JSON from LLM", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "This is not JSON at all",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    await expect(plan("Invalid JSON test")).rejects.toThrow("invalid JSON");
  });

  it("should throw on missing goals array", async () => {
    mockInfer.mockResolvedValueOnce({
      content: '{"not_goals": []}',
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    await expect(plan("No goals test")).rejects.toThrow("goals");
  });
});

describe("replan", () => {
  it("should preserve completed goal statuses", async () => {
    // First plan
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Original",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph: originalGraph } = await plan("Task");
    originalGraph.updateStatus("g-1", GoalStatus.COMPLETED);

    // Replan with completed status preserved
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Original",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
            status: "completed",
          },
          {
            id: "g-2",
            description: "New goal",
            completion_criteria: [],
            parent_id: null,
            depends_on: ["g-1"],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph: newGraph } = await replan(
      "Task",
      originalGraph,
      "Goal blocked",
    );
    expect(newGraph.size).toBe(2);
    expect(newGraph.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(newGraph.getGoal("g-2").status).toBe(GoalStatus.PENDING);
  });
});
