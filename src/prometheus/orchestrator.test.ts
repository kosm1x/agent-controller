/**
 * Orchestrator integration test — mock planner, executor, reflector.
 * Tests the plan→execute→reflect flow, replan triggers, event emission.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoalStatus } from "./types.js";
import type { ExecutionResult, ReflectionResult } from "./types.js";
import { GoalGraph } from "./goal-graph.js";

// Mock all dependencies
vi.mock("./planner.js", () => ({
  plan: vi.fn(),
  replan: vi.fn(),
}));

vi.mock("./executor.js", () => ({
  executeGraph: vi.fn(),
}));

vi.mock("./reflector.js", () => ({
  reflect: vi.fn(),
}));

vi.mock("./snapshot.js", () => ({
  saveSnapshot: vi.fn(),
  clearSnapshot: vi.fn(),
}));

vi.mock("../lib/event-bus.js", () => ({
  eventBus: {
    emit: vi.fn(() => true),
    broadcast: vi.fn(),
    on: vi.fn(),
  },
}));

import { orchestrate } from "./orchestrator.js";
import { plan, replan } from "./planner.js";
import { executeGraph } from "./executor.js";
import { reflect } from "./reflector.js";
import { eventBus } from "../lib/event-bus.js";

const mockPlan = vi.mocked(plan);
const mockReplan = vi.mocked(replan);
const mockExecuteGraph = vi.mocked(executeGraph);
const mockReflect = vi.mocked(reflect);
const mockEventBusEmit = vi.mocked(eventBus.emit);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeGraph(): GoalGraph {
  const graph = new GoalGraph();
  graph.addGoal({
    id: "g-1",
    description: "Goal 1",
    status: GoalStatus.COMPLETED,
  });
  graph.addGoal({
    id: "g-2",
    description: "Goal 2",
    status: GoalStatus.COMPLETED,
  });
  return graph;
}

function makeExecResult(): ExecutionResult {
  return {
    goalResults: {
      "g-1": {
        goalId: "g-1",
        ok: true,
        result: "done",
        durationMs: 100,
        toolCalls: 2,
        toolNames: ["web_search", "gmail_send"],
        toolFailures: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      },
      "g-2": {
        goalId: "g-2",
        ok: true,
        result: "done",
        durationMs: 100,
        toolCalls: 1,
        toolNames: ["file_read"],
        toolFailures: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      },
    },
    summary: {
      completed: 2,
      failed: 0,
      pending: 0,
      blocked: 0,
      in_progress: 0,
      total: 2,
    },
    totalToolCalls: 3,
    totalToolNames: ["web_search", "gmail_send", "file_read"],
    totalToolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    toolRepairs: [],
  };
}

function makeReflection(): ReflectionResult {
  return {
    success: true,
    score: 1.0,
    learnings: ["All goals completed"],
    summary: "Perfect execution",
  };
}

describe("orchestrate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("should run plan→execute→reflect successfully", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 100, completionTokens: 50 },
    });
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 200, completionTokens: 100 },
    });

    const result = await orchestrate("task-1", "Test task");

    expect(result.success).toBe(true);
    expect(result.reflection.score).toBe(1.0);
    expect(result.reflection.summary).toBe("Perfect execution");
    expect(result.goalGraph.goals).toHaveProperty("g-1");
    expect(result.goalGraph.goals).toHaveProperty("g-2");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.traceId).toBeDefined();
    expect(result.tokenUsage.promptTokens).toBe(300); // 100 plan + 200 reflect
    expect(result.tokenUsage.completionTokens).toBe(150); // 50 plan + 100 reflect

    // Verify phase ordering
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockExecuteGraph).toHaveBeenCalledTimes(1);
    expect(mockReflect).toHaveBeenCalledTimes(1);
  });

  it("should emit progress events", async () => {
    mockPlan.mockResolvedValueOnce({
      graph: makeGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    await orchestrate("task-2", "Test task");

    // Should have emitted multiple progress events
    const progressCalls = mockEventBusEmit.mock.calls.filter(
      (call) => call[0] === "task.progress",
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(4); // plan start/end, execute start/end, reflect
  });

  it("should throw when planning fails", async () => {
    mockPlan.mockRejectedValueOnce(new Error("LLM unreachable"));

    await expect(orchestrate("task-3", "Failing task")).rejects.toThrow(
      "Planning failed",
    );
  });

  it("should trigger replan when tool failure rate exceeds threshold", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // First execution: high failure rate
    const highFailExec: ExecutionResult = {
      goalResults: {
        "g-1": {
          goalId: "g-1",
          ok: true,
          result: "done",
          durationMs: 100,
          toolCalls: 5,
          toolNames: [
            "web_search",
            "web_search",
            "web_search",
            "web_search",
            "web_search",
          ],
          toolFailures: 4,
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        },
      },
      summary: {
        completed: 1,
        failed: 1,
        pending: 0,
        blocked: 0,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 5,
      totalToolNames: [
        "web_search",
        "web_search",
        "web_search",
        "web_search",
        "web_search",
      ],
      totalToolFailures: 4,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };
    mockExecuteGraph.mockResolvedValueOnce(highFailExec);

    // Replan returns new graph
    const replanGraph = makeGraph();
    mockReplan.mockResolvedValueOnce({
      graph: replanGraph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // Second execution: clean
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-4", "Replanning task");

    expect(mockReplan).toHaveBeenCalledTimes(1);
    expect(mockExecuteGraph).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it("should respect maxReplans config", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const highFailExec: ExecutionResult = {
      goalResults: {},
      summary: {
        completed: 0,
        failed: 0,
        pending: 0,
        blocked: 1,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 10,
      totalToolNames: [],
      totalToolFailures: 8,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };

    // All executions fail with high failure rate
    mockExecuteGraph.mockResolvedValue(highFailExec);
    mockReplan.mockResolvedValue({
      graph: makeGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    await orchestrate("task-5", "Many replans", { maxReplans: 2 });

    // Should replan at most 2 times
    expect(mockReplan.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("should trigger replan when tool-call-per-goal ratio exceeds threshold", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // Execution with very high tool call count: 25 calls for 2 goals (ratio 12.5 > 10.0)
    const loopyExec: ExecutionResult = {
      goalResults: {
        "g-1": {
          goalId: "g-1",
          ok: true,
          result: "done",
          durationMs: 5000,
          toolCalls: 15,
          toolNames: Array(15).fill("web_search"),
          toolFailures: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        },
        "g-2": {
          goalId: "g-2",
          ok: true,
          result: "done",
          durationMs: 3000,
          toolCalls: 10,
          toolNames: Array(10).fill("file_read"),
          toolFailures: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        },
      },
      summary: {
        completed: 2,
        failed: 0,
        pending: 0,
        blocked: 0,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 25,
      totalToolNames: [
        ...Array(15).fill("web_search"),
        ...Array(10).fill("file_read"),
      ],
      totalToolFailures: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };
    mockExecuteGraph.mockResolvedValueOnce(loopyExec);

    // Replan returns new graph, second execution is clean
    mockReplan.mockResolvedValueOnce({
      graph: makeGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-convergence", "Looping task", {
      maxReplans: 1,
    });

    // Should have triggered exactly one replan due to convergence
    expect(mockReplan).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("should not trigger convergence replan when ratio is below threshold", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    // 3 tool calls for 2 goals (ratio 1.5) — well below threshold
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    await orchestrate("task-no-convergence", "Normal task");

    expect(mockReplan).not.toHaveBeenCalled();
  });

  it("should collect trace events", async () => {
    mockPlan.mockResolvedValueOnce({
      graph: makeGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-6", "Traced task");

    expect(result.trace.length).toBeGreaterThan(0);
    const types = result.trace.map((e) => e.type);
    expect(types).toContain("phase_start");
    expect(types).toContain("phase_end");
  });

  it("resumes from snapshot — skips plan phase", async () => {
    const graph = makeGraph();
    // Only g-1 completed in snapshot, g-2 still pending
    graph.updateStatus("g-2", GoalStatus.PENDING);

    const snapshot = {
      taskId: "task-resume",
      goalGraph: graph.toJSON(),
      goalResults: {
        "g-1": {
          goalId: "g-1",
          ok: true,
          result: "done",
          durationMs: 100,
          toolCalls: 1,
          toolNames: ["shell"],
          toolFailures: 0,
          tokenUsage: { promptTokens: 50, completionTokens: 20 },
        },
      },
      executionState: {
        budgetConsumed: 3,
        replanCount: 0,
        tokenUsage: { promptTokens: 200, completionTokens: 100 },
        traceEvents: [],
      },
      taskDescription: "Resume test",
      toolNames: null,
      config: null,
      exitReason: "timeout" as const,
      createdAt: new Date().toISOString(),
    };

    // executeGraph should receive the graph with g-1 COMPLETED, g-2 PENDING
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate(
      "task-resume",
      "Resume test",
      undefined,
      undefined,
      snapshot,
    );

    // plan() should NOT be called (skipped for resume)
    expect(mockPlan).not.toHaveBeenCalled();
    // executeGraph and reflect should still be called
    expect(mockExecuteGraph).toHaveBeenCalledTimes(1);
    expect(mockReflect).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    // Trace should include resumed_from_snapshot event
    const traceTypes = result.trace.map((e) => e.type);
    expect(traceTypes).toContain("resumed_from_snapshot");
  });

  it("does not save snapshot on normal completion", async () => {
    const graph = makeGraph(); // all completed
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 100, completionTokens: 50 },
    });
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-normal", "Normal completion");

    expect(result.success).toBe(true);
    // No snapshot_saved event in trace
    const traceTypes = result.trace.map((e) => e.type);
    expect(traceTypes).not.toContain("snapshot_saved");
  });

  it("saves snapshot when goals remain pending after execution", async () => {
    const graph = new GoalGraph();
    graph.addGoal({
      id: "g-1",
      description: "Goal 1",
      status: GoalStatus.COMPLETED,
    });
    graph.addGoal({
      id: "g-2",
      description: "Goal 2",
      status: GoalStatus.PENDING,
      dependsOn: ["g-1"],
    });

    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    // executeGraph returns without completing g-2 (budget exhausted)
    const partialResult = makeExecResult();
    partialResult.summary = {
      completed: 1,
      failed: 0,
      pending: 1,
      blocked: 0,
      in_progress: 0,
      total: 2,
    };
    delete (partialResult.goalResults as Record<string, unknown>)["g-2"];
    mockExecuteGraph.mockResolvedValueOnce(partialResult);
    mockReflect.mockResolvedValueOnce({
      result: { ...makeReflection(), success: false, score: 0.5 },
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-partial", "Partial task");

    // snapshot_saved should appear in trace (g-2 still pending)
    const traceTypes = result.trace.map((e) => e.type);
    expect(traceTypes).toContain("snapshot_saved");
  });
});
