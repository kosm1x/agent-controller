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
import {
  BACKGROUND_ORIGIN,
  currentRunOrigin,
  priorRunTools,
  recordRunTool,
  type RunOrigin,
} from "../tools/rule-of-two.js";
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

describe("dispatchTask Rule-of-Two run context (V8.5 Phase 5.2, qa W3)", () => {
  it("runner.execute runs INSIDE enterRunToolContext — priorRunTools() is defined and tools record", async () => {
    let seenInside: readonly string[] | undefined | "unset" = "unset";
    let seenAfterRecord: readonly string[] | undefined | "unset" = "unset";
    registerRunner({
      type: "fast",
      execute: async () => {
        seenInside = priorRunTools();
        recordRunTool("web_search");
        seenAfterRecord = priorRunTools();
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({ title: "R2 ctx", description: "rule of two context wiring" });
    await vi.waitFor(() => {
      if (seenAfterRecord === "unset") throw new Error("runner not yet executed");
    });
    // Delete the dispatcher's enterRunToolContext wrap and this reads `undefined`.
    expect(seenInside).toEqual([]);
    expect(seenAfterRecord).toEqual(["web_search"]);
    expect(priorRunTools()).toBeUndefined(); // context does not leak out of the run
  });
});

// Seam origin wiring (qa W2 2026-08-17): the store is tested in rule-of-two;
// THIS pins the dispatcher's wiring point — delete the 3rd argument at the
// enterRunToolContext site and the operator label silently reverts to
// background with a green suite. Fails-open point ⇒ must be tested.
describe("dispatchTask V8.3 seam origin wiring (qa W2 2026-08-17)", () => {
  it("submission.threadId → runner executes with an OPERATOR origin on that thread; no threadId → BACKGROUND", async () => {
    const seen: RunOrigin[] = [];
    registerRunner({
      type: "fast",
      execute: async () => {
        seen.push(currentRunOrigin());
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({
      title: "op",
      description: "operator chat turn",
      threadId: "telegram:42",
    });
    await submitTask({ title: "bg", description: "scheduled task" });
    await vi.waitFor(() => {
      if (seen.length < 2) throw new Error("runners not yet executed");
    });
    expect(seen[0]).toEqual({ source: "operator", threadId: "telegram:42" });
    expect(seen[1]).toBe(BACKGROUND_ORIGIN);
    expect(currentRunOrigin()).toBe(BACKGROUND_ORIGIN); // no leak out of the run
  });
});

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

// ---------------------------------------------------------------------------
// V8.4 completion ledger wiring (2026-08-16)
// ---------------------------------------------------------------------------

describe("V8.4 ledger wiring: declare at submit → render at run → consumer at completion", () => {
  const gateRow = {
    task_id: "x",
    gate_id: "G1",
    criterion: "typecheck passes",
    check_kind: "shell",
    check_cmd: "true",
    expect: null,
    state: "pending",
    evidence: null,
    abandon_reason: null,
    source: "submission",
    frozen_at: null,
    checked_at: null,
    created_at: "",
  };
  const savedMode = process.env.TASK_GATES_MODE;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.TASK_GATES_MODE;
    else process.env.TASK_GATES_MODE = savedMode;
  });

  it("submission.gates are written to task_gates BEFORE dispatch, with the declared source", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    registerRunner({
      type: "fast",
      execute: async () => ({ success: true, output: "ok" }) as RunnerOutput,
    });
    await submitTask({
      title: "gated",
      description: "do it",
      gates: [{ criterion: "typecheck passes", check: "npx tsc --noEmit" }],
      gatesSource: "ritual",
    });
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE INTO task_gates"),
    );
    const gateInsert = mockRun.mock.calls
      .map((c) => c[0] as Record<string, unknown> | undefined)
      .find((a) => a && a.criterion === "typecheck passes");
    expect(gateInsert).toMatchObject({
      gateId: "G1",
      kind: "shell",
      check: "npx tsc --noEmit",
      source: "ritual",
    });
    // Ordering: the ledger row is written right after the tasks INSERT and
    // BEFORE dispatch — assert the ledger insert precedes the runs-row INSERT.
    const sqls = mockPrepare.mock.calls.map((c) => c[0] as string);
    const ledgerIdx = sqls.findIndex((s) => s.includes("INSERT OR IGNORE INTO task_gates"));
    const runIdx = sqls.findIndex((s) => s.includes("INSERT INTO runs"));
    expect(ledgerIdx).toBeGreaterThan(-1);
    expect(runIdx === -1 || ledgerIdx < runIdx).toBe(true);
  });

  it("a task WITH a ledger sees the gates block in its description; ungated tasks are byte-for-byte unchanged", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    mockAll.mockImplementation(() => [] as unknown[]);
    let seen = "";
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seen = input.description;
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({ title: "plain", description: "no gates here" });
    await vi.waitFor(() => {
      if (!seen) throw new Error("not run");
    });
    expect(seen).toBe("no gates here");

    // Now the ledger query returns a row → the block is rendered and the
    // ledger is frozen (UPDATE ... frozen_at) before the runner starts.
    seen = "";
    mockAll.mockImplementation((...args: unknown[]) => {
      void args;
      const lastSql = mockPrepare.mock.calls.at(-1)?.[0] as string;
      return lastSql?.includes("FROM task_gates") ? [gateRow] : [];
    });
    await submitTask({ title: "gated", description: "with gates" });
    await vi.waitFor(() => {
      if (!seen) throw new Error("not run");
    });
    expect(seen).toContain("with gates");
    expect(seen).toContain("## Acceptance gates (harness ledger)");
    expect(seen).toContain("- G1: typecheck passes [CHECK: true]");
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("SET frozen_at = datetime('now')"),
    );
  });

  it("completion consumer runs before updateTaskStatus: shadow mode records output.gates and a gates.evaluated trace, status untouched", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    mockRun.mockReturnValue({ changes: 1 });
    mockGet.mockReturnValue({ 1: 1 }); // hasGates → true
    mockAll.mockImplementation(() => {
      const lastSql = mockPrepare.mock.calls.at(-1)?.[0] as string;
      return lastSql?.includes("FROM task_gates") ? [gateRow] : [];
    });
    registerRunner({
      type: "fast",
      execute: async () => ({ success: true, output: { text: "Listo." } }) as RunnerOutput,
    });
    await submitTask({ title: "gated", description: "with gates" });
    await vi.waitFor(() => {
      const names = emitTraceMock.mock.calls.map((c) => c[0].name);
      if (!names.includes("task.completed")) throw new Error("not terminal yet");
    });
    const names = emitTraceMock.mock.calls.map((c) => c[0].name);
    expect(names.indexOf("gates.evaluated")).toBeGreaterThan(-1);
    expect(names.indexOf("gates.evaluated")).toBeLessThan(names.indexOf("task.completed"));
    const evaluated = emitTraceMock.mock.calls.find((c) => c[0].name === "gates.evaluated")![0];
    expect(evaluated.attrs).toMatchObject({ mode: "shadow", status_before: "completed" });
    // updateTaskStatus persisted the consumer-adjusted output (carries .gates)
    const statusWrite = mockRun.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a === "string" && a.includes('"gates"'));
    expect(statusWrite).toBeDefined();
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.attrs).toMatchObject({ status: "completed" });
  });
});
