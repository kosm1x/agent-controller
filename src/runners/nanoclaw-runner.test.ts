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
  // Default to TRUE so existing tests continue to exercise the spawn path.
  // Individual pre-flight tests override with mockReturnValueOnce(false).
  imageExistsLocally: vi.fn(() => true),
  OUTPUT_START_MARKER: "---NANOCLAW_OUTPUT_START---",
  OUTPUT_END_MARKER: "---NANOCLAW_OUTPUT_END---",
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: vi.fn(() => ({
    emitEvent: vi.fn(),
  })),
}));

vi.mock("../observability/prometheus.js", () => ({
  recordNanoclawImageMissing: vi.fn(),
}));

import { nanoclawRunner } from "./nanoclaw-runner.js";
import { getConfig } from "../config.js";
import {
  spawnContainer,
  killContainer,
  imageExistsLocally,
} from "./container.js";
import { recordNanoclawImageMissing } from "../observability/prometheus.js";

const mockGetConfig = vi.mocked(getConfig);
const mockSpawnContainer = vi.mocked(spawnContainer);
const mockKillContainer = vi.mocked(killContainer);
const mockImageExistsLocally = vi.mocked(imageExistsLocally);
const mockRecordNanoclawImageMissing = vi.mocked(recordNanoclawImageMissing);

function makeConfig() {
  return {
    apiKey: "test-key",
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://localhost:4000",
    inferencePrimaryKey: "sk-test",
    inferencePrimaryModel: "qwen-test",
    heavyRunnerImage: "mission-control:latest",
    nanoclawTimeoutMs: 900_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(makeConfig() as ReturnType<typeof getConfig>);
  // Default: pre-flight passes (image exists). Override in specific tests.
  mockImageExistsLocally.mockReturnValue(true);
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
          INFERENCE_PRIMARY_PROVIDER: "openai",
          MC_API_KEY: "test-key",
          MC_DB_PATH: "/tmp/mc.db",
        }),
        volumes: [
          "/root/claude/mission-control:/root/claude/mission-control:ro",
          "/root/.config/gh:/root/.config/gh:ro",
        ],
      }),
    );

    // Under openai provider, HOME env + credentials mount must NOT be added.
    const openaiCall = mockSpawnContainer.mock.calls[0][0];
    expect(openaiCall.envVars).not.toHaveProperty("HOME");
    expect(openaiCall.volumes).not.toContain(
      "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
    );
  });

  it("mounts credentials + HOME + provider env when provider is claude-sdk", async () => {
    mockGetConfig.mockReturnValue({
      ...makeConfig(),
      inferencePrimaryProvider: "claude-sdk",
    } as ReturnType<typeof getConfig>);

    const containerOutput: ContainerOutput = {
      status: "success",
      result: JSON.stringify({ success: true, content: "Fixed" }),
    };

    mockSpawnContainer.mockReturnValue({
      name: "mc-nanoclaw-test-123",
      process: {} as ContainerHandle["process"],
      result: Promise.resolve(containerOutput),
      kill: vi.fn(),
    });

    await nanoclawRunner.execute({
      taskId: "task-sdk",
      runId: "run-sdk",
      title: "Test",
      description: "Desc",
      tools: [],
    });

    expect(mockSpawnContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          INFERENCE_PRIMARY_PROVIDER: "claude-sdk",
          HOME: "/root",
        }),
        volumes: expect.arrayContaining([
          "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
          "/root/claude/mission-control:/root/claude/mission-control:ro",
          "/root/.config/gh:/root/.config/gh:ro",
        ]),
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

  // -----------------------------------------------------------------------
  // Pre-flight image check (2026-05-23 — fix for recurring image-pruned blocker)
  // -----------------------------------------------------------------------

  describe("pre-flight image check", () => {
    it("returns clear error + records metric when image missing, never spawns", async () => {
      mockImageExistsLocally.mockReturnValueOnce(false);

      const result = await nanoclawRunner.execute({
        taskId: "task-missing-image",
        runId: "run-missing-image",
        title: "Skill evolution — 2026-05-23",
        description: "Routine auto-improvement task",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Docker image 'mission-control:latest' not found locally",
      );
      // Rebuild instruction must be in the error for operator clarity.
      expect(result.error).toContain("scripts/build-mc-image.sh");
      expect(mockRecordNanoclawImageMissing).toHaveBeenCalledTimes(1);
      // Critical: must NOT have attempted container spawn.
      expect(mockSpawnContainer).not.toHaveBeenCalled();
      // durationMs is computed and non-negative even on early return.
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("proceeds to container spawn when pre-flight passes", async () => {
      mockImageExistsLocally.mockReturnValueOnce(true);

      const containerOutput: ContainerOutput = {
        status: "success",
        result: JSON.stringify({ success: true, content: "ok" }),
      };
      mockSpawnContainer.mockReturnValue({
        name: "mc-nanoclaw-test-123",
        process: {} as ContainerHandle["process"],
        result: Promise.resolve(containerOutput),
        kill: vi.fn(),
      });

      await nanoclawRunner.execute({
        taskId: "task-image-present",
        runId: "run-image-present",
        title: "Happy path",
        description: "Image present, should spawn",
      });

      expect(mockImageExistsLocally).toHaveBeenCalledWith(
        "mission-control:latest",
      );
      expect(mockSpawnContainer).toHaveBeenCalledTimes(1);
      expect(mockRecordNanoclawImageMissing).not.toHaveBeenCalled();
    });
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
