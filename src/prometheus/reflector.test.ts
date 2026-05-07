/**
 * Reflector tests — mock infer() to return canned reflection JSON.
 * Tests LLM evaluation, heuristic fallback, score divergence override.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoalStatus } from "./types.js";
import type { ExecutionResult, GoalResult } from "./types.js";
import { GoalGraph } from "./goal-graph.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

// Force the openai/qwen path so the mocked infer() is exercised.
// The SDK path is covered by claude-sdk.test.ts.
vi.mock("../config.js", () => ({
  getConfig: () => ({ inferencePrimaryProvider: "openai" }),
}));

vi.mock("../db/knowledge-maps.js", () => ({
  searchMaps: vi.fn(() => []),
  getNodes: vi.fn(() => []),
}));

vi.mock("../db/reflector-gap.js", () => ({
  logReflectorGap: vi.fn(),
}));

import { reflect } from "./reflector.js";
import { infer } from "../inference/adapter.js";
import { searchMaps, getNodes } from "../db/knowledge-maps.js";
import { logReflectorGap } from "../db/reflector-gap.js";

const mockInfer = vi.mocked(infer);
const mockSearchMaps = vi.mocked(searchMaps);
const mockGetNodes = vi.mocked(getNodes);
const mockLogReflectorGap = vi.mocked(logReflectorGap);

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
  afterEach(() => {
    vi.restoreAllMocks();
  });
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

  it("should parse CoT-prefixed reflection responses (autoreason)", async () => {
    // With chain-of-thought judges, reflection output has reasoning prose
    // followed by the JSON verdict. Parser must tolerate leading prose.
    mockInfer.mockResolvedValueOnce({
      content:
        `Let me think step by step about this execution:\n` +
        `1. 9 of 10 goals completed with usable output.\n` +
        `2. 1 goal failed on a transient network error.\n` +
        `3. Tool call count is reasonable (~2 per goal).\n` +
        `4. No domain map provided, so skipping concept coverage.\n\n` +
        `{"success": true, "score": 0.9, "learnings": ["Handle transient network errors with retries"], "summary": "Nine of ten goals completed; one transient failure"}`,
      tool_calls: undefined,
      usage: { prompt_tokens: 250, completion_tokens: 120, total_tokens: 370 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(9, 1);
    const execResult = makeExecResult(graph);
    const { result } = await reflect(
      "Test task",
      graph,
      execResult,
      "task-cot",
    );

    expect(result.score).toBe(0.9);
    expect(result.success).toBe(true);
    expect(result.learnings).toContain(
      "Handle transient network errors with retries",
    );
  });

  it("should log generation-evaluation gap telemetry when taskId is present", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.85,
        learnings: ["ok"],
        summary: "done",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(8, 2);
    const execResult = makeExecResult(graph);
    await reflect("Test task", graph, execResult, "task-gap");

    expect(mockLogReflectorGap).toHaveBeenCalledTimes(1);
    const call = mockLogReflectorGap.mock.calls[0][0];
    expect(call.taskId).toBe("task-gap");
    expect(call.llmScore).toBe(0.85);
    expect(call.heuristicScore).toBe(0.8); // 8/10
    expect(call.llmAvailable).toBe(true);
    expect(call.goalsTotal).toBe(10);
    expect(call.goalsCompleted).toBe(8);
    expect(call.goalsFailed).toBe(2);
  });

  it("should log telemetry with llmAvailable=false when LLM fails", async () => {
    mockInfer.mockRejectedValueOnce(new Error("Provider down"));

    const graph = makeGraph(5, 5);
    const execResult = makeExecResult(graph);
    await reflect("Test task", graph, execResult, "task-gap-fallback");

    expect(mockLogReflectorGap).toHaveBeenCalledTimes(1);
    const call = mockLogReflectorGap.mock.calls[0][0];
    expect(call.llmAvailable).toBe(false);
    // When LLM is unavailable, rawLlmScore falls back to the heuristic
    // assessment score — so llmScore === heuristicScore by construction.
    expect(call.llmScore).toBe(0.5);
    expect(call.heuristicScore).toBe(0.5);
  });

  it("should skip telemetry when taskId is not provided", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: [],
        summary: "",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 100,
    });

    const graph = makeGraph(9, 1);
    const execResult = makeExecResult(graph);
    await reflect("Test task", graph, execResult);

    expect(mockLogReflectorGap).not.toHaveBeenCalled();
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

describe("reflect — per-dimension critiques (RationalRewards / v7.5 L3)", () => {
  it("returns dimensions when LLM emits a well-formed array", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: ["L"],
        summary: "ok",
        dimensions: [
          { dimension: "completion", score: 0.95, evidence: "9/10 done" },
          { dimension: "correctness", score: 1.0, evidence: "no errors" },
          {
            dimension: "evidence_quality",
            score: 0.8,
            evidence: "1 unsourced",
          },
          {
            dimension: "effort",
            score: 0.6,
            evidence: "12 calls for 3 goals",
          },
          {
            dimension: "domain_coverage",
            score: 1.0,
            evidence: "n/a — no map",
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      provider: "test",
      latency_ms: 50,
    });

    const graph = makeGraph(9, 1);
    const { result } = await reflect("t", graph, makeExecResult(graph));
    expect(result.dimensions).toHaveLength(5);
    expect(result.dimensions?.[3]).toEqual({
      dimension: "effort",
      score: 0.6,
      evidence: "12 calls for 3 goals",
    });
  });

  it("drops malformed dimension entries (unknown name, bad score, missing evidence)", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: [],
        summary: "ok",
        dimensions: [
          { dimension: "completion", score: 0.9, evidence: "ok" },
          { dimension: "made-up-dim", score: 0.5, evidence: "x" }, // unknown name → drop
          { dimension: "correctness", score: "high", evidence: "x" }, // bad score → drop
          { dimension: "effort", score: 0.4 }, // missing evidence → drop
          { dimension: "domain_coverage", score: 1.5, evidence: "x" }, // clamps to 1
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    const graph = makeGraph(9, 1);
    const { result } = await reflect("t", graph, makeExecResult(graph));
    expect(result.dimensions?.length).toBe(2); // completion + domain_coverage
    const names = result.dimensions?.map((d) => d.dimension);
    expect(names).toEqual(["completion", "domain_coverage"]);
    const dom = result.dimensions?.find(
      (d) => d.dimension === "domain_coverage",
    );
    expect(dom?.score).toBe(1); // clamped from 1.5
  });

  it("returns dimensions = undefined when LLM omits the field", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: [],
        summary: "ok",
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    const graph = makeGraph(9, 1);
    const { result } = await reflect("t", graph, makeExecResult(graph));
    expect(result.dimensions).toBeUndefined();
  });

  it("returns dimensions = undefined when LLM emits a non-array value", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: [],
        summary: "ok",
        dimensions: "completion: 0.9", // wrong type
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    const graph = makeGraph(9, 1);
    const { result } = await reflect("t", graph, makeExecResult(graph));
    expect(result.dimensions).toBeUndefined();
  });

  it("heuristic fallback path emits no dimensions", async () => {
    mockInfer.mockRejectedValueOnce(new Error("upstream down"));
    const graph = makeGraph(8, 2);
    const { result } = await reflect("t", graph, makeExecResult(graph));
    expect(result.dimensions).toBeUndefined();
  });

  it("drops dimensions when score override fires (audit W1)", async () => {
    // LLM claims 0.9 with detailed dimensions; heuristic disagrees by >0.3
    // → score gets overwritten. Dimensions describe the LLM's number, not
    // the kept score, so they MUST be dropped.
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        success: true,
        score: 0.9,
        learnings: ["L"],
        summary: "ok",
        dimensions: [
          {
            dimension: "completion",
            score: 0.9,
            evidence: "9/10 complete (LLM view)",
          },
          { dimension: "correctness", score: 1.0, evidence: "no errors" },
          { dimension: "evidence_quality", score: 0.9, evidence: "ok" },
          { dimension: "effort", score: 0.9, evidence: "ok" },
          { dimension: "domain_coverage", score: 1.0, evidence: "n/a" },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    // 2/10 completed → heuristic = 0.2 → divergence = 0.7 → override fires
    const graph = makeGraph(2, 8);
    const { result } = await reflect("t", graph, makeExecResult(graph));
    expect(result.score).toBeCloseTo(0.2, 1);
    expect(result.dimensions).toBeUndefined();
  });
});

describe("lowestDimension — replan target picker", () => {
  it("returns undefined for empty / missing input", async () => {
    const { lowestDimension } = await import("./reflector.js");
    expect(lowestDimension(undefined)).toBeUndefined();
    expect(lowestDimension([])).toBeUndefined();
  });

  it("returns the minimum-scoring dimension", async () => {
    const { lowestDimension } = await import("./reflector.js");
    const min = lowestDimension([
      { dimension: "completion", score: 0.9, evidence: "a" },
      { dimension: "effort", score: 0.4, evidence: "b" },
      { dimension: "correctness", score: 0.7, evidence: "c" },
    ]);
    expect(min?.dimension).toBe("effort");
    expect(min?.score).toBe(0.4);
  });

  it("breaks ties deterministically by first occurrence", async () => {
    const { lowestDimension } = await import("./reflector.js");
    const min = lowestDimension([
      { dimension: "effort", score: 0.5, evidence: "first" },
      { dimension: "completion", score: 0.5, evidence: "second" },
    ]);
    expect(min?.dimension).toBe("effort");
    expect(min?.evidence).toBe("first");
  });
});
