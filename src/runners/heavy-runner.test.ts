/**
 * Heavy runner tests — mock orchestrate() to verify RunnerOutput mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorResult } from "../prometheus/types.js";

vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
}));

vi.mock("../prometheus/orchestrator.js", () => ({
  orchestrate: vi.fn(),
}));

import { heavyRunner } from "./heavy-runner.js";
import { orchestrate } from "../prometheus/orchestrator.js";

const mockOrchestrate = vi.mocked(orchestrate);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeOrchestratorResult(
  overrides: Partial<OrchestratorResult> = {},
): OrchestratorResult {
  return {
    success: true,
    goalGraph: { goals: {} },
    executionResults: {
      goalResults: {},
      summary: { completed: 1, total: 1 },
      totalToolCalls: 2,
      totalToolFailures: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
    },
    reflection: {
      success: true,
      score: 0.9,
      learnings: ["Learned something"],
      summary: "Task completed",
    },
    trace: [{ type: "phase_start", timestamp: Date.now() }],
    traceId: "trace-1",
    durationMs: 5000,
    tokenUsage: {
      promptTokens: 1000,
      completionTokens: 500,
    },
    iterationsUsed: 5,
    ...overrides,
  };
}

describe("heavyRunner", () => {
  it("should have type heavy", () => {
    expect(heavyRunner.type).toBe("heavy");
  });

  it("should return success from orchestrate result", async () => {
    mockOrchestrate.mockResolvedValueOnce(makeOrchestratorResult());

    const result = await heavyRunner.execute({
      taskId: "task-1",
      runId: "run-1",
      title: "Test",
      description: "Test description",
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      content: "Task completed",
      score: 0.9,
      learnings: ["Learned something"],
    });
    expect(result.tokenUsage).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(result.goalGraph).toBeDefined();
    expect(result.trace).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should return failure from orchestrate result", async () => {
    mockOrchestrate.mockResolvedValueOnce(
      makeOrchestratorResult({
        success: false,
        reflection: {
          success: false,
          score: 0.3,
          learnings: ["Failed"],
          summary: "Task failed",
        },
      }),
    );

    const result = await heavyRunner.execute({
      taskId: "task-2",
      runId: "run-2",
      title: "Failing",
      description: "Will fail",
    });

    expect(result.success).toBe(false);
    expect((result.output as { content: string }).content).toBe("Task failed");
  });

  it("should catch thrown errors and return failure", async () => {
    mockOrchestrate.mockRejectedValueOnce(new Error("Orchestration crashed"));

    const result = await heavyRunner.execute({
      taskId: "task-3",
      runId: "run-3",
      title: "Crash",
      description: "Will crash",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Orchestration crashed");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should pass tools to orchestrate", async () => {
    mockOrchestrate.mockResolvedValueOnce(makeOrchestratorResult());

    await heavyRunner.execute({
      taskId: "task-4",
      runId: "run-4",
      title: "With tools",
      description: "Needs shell",
      tools: ["shell", "file"],
    });

    expect(mockOrchestrate).toHaveBeenCalledWith(
      "task-4",
      "With tools\n\nNeeds shell",
      undefined,
      ["shell", "file"],
    );
  });
});
