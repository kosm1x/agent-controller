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

  it("should trigger replan when tool failure rate exceeds threshold for 2 consecutive passes (k=2)", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // High failure rate execution with work remaining (blocked=1) so the
    // k=2 stability rule defers rather than exiting immediately.
    const highFailExec: ExecutionResult = {
      goalResults: {
        "g-1": {
          goalId: "g-1",
          ok: true,
          result: "done",
          durationMs: 100,
          toolCalls: 5,
          toolNames: Array(5).fill("web_search"),
          toolFailures: 4,
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        },
      },
      summary: {
        completed: 1,
        failed: 0,
        pending: 0,
        blocked: 1,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 5,
      totalToolNames: Array(5).fill("web_search"),
      totalToolFailures: 4,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };
    // Pass 1 (soft vote, deferred), Pass 2 (soft vote, replan fires)
    mockExecuteGraph.mockResolvedValueOnce(highFailExec);
    mockExecuteGraph.mockResolvedValueOnce(highFailExec);

    const replanGraph = makeGraph();
    mockReplan.mockResolvedValueOnce({
      graph: replanGraph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // Pass 3 (post-replan): clean
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-4", "Replanning task");

    expect(mockReplan).toHaveBeenCalledTimes(1);
    // 3+ executions: the k=2 rule added at least one extra pass before the
    // replan fired. Exact count depends on cumulative trace behavior
    // across the replan boundary (trace failures persist, so the post-
    // replan pass may also vote soft).
    expect(mockExecuteGraph.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.success).toBe(true);
    // Verify the k=2 defer fired at least once
    const deferEvents = result.trace.filter(
      (e) => e.type === "replan_deferred",
    );
    expect(deferEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("should NOT replan on a single-pass soft vote when no work remains", async () => {
    // k=2 + no remaining work => the deferred vote is dropped and
    // execution exits cleanly. This is the key anti-thrash behavior:
    // transient metric blips on a finishing task don't trigger replans.
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const blipExec: ExecutionResult = {
      goalResults: {},
      summary: {
        completed: 2,
        failed: 0,
        pending: 0,
        blocked: 0,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 4,
      totalToolNames: ["x", "x", "x", "x"],
      totalToolFailures: 3, // 75% failure rate — would trigger replan
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };
    mockExecuteGraph.mockResolvedValueOnce(blipExec);
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-k2-nowork", "Finished task");

    expect(mockReplan).not.toHaveBeenCalled();
    expect(mockExecuteGraph).toHaveBeenCalledTimes(1);
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

  it("should trigger replan when tool-call-per-goal ratio exceeds threshold for 2 consecutive passes (k=2)", async () => {
    const graph = makeGraph();
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // Execution with 21 calls for 2 goals per pass → ratio 10.5 > 10.0
    // threshold on pass 1 (soft vote, deferred), and 21.0 cumulative on
    // pass 2 (soft vote, triggers replan). Work remains (pending=1).
    const loopyExec: ExecutionResult = {
      goalResults: {
        "g-1": {
          goalId: "g-1",
          ok: true,
          result: "done",
          durationMs: 5000,
          toolCalls: 21,
          toolNames: Array(21).fill("web_search"),
          toolFailures: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
        },
      },
      summary: {
        completed: 1,
        failed: 0,
        pending: 1,
        blocked: 0,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 21,
      totalToolNames: Array(21).fill("web_search"),
      totalToolFailures: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };
    mockExecuteGraph.mockResolvedValueOnce(loopyExec);
    mockExecuteGraph.mockResolvedValueOnce(loopyExec);

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

  it("should replan immediately on hard-stop signal (blocked goals, no k=2 defer)", async () => {
    // Hard votes (all goals blocked with no ready alternatives) are NOT
    // gated by k=2 because another execution pass has nothing to run.
    // getBlocked() only flags goals with failed dependencies, so construct
    // a parent→child graph where parent failed.
    const graph = new GoalGraph();
    graph.addGoal({
      id: "parent",
      description: "Parent",
      status: GoalStatus.FAILED,
    });
    graph.addGoal({
      id: "child",
      description: "Child",
      status: GoalStatus.PENDING,
      dependsOn: ["parent"],
    });
    mockPlan.mockResolvedValueOnce({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const deadlockExec: ExecutionResult = {
      goalResults: {},
      summary: {
        completed: 0,
        failed: 0,
        pending: 0,
        blocked: 2,
        in_progress: 0,
        total: 2,
      },
      totalToolCalls: 0,
      totalToolNames: [],
      totalToolFailures: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      toolRepairs: [],
    };
    mockExecuteGraph.mockResolvedValueOnce(deadlockExec);

    mockReplan.mockResolvedValueOnce({
      graph: makeGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    mockExecuteGraph.mockResolvedValueOnce(makeExecResult());
    mockReflect.mockResolvedValueOnce({
      result: makeReflection(),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const result = await orchestrate("task-hard-stop", "Deadlocked task");

    // Replan fires on the FIRST pass because the vote is hard severity.
    expect(mockReplan).toHaveBeenCalledTimes(1);
    expect(mockExecuteGraph).toHaveBeenCalledTimes(2); // no k=2 defer
    const replanEvents = result.trace.filter((e) => e.type === "replan");
    expect(replanEvents.length).toBe(1);
    expect(replanEvents[0]).toMatchObject({ severity: "hard" });
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
