/**
 * Reflector tests — mock infer() to return canned reflection JSON.
 * Tests LLM evaluation, heuristic fallback, score divergence override.
 */

import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";
import { GoalStatus } from "./types.js";
import type { ExecutionResult, GoalResult } from "./types.js";
import { GoalGraph } from "./goal-graph.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

vi.mock("../db/knowledge-maps.js", () => ({
  searchMaps: vi.fn(() => []),
  getNodes: vi.fn(() => []),
}));

import { reflect } from "./reflector.js";
import { infer } from "../inference/adapter.js";
import { searchMaps, getNodes } from "../db/knowledge-maps.js";

const mockInfer = vi.mocked(infer);
const mockSearchMaps = vi.mocked(searchMaps);
const mockGetNodes = vi.mocked(getNodes);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeGraph(completed: number, failed: number): GoalGraph {
  const graph = new GoalGraph();
  for (let i = 0; i < completed; i++) {
    graph.addGoal({
      id: `c-${i}`,
      description: `Completed ${i}`,
      status: GoalStatus.COMPLETED,
    });
  }
  for (let i = 0; i < failed; i++) {
    graph.addGoal({
      id: `f-${i}`,
      description: `Failed ${i}`,
      status: GoalStatus.FAILED,
    });
  }
  return graph;
}

function makeExecResult(graph: GoalGraph): ExecutionResult {
  const goalResults: Record<string, GoalResult> = {};
  const json = graph.toJSON();
  for (const [id, goal] of Object.entries(json.goals)) {
    goalResults[id] = {
      goalId: id,
      ok: goal.status === GoalStatus.COMPLETED,
      result: goal.status === GoalStatus.COMPLETED ? "done" : undefined,
      error: goal.status === GoalStatus.FAILED ? "failed" : undefined,
      durationMs: 100,
      toolCalls: 1,
      toolNames: ["test_tool"],
      toolFailures: goal.status === GoalStatus.FAILED ? 1 : 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
    };
  }
  return {
    goalResults,
    summary: graph.summary(),
    totalToolCalls: Object.keys(goalResults).length,
    totalToolNames: Object.keys(goalResults).map(() => "test_tool"),
    totalToolFailures: Object.values(goalResults).filter((r) => !r.ok).length,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    toolRepairs: [],
  };
}

