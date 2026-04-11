/**
 * NanoClaw runner tests — mock container infra to verify
 * command, envVars, volumes, tools forwarding, and structured output parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContainerOutput, ContainerHandle } from "./container.js";

vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
}));

vi.mock("./container.js", () => ({
  spawnContainer: vi.fn(),
  killContainer: vi.fn(),
  generateContainerName: vi.fn(() => "mc-nanoclaw-test-123"),
  OUTPUT_START_MARKER: "---NANOCLAW_OUTPUT_START---",
  OUTPUT_END_MARKER: "---NANOCLAW_OUTPUT_END---",
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: vi.fn(() => ({
    emitEvent: vi.fn(),
  })),
}));

import { nanoclawRunner } from "./nanoclaw-runner.js";
import { getConfig } from "../config.js";
import { spawnContainer, killContainer } from "./container.js";

const mockGetConfig = vi.mocked(getConfig);
const mockSpawnContainer = vi.mocked(spawnContainer);
const mockKillContainer = vi.mocked(killContainer);

function makeConfig() {
  return {
    apiKey: "test-key",
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://localhost:4000",
    inferencePrimaryKey: "sk-test",
    inferencePrimaryModel: "qwen-test",
    heavyRunnerImage: "mission-control:latest",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(makeConfig() as ReturnType<typeof getConfig>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nanoclawRunner", () => {
  it("has type nanoclaw", () => {
    expect(nanoclawRunner.type).toBe("nanoclaw");
  });

  it("spawns container with correct image, command, envVars, and volumes", async () => {
    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({
        success: true,
        content: "Fixed the bug",
        score: 0.9,
        toolCalls: ["code_search", "jarvis_dev"],
      }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-123",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    await nanoclawRunner.execute({
      taskId: "task-1",
      runId: "run-1",
      title: "Fix scope bug",
      description: "Fix the scope-miss pattern",
      tools: ["jarvis_dev", "code_search"],
    });

    expect(mockSpawnContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "mission-control:latest",
        command: ["node", "dist/runners/nanoclaw-worker.js"],
        envVars: expect.objectContaining({
          INFERENCE_PRIMARY_URL: "http://localhost:4000",
          INFERENCE_PRIMARY_KEY: "sk-test",
          INFERENCE_PRIMARY_MODEL: "qwen-test",
          MC_API_KEY: "test-key",
          MC_DB_PATH: "/tmp/mc.db",
        }),
        volumes: [
          "/root/claude/mission-control:/root/claude/mission-control:rw",
          "/root/.config/gh:/root/.config/gh:ro",
        ],
      }),
    );
  });

  it("forwards tools in container input", async () => {
    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({ success: true, content: "Done" }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-123",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    await nanoclawRunner.execute({
      taskId: "task-2",
      runId: "run-2",
      title: "Test",
      description: "Desc",
      tools: ["jarvis_dev", "code_search", "file_edit"],
    });

    const callArgs = mockSpawnContainer.mock.calls[0][0];
    const input = callArgs.input as { tools?: string[] };
    expect(input.tools).toEqual(["jarvis_dev", "code_search", "file_edit"]);
  });

  it("extracts toolCalls from structured output", async () => {
    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({
        success: true,
        content: "PR created",
        score: 0.95,
        learnings: ["Scope patterns need anchoring"],
        toolCalls: ["code_search", "file_edit", "jarvis_dev"],
        tokenUsage: { promptTokens: 500, completionTokens: 200 },
      }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-123",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    const result = await nanoclawRunner.execute({
      taskId: "task-3",
      runId: "run-3",
      title: "Auto-fix",
      description: "Fix scope-miss",
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toEqual([
      "code_search",
      "file_edit",
      "jarvis_dev",
    ]);
    expect(result.output).toEqual({
      content: "PR created",
      score: 0.95,
      learnings: ["Scope patterns need anchoring"],
    });
    expect(result.tokenUsage).toEqual({
      promptTokens: 500,
      completionTokens: 200,
    });
  });

  it("returns error on container failure", async () => {
    const containerOutput: ContainerOutput = {
      status: "error",
      result: null,
      error: "Container OOMKilled",
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-456",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    const result = await nanoclawRunner.execute({
      taskId: "task-4",
      runId: "run-4",
      title: "OOM",
      description: "Will OOM",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Container OOMKilled");
  });

  it("returns error when container output has error field", async () => {
    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({
        error: "Orchestration crashed",
        durationMs: 1000,
      }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-789",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    const result = await nanoclawRunner.execute({
      taskId: "task-5",
      runId: "run-5",
      title: "Crash",
      description: "Will crash",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Orchestration crashed");
  });

  it("kills container on unexpected exception", async () => {
    const killFn = vi.fn();
    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-err",
      process: {} as ContainerHandle["process"],
      result: Promise.reject(new Error("Docker daemon down")),
      kill: killFn,
    });

    const result = await nanoclawRunner.execute({
      taskId: "task-6",
      runId: "run-6",
      title: "Docker down",
      description: "Daemon dead",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Docker daemon down");
    expect(mockKillContainer).toHaveBeenCalled();
  });
});
