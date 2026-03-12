/**
 * A2A runner tests — mock client to verify delegation flow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
}));

const mockSendMessage = vi.fn();
const mockGetTask = vi.fn();
const mockCardFetch = vi.fn();

vi.mock("../a2a/client.js", () => ({
  agentCardCache: {
    fetch: (...args: unknown[]) => mockCardFetch(...args),
  },
  A2ARpcClient: vi.fn().mockImplementation(() => ({
    sendMessage: mockSendMessage,
    getTask: mockGetTask,
  })),
  AgentCardCache: vi.fn(),
}));

import { a2aRunner } from "./a2a-runner.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a2aRunner", () => {
  it("should have type a2a", () => {
    expect(a2aRunner.type).toBe("a2a");
  });

  it("should return error when a2a_target is missing", async () => {
    const result = await a2aRunner.execute({
      taskId: "t1",
      runId: "r1",
      title: "Test",
      description: "Test",
      input: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("a2a_target");
  });

  it("should return error when input is empty object", async () => {
    const result = await a2aRunner.execute({
      taskId: "t1",
      runId: "r1",
      title: "Test",
      description: "Test",
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("a2a_target");
  });

  it("should delegate and return result on completion", async () => {
    mockCardFetch.mockResolvedValueOnce({
      name: "Remote Agent",
      url: "http://remote:8080",
    });

    mockSendMessage.mockResolvedValueOnce({
      id: "remote-task-1",
      status: { state: "submitted" },
    });

    mockGetTask.mockResolvedValueOnce({
      id: "remote-task-1",
      status: { state: "completed" },
      artifacts: [
        {
          id: "a1",
          parts: [{ type: "text", text: "Result from remote" }],
        },
      ],
    });

    const result = await a2aRunner.execute({
      taskId: "t1",
      runId: "r1",
      title: "Delegate this",
      description: "To remote agent",
      input: { a2a_target: "http://remote:8080" },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Result from remote");
    expect(mockCardFetch).toHaveBeenCalledWith("http://remote:8080");
  });

  it("should return error when remote task fails", async () => {
    mockCardFetch.mockResolvedValueOnce({
      name: "Remote Agent",
      url: "http://remote:8080",
    });

    mockSendMessage.mockResolvedValueOnce({
      id: "remote-task-2",
      status: { state: "submitted" },
    });

    mockGetTask.mockResolvedValueOnce({
      id: "remote-task-2",
      status: { state: "failed", message: "Remote error" },
    });

    const result = await a2aRunner.execute({
      taskId: "t2",
      runId: "r2",
      title: "Will fail",
      description: "Remote fails",
      input: { a2a_target: "http://remote:8080" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Remote error");
  });

  it("should handle card fetch failure", async () => {
    mockCardFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await a2aRunner.execute({
      taskId: "t3",
      runId: "r3",
      title: "No agent",
      description: "Agent is down",
      input: { a2a_target: "http://dead:8080" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection refused");
  });

  it("should pass through api key when provided", async () => {
    mockCardFetch.mockResolvedValueOnce({
      name: "Secure Agent",
      url: "http://secure:8080",
    });

    mockSendMessage.mockResolvedValueOnce({
      id: "remote-task-3",
      status: { state: "completed" },
      artifacts: [
        { id: "a1", parts: [{ type: "text", text: "secure result" }] },
      ],
    });

    mockGetTask.mockResolvedValueOnce({
      id: "remote-task-3",
      status: { state: "completed" },
      artifacts: [
        { id: "a1", parts: [{ type: "text", text: "secure result" }] },
      ],
    });

    const result = await a2aRunner.execute({
      taskId: "t4",
      runId: "r4",
      title: "Secure task",
      description: "With key",
      input: {
        a2a_target: "http://secure:8080",
        a2a_key: "secret-key",
      },
    });

    expect(result.success).toBe(true);
  });
});