describe("reflect", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("should return LLM assessment when valid", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: ["Lesson 1"],
        summary: "Good execution",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(9, 1);
    const execResult = makeExecResult(graph);
    const { result, usage } = await reflect("Test task", graph, execResult);

    expect(result.success).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.learnings).toContain("Lesson 1");
    expect(result.summary).toBe("Good execution");
    expect(usage.promptTokens).toBe(200);
    expect(usage.completionTokens).toBe(100);
  });

  it("should fall back to heuristic on invalid LLM JSON", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "This is not JSON",
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    const graph = makeGraph(8, 2);
    const execResult = makeExecResult(graph);
    const { result } = await reflect("Test task", graph, execResult);

    expect(result.score).toBe(0.8); // 8/10
    expect(result.learnings).toContain(
      "Reflection LLM unavailable; scored via heuristic",
    );
  });

  it("should fall back to heuristic on inference error", async () => {
    mockInfer.mockRejectedValueOnce(new Error("Provider down"));

    const graph = makeGraph(5, 5);
    const execResult = makeExecResult(graph);
    const { result } = await reflect("Test task", graph, execResult);

    expect(result.score).toBe(0.5); // 5/10
    expect(result.success).toBe(false);
  });

  it("should override LLM score when divergence > 0.3", async () => {
    // LLM says 1.0 but only 5/10 goals completed
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 1.0,
        learnings: ["Everything great"],
        summary: "Perfect",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(5, 5);
    const execResult = makeExecResult(graph);
    const { result } = await reflect("Test task", graph, execResult);

    // Heuristic override: 5/10 = 0.5, divergence = 0.5 > 0.3
    expect(result.score).toBe(0.5);
    expect(result.success).toBe(false); // score < 0.8 and has failed goals
  });

  it("should accept LLM score when close to heuristic", async () => {
    // LLM says 0.85, heuristic is 0.8 — within threshold
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.85,
        learnings: ["Close to heuristic"],
        summary: "Almost perfect",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(8, 2);
    const execResult = makeExecResult(graph);
    const { result } = await reflect("Test task", graph, execResult);

    expect(result.score).toBe(0.85); // LLM score accepted
  });

  it("should include knowledge map concepts in reflect prompt", async () => {
    mockSearchMaps.mockReturnValueOnce([
      {
        id: "telecom",
        topic: "Telecom Regulation",
        node_count: 2,
        max_depth: 0,
        created_at: "2026-04-03 00:00:00",
        updated_at: "2026-04-03 00:00:00",
      },
    ] as never);
    mockGetNodes.mockReturnValueOnce([
      {
        id: "n-1",
        map_id: "telecom",
        label: "Spectrum Auction",
        type: "concept",
        summary: "How bandwidth is allocated",
        depth: 0,
        parent_id: null,
        created_at: "",
      },
      {
        id: "n-2",
        map_id: "telecom",
        label: "Regulatory Capture",
        type: "gotcha",
        summary: "When regulators serve industry",
        depth: 0,
        parent_id: null,
        created_at: "",
      },
    ] as never);

    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: ["Good coverage"],
        summary: "Solid analysis",
      }),
      tool_calls: undefined,
      usage: {
        prompt_tokens: 300,
        completion_tokens: 80,
        total_tokens: 380,
      },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(9, 1);
    const execResult = makeExecResult(graph);
    await reflect("Analyze telecom regulation", graph, execResult);

    // Verify map context was included in the prompt sent to LLM
    const callArgs = mockInfer.mock.calls[0][0];
    const userMsg = callArgs.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("Domain Knowledge Map");
    expect(userMsg!.content).toContain("Spectrum Auction");
    expect(userMsg!.content).toContain("Regulatory Capture");
  });

  it("should include provenance section in reflect prompt", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: ["Good sources"],
        summary: "Well researched",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(9, 1);
    const execResult = makeExecResult(graph);
    execResult.provenanceRecords = [
      {
        goalId: "c-0",
        tool_name: "web_search",
        url: "https://example.com",
        query: "test",
        status: "verified",
        snippet: "content",
      },
      {
        goalId: "c-0",
        tool_name: "output_citation",
        url: "https://untraced.com",
        query: null,
        status: "unverified",
        snippet: null,
      },
    ];

    await reflect("Research test task", graph, execResult);

    const callArgs = mockInfer.mock.calls[0][0];
    const userMsg = callArgs.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg!.content).toContain("Source Provenance");
    expect(userMsg!.content).toContain("verified: 1");
    expect(userMsg!.content).toContain("unverified: 1");
  });

  it("should penalize score when anchoring is weak", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: [],
        summary: "Done",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(9, 1);
    const execResult = makeExecResult(graph);
    // 0 verified out of 4 sources → anchoring = 0, penalty = 0.5 * 0.2 = 0.1
    execResult.provenanceRecords = [
      {
        goalId: "c-0",
        tool_name: "output_citation",
        url: "https://a.com",
        query: null,
        status: "unverified",
        snippet: null,
      },
      {
        goalId: "c-0",
        tool_name: "output_citation",
        url: "https://b.com",
        query: null,
        status: "unverified",
        snippet: null,
      },
      {
        goalId: "c-0",
        tool_name: "web_search",
        url: "https://c.com",
        query: "q",
        status: "inferred",
        snippet: null,
      },
      {
        goalId: "c-0",
        tool_name: "web_search",
        url: "https://d.com",
        query: "q",
        status: "inferred",
        snippet: null,
      },
    ];

    const { result } = await reflect("Research task", graph, execResult);

    // 0/4 verified → anchoringScore = 0 → penalty = 0.5 * 0.2 = 0.1
    expect(result.score).toBe(0.8); // 0.9 - 0.1
    expect(result.anchoringScore).toBe(0);
  });
});
