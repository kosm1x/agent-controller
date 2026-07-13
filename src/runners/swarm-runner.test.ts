/**
 * Tests for swarm runner sibling context injection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock dispatcher before importing swarm-runner (it auto-registers).
// getRunToolCalls added 2026-05-23 (queue #231) for the retry-policy taint check.
vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
  submitTask: vi.fn(),
  getTask: vi.fn(),
  getRunToolCalls: vi.fn(() => []),
}));

// queue #231: swarm-retry-policy reads tool annotations via toolRegistry to
// veto retries with side-effect taint. Default mock: any name → undefined →
// classifier vetoes (returns null only when the toolCalls array is empty).
vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    get: (name: string) => {
      // Tests can override by setting `toolAnnotations.set(name, hints)`.
      const ann = toolAnnotations.get(name);
      if (!ann) return undefined;
      return { name, ...ann };
    },
  },
}));

const toolAnnotations = new Map<
  string,
  {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  }
>();

// queue #231: the swarm-runner records a Prometheus counter on every
// classifier decision. Mock the counter so the assertion targets here are
// the recorded labels, not the prom-client internals.
const recordSwarmSubtaskRetryMock = vi.fn();
vi.mock("../observability/prometheus.js", () => ({
  recordSwarmSubtaskRetry: (input: unknown) =>
    recordSwarmSubtaskRetryMock(input),
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
  maxParallelWidth,
  swarmRunner,
} from "./swarm-runner.js";
import { plan } from "../prometheus/planner.js";
import { reflect } from "../prometheus/reflector.js";
const mockPlan = vi.mocked(plan);
const mockReflect = vi.mocked(reflect);
import { GoalGraph } from "../prometheus/goal-graph.js";
import { GoalStatus } from "../prometheus/types.js";
import {
  getTask,
  submitTask,
  getRunToolCalls,
} from "../dispatch/dispatcher.js";
const mockGetTask = vi.mocked(getTask);
const mockSubmitTask = vi.mocked(submitTask);
const mockGetRunToolCalls = vi.mocked(getRunToolCalls);

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

// ---------------------------------------------------------------------------
// queue #231 — per-sub-task retry policy integration
// Tests the failed-branch wiring of syncSubTaskStatuses. The classifier
// itself is unit-tested in swarm-retry-policy.test.ts; these tests pin
// the swarm-runner-level contract: (a) shadow mode logs the would-decision
// but never respawns, (b) enabled mode respawns and rewires goalTaskMap,
// (c) the side-effect-taint / budget / terminal-class branches are
// surfaced through the recorded counter labels.
// ---------------------------------------------------------------------------

describe("syncSubTaskStatuses — retry-policy integration (queue #231)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    toolAnnotations.clear();
    delete process.env.SWARM_SUBTASK_RETRY_ENABLED;
    recordSwarmSubtaskRetryMock.mockClear();
  });

  function setupFailed(opts: {
    error?: string | null;
    retryCount?: number;
    toolCalls?: string[];
  }): {
    graph: GoalGraph;
    trackers: Map<string, Tracker>;
    goalTaskMap: Map<string, string>;
    goalsById: Map<string, { id: string; description: string }>;
  } {
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
      status: "failed",
      error: opts.error ?? null,
      retry_count: opts.retryCount ?? 0,
    } as any);
    mockGetRunToolCalls.mockReturnValue(opts.toolCalls ?? []);

    // Match the shape buildSubTaskDescription expects (Goal interface):
    // completionCriteria + dependsOn are required fields, default empty.
    const goalsById = new Map([
      [
        "g-1",
        {
          id: "g-1",
          description: "Test goal",
          completionCriteria: [],
          dependsOn: [],
        },
      ],
    ]);
    return { graph, trackers, goalTaskMap, goalsById };
  }

  function retryCtx(goalsById: Map<string, any>) {
    return {
      parentTaskId: "parent-1",
      tools: undefined,
      goalsById,
    };
  }

  it("absent retryContext → preserves legacy behavior (mark goal FAILED, no counter)", () => {
    const { graph, trackers, goalTaskMap } = setupFailed({
      error: "Provider 429",
      retryCount: 0,
    });

    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
    expect(recordSwarmSubtaskRetryMock).not.toHaveBeenCalled();
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("shadow mode (flag off) on a retryable class → counter shadow_skipped + still marks FAILED", () => {
    // Default state. SWARM_SUBTASK_RETRY_ENABLED unset.
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429 rate limit",
      retryCount: 0,
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock).toHaveBeenCalledTimes(1);
    const labels = recordSwarmSubtaskRetryMock.mock.calls[0][0];
    expect(labels.decision).toBe("shadow_skipped");
    expect(labels.reason).toBe("provider_transient");
    // qa-audit W3 fold: recoveryMode is preserved in shadow rows so the
    // operator can see WHAT mode would have fired. Only collapsed to
    // "none" when the classifier itself said skipped_* (terminal class,
    // budget, taint) — not when the env flag suppressed an otherwise-
    // retryable decision.
    expect(labels.recoveryMode).toBe("plain");
    // No respawn fired
    expect(mockSubmitTask).not.toHaveBeenCalled();
    // Goal still marked failed (shadow mode preserves current behavior)
    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("enabled mode + retryable → respawn fires, tracker reset to pending, NO goal FAILED", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 503",
      retryCount: 0,
    });
    mockSubmitTask.mockResolvedValue({
      taskId: "task-2",
      agentType: "fast",
    } as any);

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    // Counter recorded as retried (not shadow_skipped)
    expect(recordSwarmSubtaskRetryMock).toHaveBeenCalledTimes(1);
    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0]).toEqual({
      decision: "retried",
      reason: "provider_transient",
      recoveryMode: "plain",
    });
    // submitTask called with retry_count = 1 (predecessor's + 1)
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.retryCount).toBe(1);
    expect(submission.parentTaskId).toBe("parent-1");
    expect(submission.spawnType).toBe("subtask");
    // Plain re-spawn: description does NOT contain the hallucination addendum
    expect(submission.description).not.toContain("⚠️ IMPORTANT");
    // Tracker reset to pending — NOT marked failed
    expect(trackers.get("g-1")!.status).toBe("pending");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.IN_PROGRESS);
  });

  it("hallucination recovery prepends the sterner addendum to the retry description", async () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "[hallucination guard] LLM narrated tool calls",
      retryCount: 0,
    });
    mockSubmitTask.mockResolvedValue({
      taskId: "task-2",
      agentType: "fast",
    } as any);

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0]).toEqual({
      decision: "retried",
      reason: "hallucination",
      recoveryMode: "hallucination",
    });
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.description).toContain("⚠️ IMPORTANT");
    expect(submission.description).toContain("MUST call the tools");
  });

  it("budget cap (retry_count >= 1) → skipped_budget, no respawn even with flag on", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429",
      retryCount: 1, // already at cap
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0].decision).toBe(
      "skipped_budget",
    );
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("side-effect taint (destructive non-idempotent tool called) → skipped_side_effect, no respawn", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    toolAnnotations.set("gmail_send", {
      destructiveHint: true,
      idempotentHint: false,
      readOnlyHint: false,
    });
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429",
      retryCount: 0,
      toolCalls: ["gmail_send"],
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0].decision).toBe(
      "skipped_side_effect",
    );
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(trackers.get("g-1")!.status).toBe("failed");
  });

  it("terminal class (max_rounds) → skipped_terminal, no respawn", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "max_rounds exceeded after 30 turns",
      retryCount: 0,
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0]).toEqual({
      decision: "skipped_terminal",
      reason: "max_rounds",
      recoveryMode: "none",
    });
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("env flag string MUST be literal 'true' — other values stay in shadow", () => {
    // Defensive: env-var parsing should not loosely accept '1' / 'yes' /
    // 'TRUE' (case-insensitive variants). Same pattern as
    // `heavyRunnerContainerized`. Pin this so a future "be lenient" pass
    // doesn't silently widen the gate.
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "1";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429",
      retryCount: 0,
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0].decision).toBe(
      "shadow_skipped",
    );
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fixes for task 7466 (2026-07-13): chain demotion + honest walls
// ---------------------------------------------------------------------------

describe("maxParallelWidth", () => {
  it("a strict chain has width 1", () => {
    expect(
      maxParallelWidth([
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]),
    ).toBe(1);
  });

  it("independent goals count as parallel width", () => {
    expect(maxParallelWidth([{ id: "a" }, { id: "b" }, { id: "c" }])).toBe(3);
  });

  it("a diamond (fan-out after a root) is wider than 1", () => {
    expect(
      maxParallelWidth([
        { id: "root" },
        { id: "l", dependsOn: ["root"] },
        { id: "r", dependsOn: ["root"] },
        { id: "join", dependsOn: ["l", "r"] },
      ]),
    ).toBe(2);
  });

  it("a single goal is width 1", () => {
    expect(maxParallelWidth([{ id: "only" }])).toBe(1);
  });

  it("does not loop forever on a dependency cycle", () => {
    expect(
      maxParallelWidth([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c" },
      ]),
    ).toBe(1); // c resolves; the a/b cycle breaks the walk defensively
  });
});

describe("swarm chain demotion (task 7466)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function chainGraph(): GoalGraph {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "step 1" });
    g.addGoal({ id: "g-2", description: "step 2", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "step 3", dependsOn: ["g-2"] });
    return g;
  }

  it("delegates a chain plan to ONE heavy sub-task and mirrors its output", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-1",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-1",
      status: "completed",
      output: JSON.stringify({
        content: "the real answer",
        finalAnswer: "the real answer",
      }),
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-1",
      runId: "run-1",
      title: "chat chain",
      description: "do a sequential analysis",
    });

    expect(result.success).toBe(true);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.agentType).toBe("heavy");
    expect(submission.parentTaskId).toBe("parent-1");
    const out = result.output as { content?: string; finalAnswer?: string };
    expect(out.content).toBe("the real answer");
    expect(out.finalAnswer).toBe("the real answer");
  });

  it("reports the demoted child's failure honestly (task id + status)", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-2",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-2",
      status: "failed",
      error: "child exploded",
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-2",
      runId: "run-2",
      title: "chat chain",
      description: "do a sequential analysis",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("demoted-2");
    expect(result.error).toContain("failed");
    expect(result.error).toContain("child exploded");
  });

  it("treats completed_with_concerns as a demoted-child success (audit W1)", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-3",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-3",
      status: "completed_with_concerns",
      output: JSON.stringify({ content: "qualified answer" }),
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-4",
      runId: "run-4",
      title: "chat chain",
      description: "sequential",
    });

    expect(result.success).toBe(true);
    expect((result.output as { content?: string }).content).toBe(
      "qualified answer",
    );
  });

  it("a completed demoted child with NO output is an honest failure, not an empty deliverable (audit W3)", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-4",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-4",
      status: "completed",
      output: null,
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-5",
      runId: "run-5",
      title: "chat chain",
      description: "sequential",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("demoted-4");
    expect(result.error).toContain("no output");
  });

  it("does NOT demote a parallel plan — fan-out proceeds", async () => {
    const g = new GoalGraph();
    g.addGoal({ id: "p-1", description: "item A" });
    g.addGoal({ id: "p-2", description: "item B" });
    mockPlan.mockResolvedValue({
      graph: g,
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    // Make fan-out submissions fail fast so the poll loop terminates quickly
    // (goals go FAILED at submit → allTerminal → break).
    mockSubmitTask.mockRejectedValue(new Error("no capacity"));
    mockReflect.mockResolvedValue({
      result: {
        success: false,
        score: 0,
        learnings: [],
        summary: "nothing ran",
      },
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-3",
      runId: "run-3",
      title: "true fan-out",
      description: "process items A and B independently",
    });

    expect(result.success).toBe(false);
    // Both parallel goals were submitted through the NORMAL fan-out path
    // (no agentType override), not the demotion path.
    expect(mockSubmitTask).toHaveBeenCalledTimes(2);
    for (const call of mockSubmitTask.mock.calls) {
      expect(call[0].agentType).toBeUndefined();
    }
  }, 15_000);
});
