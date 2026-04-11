/**
 * Tests for dispatcher.ts — task lifecycle, cancellation, queries.
 *
 * Mocks: database, event bus, classifier, budget service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn(() => [] as unknown[]);
const mockPrepare = vi.fn((_sql: string) => ({
  run: mockRun,
  get: mockGet,
  all: mockAll,
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: (...args: unknown[]) => mockPrepare(...(args as [string])),
    transaction: (fn: Function) => fn,
  }),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    emitEvent: vi.fn(),
  }),
}));

vi.mock("./classifier.js", () => ({
  classify: vi.fn(() => ({
    agentType: "fast",
    score: 1,
    reason: "simple task",
    explicit: false,
    modelTier: "standard",
  })),
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://localhost:9999/v1",
    inferencePrimaryKey: "test",
    inferencePrimaryModel: "test-model",
    inferenceTimeoutMs: 5000,
    budgetEnabled: false,
    maxConcurrentContainers: 5,
  }),
}));

vi.mock("../budget/service.js", () => ({
  isBudgetExceeded: vi.fn(() => false),
  recordCost: vi.fn(),
}));

vi.mock("./checkout.js", () => ({
  checkoutTask: vi.fn(() => ({ success: true, taskId: "mock-id" })),
}));

vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { submitTask, getTask, listTasks, cancelTask } from "./dispatcher.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockAll.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// submitTask
// ---------------------------------------------------------------------------

describe("submitTask", () => {
  it("returns taskId and classification for a simple task", async () => {
    const result = await submitTask({
      title: "Test task",
      description: "Do something simple",
    });

    expect(result.taskId).toBeDefined();
    expect(result.agentType).toBe("fast");
    expect(result.classification.score).toBe(1);
    expect(result.classification.explicit).toBe(false);
  });

  it("inserts a task row via INSERT INTO tasks", async () => {
    await submitTask({
      title: "DB insert test",
      description: "Check DB call",
    });

    // C2 fix: verify the SQL statement, not just the args
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tasks"),
    );
    const args = mockRun.mock.calls[0][0];
    expect(args.title).toBe("DB insert test");
    expect(args.description).toBe("Check DB call");
  });

  it("uses default priority 'medium' when none specified", async () => {
    await submitTask({
      title: "Priority test",
      description: "No priority given",
    });

    const args = mockRun.mock.calls[0][0];
    expect(args.priority).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// getTask / listTasks
// ---------------------------------------------------------------------------

describe("getTask", () => {
  it("returns null when task not found", () => {
    mockGet.mockReturnValueOnce(undefined);
    expect(getTask("nonexistent-id")).toBeNull();
  });

  it("returns the task row when found", () => {
    const row = {
      task_id: "abc-123",
      title: "Found task",
      status: "completed",
    };
    mockGet.mockReturnValueOnce(row);
    expect(getTask("abc-123")).toEqual(row);
  });
});

describe("listTasks", () => {
  it("returns empty array when no tasks match", () => {
    mockAll.mockReturnValueOnce([]);
    const result = listTasks({});
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe("cancelTask", () => {
  it("returns false for nonexistent task", () => {
    mockGet.mockReturnValueOnce(undefined);
    expect(cancelTask("nonexistent")).toBe(false);
  });

  it("returns false for already completed task", () => {
    mockGet.mockReturnValueOnce({ task_id: "done-1", status: "completed" });
    expect(cancelTask("done-1")).toBe(false);
  });

  it("returns false for already failed task", () => {
    mockGet.mockReturnValueOnce({ task_id: "fail-1", status: "failed" });
    expect(cancelTask("fail-1")).toBe(false);
  });

  it("returns false for already cancelled task", () => {
    mockGet.mockReturnValueOnce({ task_id: "canc-1", status: "cancelled" });
    expect(cancelTask("canc-1")).toBe(false);
  });

  it("cancels a queued task successfully", () => {
    mockGet.mockReturnValueOnce({ task_id: "queued-1", status: "queued" });
    mockAll.mockReturnValueOnce([]); // no subtasks
    expect(cancelTask("queued-1")).toBe(true);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE tasks SET status = 'cancelled'"),
    );
  });

  it("cancels a running task and cascades to subtasks", () => {
    // Main task is running
    mockGet.mockReturnValueOnce({ task_id: "running-1", status: "running" });
    // Subtask query returns one active subtask
    mockAll.mockReturnValueOnce([{ task_id: "sub-1" }]);
    // Subtask getTask
    mockGet.mockReturnValueOnce({ task_id: "sub-1", status: "running" });
    // Subtask's subtask query returns empty
    mockAll.mockReturnValueOnce([]);

    const result = cancelTask("running-1");
    expect(result).toBe(true);
    // Should have called run() for: cancel main task + cancel main runs + cancel subtask + cancel subtask runs
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
