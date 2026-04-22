/**
 * Heavy runner tests — mock orchestrate() and container infra to verify
 * both in-process and containerized execution paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrchestratorResult } from "../prometheus/types.js";
import type { ContainerOutput, ContainerHandle } from "./container.js";

vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
}));

vi.mock("../prometheus/orchestrator.js", () => ({
  orchestrate: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
}));

vi.mock("./container.js", () => ({
  spawnContainer: vi.fn(),
  killContainer: vi.fn(),
  generateContainerName: vi.fn(() => "mc-heavy-test-123"),
  OUTPUT_START_MARKER: "---NANOCLAW_OUTPUT_START---",
  OUTPUT_END_MARKER: "---NANOCLAW_OUTPUT_END---",
}));

import { heavyRunner } from "./heavy-runner.js";
import { orchestrate } from "../prometheus/orchestrator.js";
import { getConfig } from "../config.js";
import { spawnContainer, killContainer } from "./container.js";

const mockOrchestrate = vi.mocked(orchestrate);
const mockGetConfig = vi.mocked(getConfig);
const mockSpawnContainer = vi.mocked(spawnContainer);
const mockKillContainer = vi.mocked(killContainer);

function makeConfig(containerized = false) {
  return {
    apiKey: "test-key",
    port: 8080,
    dbPath: "./data/mc.db",
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://localhost:4000",
    inferencePrimaryKey: "sk-test",
    inferencePrimaryModel: "gpt-4",
    inferenceFallbackUrl: undefined,
    inferenceFallbackKey: undefined,
    inferenceFallbackModel: undefined,
    inferenceTimeoutMs: 30000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 3,
    orchestratorTimeoutMs: 600_000,
    orchestratorMaxIterations: 90,
    goalTimeoutMs: 120_000,
    inferenceContextLimit: 128_000,
    compressionThreshold: 0.85,
    nanoclawImage: "nanoclaw-agent:latest",
    maxConcurrentContainers: 5,
    heavyRunnerContainerized: containerized,
    heavyRunnerImage: "mission-control:latest",
    heavyRunnerTimeoutMs: 900_000,
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(makeConfig(false));
});

describe("heavyRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
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
      undefined,
    );
  });

  it("should NOT call spawnContainer when not containerized", async () => {
    mockOrchestrate.mockResolvedValueOnce(makeOrchestratorResult());

    await heavyRunner.execute({
      taskId: "task-5",
      runId: "run-5",
      title: "In-process",
      description: "Default mode",
    });

    expect(mockSpawnContainer).not.toHaveBeenCalled();
    expect(mockOrchestrate).toHaveBeenCalled();
  });
});

describe("heavyRunner container mode", () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(makeConfig(true));
  });

  it("should call spawnContainer when containerized", async () => {
    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({
        success: true,
        content: "Container result",
        score: 0.85,
        learnings: ["Containerized learning"],
        tokenUsage: { promptTokens: 200, completionTokens: 100 },
        goalGraph: { goals: {} },
        trace: [],
        durationMs: 3000,
      }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-heavy-test-123",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    const result = await heavyRunner.execute({
      taskId: "task-c1",
      runId: "run-c1",
      title: "Container task",
      description: "Run in container",
    });

    expect(mockSpawnContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "mission-control:latest",
        command: ["node", "dist/runners/heavy-worker.js"],
        envVars: expect.objectContaining({
          INFERENCE_PRIMARY_URL: "http://localhost:4000",
          INFERENCE_PRIMARY_KEY: "sk-test",
          INFERENCE_PRIMARY_MODEL: "gpt-4",
          INFERENCE_PRIMARY_PROVIDER: "openai",
          MC_API_KEY: "test-key",
          MC_DB_PATH: "/tmp/mc.db",
        }),
        timeoutMs: 900_000,
      }),
    );
    // Under openai provider, HOME env + credentials mount must NOT be added.
    const openaiCall = mockSpawnContainer.mock.calls[0][0];
    expect(openaiCall.envVars).not.toHaveProperty("HOME");
    expect(openaiCall.volumes ?? []).not.toContain(
      "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
    );
    expect(mockOrchestrate).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      content: "Container result",
      score: 0.85,
      learnings: ["Containerized learning"],
    });
    expect(result.tokenUsage).toEqual({
      promptTokens: 200,
      completionTokens: 100,
    });
  });

  it("should mount credentials + HOME + provider env when provider is claude-sdk", async () => {
    mockGetConfig.mockReturnValue({
      ...makeConfig(true),
      inferencePrimaryProvider: "claude-sdk",
    } as ReturnType<typeof getConfig>);

    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({
        success: true,
        content: "ok",
        score: 0.9,
        learnings: [],
        tokenUsage: { promptTokens: 10, completionTokens: 5 },
        goalGraph: { goals: {} },
        trace: [],
        durationMs: 100,
      }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-heavy-sdk",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    await heavyRunner.execute({
      taskId: "task-sdk",
      runId: "run-sdk",
      title: "Container under SDK",
      description: "Should mount credentials",
    });

    expect(mockSpawnContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          INFERENCE_PRIMARY_PROVIDER: "claude-sdk",
          HOME: "/root",
        }),
        volumes: [
          "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
        ],
      }),
    );
  });

  it("should return error on container failure", async () => {
    const containerOutput: ContainerOutput = {
      status: "error",
      result: null,
      error: "Container OOMKilled",
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-heavy-test-456",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    const result = await heavyRunner.execute({
      taskId: "task-c2",
      runId: "run-c2",
      title: "OOM task",
      description: "Will OOM",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Container OOMKilled");
  });

  it("should kill container on exception and return failure", async () => {
    const killFn = vi.fn();
    mockSpawnContainer.mockReturnValue({
      name: "mc-heavy-test-789",
      process: {} as ContainerHandle["process"],
      result: Promise.reject(new Error("Docker daemon unreachable")),
      kill: killFn,
    });

    const result = await heavyRunner.execute({
      taskId: "task-c3",
      runId: "run-c3",
      title: "Docker down",
      description: "Daemon dead",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Docker daemon unreachable");
    expect(mockKillContainer).toHaveBeenCalled();
  });
});
