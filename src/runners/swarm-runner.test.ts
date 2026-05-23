/**
 * Tests for swarm runner sibling context injection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock dispatcher before importing swarm-runner (it auto-registers)
vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
  submitTask: vi.fn(),
  getTask: vi.fn(),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    emitEvent: vi.fn(),
  }),
}));

vi.mock("../prometheus/planner.js", () => ({
  plan: vi.fn(),
}));

vi.mock("../prometheus/reflector.js", () => ({
  reflect: vi.fn(),
}));

import {
  buildSubTaskDescription,
  syncSubTaskStatuses,
} from "./swarm-runner.js";
import { GoalGraph } from "../prometheus/goal-graph.js";
import { GoalStatus } from "../prometheus/types.js";
import { getTask } from "../dispatch/dispatcher.js";
const mockGetTask = vi.mocked(getTask);

interface Tracker {
  goalId: string;
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
}

function makeGraph(): GoalGraph {
  const graph = new GoalGraph();
  graph.addGoal({ id: "g-1", description: "Setup database" });
  graph.addGoal({ id: "g-2", description: "Build API layer" });
  graph.addGoal({
    id: "g-3",
    description: "Write frontend",
    dependsOn: ["g-1"],
  });
  return graph;
}

describe("buildSubTaskDescription — sibling context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("includes sibling goals with their status", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      ["g-2", { goalId: "g-2", taskId: "t-2", status: "running" }],
    ]);

    const goal = graph.getGoal("g-1");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Sibling goals");
    expect(desc).toContain("Build API layer [running]");
    // g-3 depends on g-1, so it's a dependency, not a sibling here
    // But g-3's parentId is null (same as g-1), and g-1 is in g-3's dependsOn
    // When building desc for g-1, g-3 depends on g-1, but from g-1's perspective
    // g-3 is not in g-1.dependsOn. So g-3 IS a sibling of g-1
    expect(desc).toContain("Write frontend [pending]");
  });

  it("includes completed sibling output (truncated)", () => {
    const graph = makeGraph();
    const longOutput = "A".repeat(300);
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: longOutput,
        },
      ],
    ]);

    const goal = graph.getGoal("g-1");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Result: ");
    // Output should be truncated to 200 chars
    expect(desc).not.toContain("A".repeat(300));
    expect(desc).toContain("A".repeat(200));
  });

  it("does not duplicate dependency goals in sibling section", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>();

    // g-3 depends on g-1. When building desc for g-3, g-1 should NOT appear
    // in siblings because it's already in dependsOn
    graph.updateStatus("g-1", GoalStatus.COMPLETED);
    const goal = graph.getGoal("g-3");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    // g-1 should appear in dependencies section, not siblings
    expect(desc).toContain("Context from completed dependencies");
    expect(desc).toContain("Setup database (completed)");

    // g-2 is a sibling (same parentId, not a dependency of g-3)
    if (desc.includes("Sibling goals")) {
      expect(desc).toContain("Build API layer");
      // g-1 should NOT be in the sibling section
      const siblingSection = desc.split("Sibling goals")[1];
      expect(siblingSection).not.toContain("Setup database");
    }
  });

  it("omits sibling section when no siblings exist", () => {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-only", description: "Only goal" });
    const trackers = new Map<string, Tracker>();

    const goal = graph.getGoal("g-only");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).not.toContain("Sibling goals");
  });

  it("handles empty tracker output without crashing", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: undefined,
        },
      ],
    ]);

    const goal = graph.getGoal("g-1");
    // Should not throw
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Build API layer [completed]");
    expect(desc).not.toContain("Result:");
  });
});

describe("syncSubTaskStatuses — Hermes v0.13 zombie/terminal-status audit", () => {
  // Each test seeds the graph + one tracker, mocks getTask to return a
  // specific task.status, calls sync, and asserts the tracker and graph
  // both transitioned (or stayed put) correctly. The 3 new mappings are
  // the focus: completed_with_concerns, needs_context, blocked.

  afterEach(() => {
    vi.clearAllMocks();
  });

  function setup(taskStatus: string, taskOutput?: string, taskError?: string) {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "Test goal" });
    graph.updateStatus("g-1", GoalStatus.IN_PROGRESS);

    const trackers = new Map<string, Tracker>();
    trackers.set("g-1", {
      goalId: "g-1",
      taskId: "task-1",
      status: "running",
    });

    const goalTaskMap = new Map<string, string>();
    goalTaskMap.set("g-1", "task-1");

    mockGetTask.mockReturnValue({
      task_id: "task-1",
      status: taskStatus,
      output: taskOutput,
      error: taskError,
    } as any);

    return { graph, trackers, goalTaskMap };
  }

  it("maps task `completed` → tracker.completed + graph.COMPLETED (baseline)", () => {
    const { graph, trackers, goalTaskMap } = setup("completed", "all done");
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("completed");
    expect(trackers.get("g-1")!.output).toBe("all done");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.COMPLETED);
  });

  it("maps task `completed_with_concerns` → tracker.completed + preserves output (audit fix)", () => {
    // Pre-fix bug: this status was ignored. Tracker stayed non-terminal,
    // swarm waited up to 10 min, then `buildExecutionResults` marked the
    // successful sub-task as `ok: false`. Double penalty.
    const { graph, trackers, goalTaskMap } = setup(
      "completed_with_concerns",
      "partial result with note",
    );
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("completed");
    expect(trackers.get("g-1")!.output).toBe("partial result with note");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.COMPLETED);
  });

  it("maps task `needs_context` → tracker.failed (won't auto-resume)", () => {
    const { graph, trackers, goalTaskMap } = setup(
      "needs_context",
      undefined,
      "needs the user",
    );
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(trackers.get("g-1")!.error).toBe("needs the user");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("maps task `blocked` → tracker.failed (task-level block ≠ goal-graph BLOCKED)", () => {
    const { graph, trackers, goalTaskMap } = setup(
      "blocked",
      undefined,
      "external dep down",
    );
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(trackers.get("g-1")!.error).toBe("external dep down");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("falls back to a sensible error message when task.error is null", () => {
    // Defensive: the dispatcher SHOULD set task.error on needs_context /
    // blocked, but if it ever doesn't, we synthesize a placeholder so the
    // reflector and downstream callers always see a non-empty error.
    const { graph, trackers, goalTaskMap } = setup("needs_context", undefined);
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.error).toMatch(/needs additional user context/);
  });

  it("leaves pre-running statuses unchanged (pending/classifying/queued) — realistic first-poll scenario", () => {
    // Realistic first-poll after submit: tracker is "pending" (line 384
    // of swarm-runner.ts) and the task is still routing — pending, then
    // classifying, then queued. None of these are terminal; the function
    // must leave the tracker alone so `countActive` correctly keeps it
    // counted as active and the swarm waits for the eventual "running".
    // Audit W2/R2 — previous version of this test seeded tracker as
    // "running" which never observes the realistic seed state.
    for (const status of ["pending", "classifying", "queued"]) {
      const { graph, trackers, goalTaskMap } = setup(status);
      // Pre-set tracker to the realistic post-submit seed
      trackers.get("g-1")!.status = "pending";
      syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);
      expect(trackers.get("g-1")!.status).toBe("pending");
      expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.IN_PROGRESS);
    }
  });

  it("advances tracker from pending → running on the first `running` task observation", () => {
    // The transition the prior test couldn't cover: tracker starts
    // "pending" (post-submit), task becomes "running", sync flips tracker
    // to "running". Pins the existing `else if (task.status === "running")`
    // branch.
    const { graph, trackers, goalTaskMap } = setup("running");
    trackers.get("g-1")!.status = "pending";
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);
    expect(trackers.get("g-1")!.status).toBe("running");
  });

  it("does not re-process already-terminal trackers (idempotent)", () => {
    const { graph, trackers, goalTaskMap } = setup("completed", "x");
    // Pre-set tracker to a terminal state — function should skip even if
    // the DB row says otherwise.
    trackers.get("g-1")!.status = "completed";
    trackers.get("g-1")!.output = "PRIOR-VALUE";
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    // Prior tracker output preserved; the function should not re-read or
    // overwrite a terminal entry. (getTask might not even get called, but
    // we don't assert that — only that the tracker is untouched.)
    expect(trackers.get("g-1")!.output).toBe("PRIOR-VALUE");
  });
});
