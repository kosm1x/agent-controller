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

// V8.5 Phase 6: trace-emit seam (real module writes SQLite).
const emitTraceMock = vi.hoisted(() => vi.fn());
vi.mock("../observability/task-trace.js", () => ({
  emitTraceEvent: emitTraceMock,
}));

vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  submitTask,
  getTask,
  listTasks,
  cancelTask,
  extractPersistText,
  isPhantomZeroCostRow,
  registerRunner,
} from "./dispatcher.js";
import type { RunnerOutput } from "../runners/types.js";

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

  it("persists tools in metadata even when tags is absent (P3 cascade fix)", async () => {
    // Before the fix, metadata was only written when `tags` was truthy, so a
    // ritual submission with tools but no tags lost the tools list on retry.
    await submitTask({
      title: "Tools without tags",
      description: "Ritual-style submission",
      tools: ["evolution_get_data", "memory_store"],
    });

    const args = mockRun.mock.calls[0][0];
    expect(args.metadata).not.toBeNull();
    const parsed = JSON.parse(args.metadata as string);
    expect(parsed.tools).toEqual(["evolution_get_data", "memory_store"]);
    expect(parsed.tags).toBeUndefined();
    expect(parsed.ritualId).toBeUndefined();
  });

  it("persists ritualId in metadata for reaction-retry inheritance", async () => {
    await submitTask({
      title: "Skill evolution — 2026-05-24",
      description: "Ritual submission",
      agentType: "heavy",
      tools: ["evolution_get_data"],
      ritualId: "skill-evolution",
    });

    const args = mockRun.mock.calls[0][0];
    const parsed = JSON.parse(args.metadata as string);
    expect(parsed.ritualId).toBe("skill-evolution");
    expect(parsed.tools).toEqual(["evolution_get_data"]);
  });

  it("leaves metadata null when none of tags/tools/ritualId are set", async () => {
    await submitTask({
      title: "Bare submission",
      description: "Nothing extra",
    });

    const args = mockRun.mock.calls[0][0];
    expect(args.metadata).toBeNull();
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

  it("projects list columns — never SELECT * (fat output/input/metadata blobs)", () => {
    mockAll.mockReturnValueOnce([]);
    listTasks({});
    const sql = mockPrepare.mock.calls.at(-1)?.[0] as string;
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toContain("task_id");
    expect(sql).toContain("status");
    // The fat columns stay on the single-row detail path only.
    for (const fat of ["description", "input", "output", "metadata"]) {
      expect(sql).not.toMatch(new RegExp(`\\b${fat}\\b`));
    }
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

// ---------------------------------------------------------------------------
// extractPersistText — report text extraction for ritual persistResult
// ---------------------------------------------------------------------------

describe("extractPersistText", () => {
  it("on the REAL heavy-runner shape returns finalAnswer (the agent report), NOT content (the reflector summary)", () => {
    // This is the exact shape heavy-runner emits: content = reflector summary,
    // finalAnswer = the agent's joined goal answers. Persisting `content` here
    // would store "Heuristic score: 0.63..." instead of the report (qa BLOCKER).
    expect(
      extractPersistText({
        content: "Heuristic score: 0.63. 2/3 goals completed.",
        finalAnswer: "EVOLUTION REPORT — tool patterns...",
        score: 0.63,
        learnings: [],
      }),
    ).toBe("EVOLUTION REPORT — tool patterns...");
  });

  it("accepts a bare string output", () => {
    expect(extractPersistText("  a report  ")).toBe("a report");
  });

  it("falls back to content/text/result/output when finalAnswer is absent", () => {
    expect(extractPersistText({ content: "via content" })).toBe("via content");
    expect(extractPersistText({ text: "via text" })).toBe("via text");
    expect(extractPersistText({ result: "via result" })).toBe("via result");
    expect(extractPersistText({ output: "via output" })).toBe("via output");
  });

  it("prefers finalAnswer over every fallback key", () => {
    expect(
      extractPersistText({ finalAnswer: "fa", content: "c", text: "t" }),
    ).toBe("fa");
  });

  it("returns null when there is no usable text (avoids storing junk)", () => {
    expect(extractPersistText({ content: "   " })).toBeNull();
    expect(extractPersistText({ score: 0.5 })).toBeNull();
    expect(extractPersistText("")).toBeNull();
    expect(extractPersistText(null)).toBeNull();
    expect(extractPersistText(undefined)).toBeNull();
    expect(extractPersistText(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPhantomZeroCostRow — cost-ledger phantom-turns guard (open since 2026-05-23)
// ---------------------------------------------------------------------------

describe("isPhantomZeroCostRow", () => {
  it("flags a timed-out/aborted run with zero usage and no authoritative cost (the phantom row)", () => {
    // The SDK query aborted before any assistant turn streamed: usage stays
    // all-zeros, costAuthoritative=false so the shim omits actualCostUsd. This
    // is the row that would otherwise land in cost_ledger as $0.00 / tokens=0.
    expect(
      isPhantomZeroCostRow({
        success: false,
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          // actualCostUsd omitted — abort/timeout catch path
        },
      }),
    ).toBe(true);
  });

  it("preserves a legitimate $0 row from a real no-op task (success=true)", () => {
    expect(
      isPhantomZeroCostRow({
        success: true,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      }),
    ).toBe(false);
  });

  it("preserves an abort that streamed partial usage (nonzero tokens → real calculateCost)", () => {
    expect(
      isPhantomZeroCostRow({
        success: false,
        tokenUsage: { promptTokens: 1200, completionTokens: 300 },
      }),
    ).toBe(false);
  });

  it("preserves a Max-auth authoritative $0 (actualCostUsd=0 is defined, not undefined)", () => {
    expect(
      isPhantomZeroCostRow({
        success: false,
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          actualCostUsd: 0,
        },
      }),
    ).toBe(false);
  });

  it("is a no-op when the run reported no tokenUsage at all", () => {
    expect(isPhantomZeroCostRow({ success: false })).toBe(false);
    expect(isPhantomZeroCostRow({ success: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task-trace emit wiring (V8.5 Phase 6, audit W4)
// ---------------------------------------------------------------------------

describe("dispatchTask trace emits", () => {
  function stubRunner(result: Partial<RunnerOutput>) {
    registerRunner({
      type: "fast",
      execute: async () => ({ success: true, ...result }) as RunnerOutput,
    });
  }

  async function traceNamesAfterDispatch(): Promise<string[]> {
    await submitTask({ title: "Trace me", description: "trace wiring spec" });
    // dispatchTask is fire-and-forget from submitTask — wait for a terminal.
    await vi.waitFor(() => {
      const names = emitTraceMock.mock.calls.map((c) => c[0].name);
      if (!names.some((n) => n.startsWith("task.") && n !== "task.started")) {
        throw new Error("no terminal trace event yet");
      }
    });
    return emitTraceMock.mock.calls.map((c) => c[0].name);
  }

  it("success path: task.started then EXACTLY one terminal (task.completed)", async () => {
    stubRunner({
      success: true,
      output: "done",
      toolCalls: ["web_search"],
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 10,
        actualCostUsd: 0.01,
      },
    });
    const names = await traceNamesAfterDispatch();
    expect(names[0]).toBe("task.started");
    expect(names.filter((n) => n === "task.completed")).toHaveLength(1);
    expect(names).not.toContain("task.failed");

    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal).toMatchObject({
      name: "task.completed",
      tokensIn: 100,
      tokensOut: 10,
      costUsd: 0.01,
      tool: "web_search",
    });
    expect(terminal.attrs).toMatchObject({
      status: "completed",
      agent_type: "fast",
      tool_calls: 1,
    });
  });

  it("runner-throw path: exactly one terminal (task.failed from the catch)", async () => {
    registerRunner({
      type: "fast",
      execute: async () => {
        throw new Error("runner exploded");
      },
    });
    const names = await traceNamesAfterDispatch();
    expect(names.filter((n) => n.startsWith("task.") && n !== "task.started"))
      .toEqual(["task.failed"]);
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.attrs).toMatchObject({ thrown: true });
    expect(terminal.attrs.error).toContain("runner exploded");
  });

  it("failed-result path: one task.failed carrying the mapped status + error", async () => {
    stubRunner({ success: false, error: "no scope", status: "FAIL" });
    const names = await traceNamesAfterDispatch();
    expect(names.filter((n) => n !== "task.started")).toEqual(["task.failed"]);
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.attrs).toMatchObject({ status: "failed", error: "no scope" });
  });
});
