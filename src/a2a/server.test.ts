/**
 * A2A server (JSON-RPC) tests.
 */

import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";

// Mock database
vi.mock("../db/index.js", () => {
  const mockDb = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  };
  return {
    getDatabase: vi.fn(() => mockDb),
  };
});

// Mock dispatcher
vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: vi.fn(),
  getTaskWithRuns: vi.fn(),
  cancelTask: vi.fn(),
  registerRunner: vi.fn(),
}));

// Mock event bus
vi.mock("../lib/event-bus.js", () => ({
  getEventBus: vi.fn(() => ({
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    emitEvent: vi.fn(),
  })),
}));

import { a2a } from "./server.js";
import {
  submitTask,
  getTaskWithRuns,
  cancelTask,
} from "../dispatch/dispatcher.js";

const mockSubmitTask = vi.mocked(submitTask);
const mockGetTaskWithRuns = vi.mocked(getTaskWithRuns);
const mockCancelTask = vi.mocked(cancelTask);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeJsonRpc(
  method: string,
  params?: unknown,
  id: number | string = 1,
) {
  return {
    jsonrpc: "2.0",
    method,
    params,
    id,
  };
}

async function post(body: unknown): Promise<Response> {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return a2a.fetch(req);
}

function makeTaskRow(overrides = {}) {
  return {
    id: 1,
    task_id: "task-abc",
    parent_task_id: null,
    spawn_type: "root",
    title: "Test",
    description: "Test desc",
    priority: "medium",
    status: "queued",
    agent_type: "fast",
    classification: null,
    assigned_to: null,
    input: null,
    output: null,
    error: null,
    progress: 0,
    metadata: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("A2A server", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  describe("sendMessage", () => {
    it("should create a task and return A2A response", async () => {
      mockSubmitTask.mockResolvedValueOnce({
        taskId: "task-abc",
        agentType: "fast",
        classification: { score: 1, reason: "simple", explicit: false },
      });
      mockGetTaskWithRuns.mockReturnValueOnce({
        task: makeTaskRow() as never,
        runs: [],
        subtasks: [],
      });

      const res = await post(
        makeJsonRpc("sendMessage", {
          message: {
            role: "user",
            parts: [{ type: "text", text: "What is 2+2?" }],
          },
        }),
      );

      const json = await res.json();
      expect(json.jsonrpc).toBe("2.0");
      expect(json.result.id).toBe("task-abc");
      expect(json.result.status.state).toBe("submitted");
      expect(mockSubmitTask).toHaveBeenCalledOnce();
    });

    it("should reject missing message", async () => {
      const res = await post(makeJsonRpc("sendMessage", {}));
      const json = await res.json();

      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(-32602);
    });
  });

  describe("getTask", () => {
    it("should return A2A task for valid taskId", async () => {
      mockGetTaskWithRuns.mockReturnValueOnce({
        task: makeTaskRow({
          status: "completed",
          output: JSON.stringify("done"),
        }) as never,
        runs: [],
        subtasks: [],
      });

      const res = await post(makeJsonRpc("getTask", { taskId: "task-abc" }));

      const json = await res.json();
      expect(json.result.id).toBe("task-abc");
      expect(json.result.status.state).toBe("completed");
      expect(json.result.artifacts).toHaveLength(1);
    });

    it("should return error for missing task", async () => {
      mockGetTaskWithRuns.mockReturnValueOnce(null);

      const res = await post(makeJsonRpc("getTask", { taskId: "nonexistent" }));

      const json = await res.json();
      expect(json.error.code).toBe(-32001);
    });

    it("should return error for missing taskId param", async () => {
      const res = await post(makeJsonRpc("getTask", {}));
      const json = await res.json();
      expect(json.error.code).toBe(-32602);
    });
  });

  describe("cancelTask", () => {
    it("should cancel and return updated task", async () => {
      mockCancelTask.mockReturnValueOnce(true);
      mockGetTaskWithRuns.mockReturnValueOnce({
        task: makeTaskRow({ status: "cancelled" }) as never,
        runs: [],
        subtasks: [],
      });

      const res = await post(makeJsonRpc("cancelTask", { taskId: "task-abc" }));

      const json = await res.json();
      expect(json.result.status.state).toBe("canceled");
      expect(mockCancelTask).toHaveBeenCalledWith("task-abc");
    });

    it("should return error for non-cancelable task", async () => {
      mockCancelTask.mockReturnValueOnce(false);
      mockGetTaskWithRuns.mockReturnValueOnce({
        task: makeTaskRow({ status: "completed" }) as never,
        runs: [],
        subtasks: [],
      });

      const res = await post(makeJsonRpc("cancelTask", { taskId: "task-abc" }));

      const json = await res.json();
      expect(json.error.code).toBe(-32002);
    });

    it("should return not-found when task does not exist", async () => {
      mockCancelTask.mockReturnValueOnce(false);
      mockGetTaskWithRuns.mockReturnValueOnce(null);

      const res = await post(makeJsonRpc("cancelTask", { taskId: "gone" }));

      const json = await res.json();
      expect(json.error.code).toBe(-32001);
    });
  });

  describe("error handling", () => {
    it("should return method-not-found for unknown method", async () => {
      const res = await post(makeJsonRpc("unknownMethod"));
      const json = await res.json();

      expect(json.error.code).toBe(-32601);
      expect(json.error.message).toContain("unknownMethod");
    });

    it("should return parse error for invalid JSON", async () => {
      const req = new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json{{{",
      });
      const res = await a2a.fetch(req);
      const json = await res.json();

      expect(json.error.code).toBe(-32700);
    });

    it("should return invalid request for missing jsonrpc field", async () => {
      const res = await post({ method: "sendMessage", id: 1 });
      const json = await res.json();

      expect(json.error.code).toBe(-32600);
    });
  });
});
