/**
 * Tests for dispatcher.ts — task lifecycle, cancellation, queries.
 *
 * Mocks: database, event bus, classifier, budget service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import client from "prom-client";

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

// Shared so a test can observe the task.completed emit.
const emitEventMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    emitEvent: emitEventMock,
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

vi.mock("../rituals/scheduler.js", () => ({ recordRitualFailure: vi.fn() }));

// The real completion ledger, with a hook a test can use to act inside its
// await (a cancel that lands while the ledger runs).
type LedgerArgs = Parameters<
  typeof import("../lib/v8-4/consumer.js").applyCompletionLedger
>[0];
const ledgerHook = vi.hoisted(() => ({
  before: undefined as undefined | ((args: LedgerArgs) => Promise<void>),
}));
vi.mock("../lib/v8-4/consumer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/v8-4/consumer.js")>();
  return {
    ...real,
    applyCompletionLedger: async (args: LedgerArgs) => {
      if (ledgerHook.before) await ledgerHook.before(args);
      return real.applyCompletionLedger(args);
    },
  };
});

// Shared so the queue-4f tests can read the `[report-persist]` line.
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  createLogger: () => logMock,
}));

// Queue 4f (B): the KB write and the secret scrub are seams — never the real db.
const upsertFileMock = vi.hoisted(() => vi.fn());
vi.mock("../db/jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/jarvis-fs.js")>()),
  upsertFile: upsertFileMock,
}));
const scrubSecretsMock = vi.hoisted(() => vi.fn((t: string) => t));
vi.mock("../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/secret-refs.js")>()),
  scrubSecrets: scrubSecretsMock,
}));

import {
  submitTask,
  getTask,
  listTasks,
  cancelTask,
  extractPersistText,
  isPhantomZeroCostRow,
  registerRunner,
  undeclaredRunFailure,
  gateContextFor,
  LONG_ANSWER_PERSIST_MIN_CHARS,
  _announcedCancelCountForTests,
  _activeAbortCountForTests,
} from "./dispatcher.js";
import { isLedgerLine } from "../lib/v8-4/ledger-lines.js";
import { recordRitualFailure } from "../rituals/scheduler.js";
import { createTaskExecutor, undeclaredToolError } from "../tools/task-executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  BACKGROUND_ORIGIN,
  currentRunOrigin,
  currentRunSignal,
  priorRunTools,
  recordRunTool,
  type RunOrigin,
} from "../tools/rule-of-two.js";
import type { RunnerOutput } from "../runners/types.js";
import {
  currentExecutionContext,
  runnerExecutionContext,
  runWithExecutionContext,
  type TaskExecutionContext,
} from "../inference/execution-context.js";
import { outsideRunToolContext } from "../tools/rule-of-two.js";
import { classify } from "./classifier.js";
import { recordCost } from "../budget/service.js";
import { takeConcernDetail } from "../db/task-outcomes.js";
import {
  PASSWORD_WITHHELD_PLACEHOLDER,
  passwordFingerprint,
} from "../lib/v8-4/password-gate.js";
import {
  _resetStoreWithhold,
  setStoreSeenCheck,
} from "../lib/v8-4/store-withhold.js";

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

  it("S6 WS2: the INSERT carries project_slug/project_source (NULL when nothing attributes the task)", async () => {
    await submitTask({ title: "Unattributed", description: "d" });
    const insertSql = mockPrepare.mock.calls
      .map((c) => c[0])
      .find((s) => s.includes("INSERT INTO tasks"))!;
    expect(insertSql).toMatch(/retry_count, project_slug, project_source\)/);
    expect(insertSql).toMatch(/@retryCount, @projectSlug, @projectSource\)/);
    expect(mockRun.mock.calls[0][0]).toMatchObject({ projectSlug: null, projectSource: null });

    mockRun.mockClear();
    // The C1 validator's exact `projects.slug` lookup finds the row.
    mockGet.mockReturnValueOnce({ slug: "acme-radar" });
    await submitTask({
      title: "Chat naming a project",
      description: "d",
      projectSlug: "acme-radar",
      projectSource: "chat",
    });
    expect(mockRun.mock.calls[0][0]).toMatchObject({
      projectSlug: "acme-radar",
      projectSource: "chat",
    });
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

  it("persists tags as the text the ritual scheduler's once-per-day probe reads", async () => {
    // src/rituals/scheduler.ts `wasRetried` does metadata.includes('"ritual-retry"').
    await submitTask({
      title: "PM daily rebalance — 2026-09-19",
      description: "Ritual re-run",
      agentType: "fast",
      ritualId: "pm-daily-rebalance",
      tags: ["ritual-retry"],
    });
    expect(mockRun.mock.calls[0][0].metadata).toContain('"ritual-retry"');
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

  // completed_with_concerns is a final state: the run delivered its answer.
  it("returns false for a task that completed with concerns and leaves its row alone", () => {
    mockGet.mockReturnValueOnce({ task_id: "cwc-1", status: "completed_with_concerns" });
    expect(cancelTask("cwc-1")).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("cancelling a parent leaves a child that completed with concerns unchanged", () => {
    // The child lookup honours the SQL's own NOT IN list, so the test sees what
    // the statement would select on a real table. The child query's list and the
    // terminal check in the recursive cancelTask call each keep a finished child
    // unchanged, so reverting only one of them leaves this test green.
    const rows: Record<string, { task_id: string; parent_task_id: string | null; status: string }> = {
      "parent-1": { task_id: "parent-1", parent_task_id: null, status: "running" },
      "child-1": { task_id: "child-1", parent_task_id: "parent-1", status: "completed_with_concerns" },
    };
    const defaultPrepare = mockPrepare.getMockImplementation()!;
    const tablePrepare = (sql: string) => ({
      get: (id: string) => (sql.startsWith("SELECT * FROM tasks WHERE task_id") ? rows[id] : undefined),
      all: (parent: string) => {
        const m = /parent_task_id = \? AND status NOT IN \(([^)]*)\)/.exec(sql);
        if (!m) return [];
        const excluded = m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
        return Object.values(rows)
          .filter((r) => r.parent_task_id === parent && !excluded.includes(r.status))
          .map((r) => ({ task_id: r.task_id }));
      },
      run: (id: string) => {
        if (sql.startsWith("UPDATE tasks SET status = 'cancelled'") && rows[id]) {
          rows[id].status = "cancelled";
        }
      },
    });
    mockPrepare.mockImplementation(tablePrepare as unknown as typeof defaultPrepare);

    try {
      expect(cancelTask("parent-1")).toBe(true);
      expect(rows["parent-1"].status).toBe("cancelled");
      expect(rows["child-1"].status).toBe("completed_with_concerns");
    } finally {
      mockPrepare.mockImplementation(defaultPrepare);
    }
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

  it("the run context carries the task's abort signal — tools stop on cancelTask", async () => {
    const abortController = new AbortController();
    let seen: AbortSignal | undefined | "unset" = "unset";
    registerRunner({
      type: "fast",
      execute: async () => {
        seen = currentRunSignal();
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({ title: "signal ctx", description: "abort signal wiring", abortController });
    await vi.waitFor(() => {
      if (seen === "unset") throw new Error("runner not yet executed");
    });
    expect(seen).toBe(abortController.signal);
    expect(currentRunSignal()).toBeUndefined();
  });
});

// 2026-09-19: a dead model login failed the PM rebalance as "Required tools
// not called: pm_paper_rebalance" — the runner's reason never reached the row.
describe("dispatchTask required-tools failure names the runner's reason", () => {
  it("appends the runner's first concern to the task error", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({
          success: true,
          status: "DONE_WITH_CONCERNS",
          concerns: ["fallo de autenticación, tarea no ejecutada."],
          output: "x",
          durationMs: 0,
          toolCalls: [],
        }) as RunnerOutput,
    });
    await submitTask({
      title: "PM daily rebalance",
      description: "rebalance",
      requiredTools: ["pm_paper_rebalance"],
      _isRequiredToolRetry: true,
    });
    const expected =
      "Required tools not called after retry: pm_paper_rebalance — runner: fallo de autenticación, tarea no ejecutada.";
    await vi.waitFor(() => {
      if (!mockRun.mock.calls.some((c) => c.includes(expected)))
        throw new Error("failed-status write not seen yet");
    });
  });
});

// A run that spent tokens is booked once, whichever way it ends: the
// required-tools retry is a new task with its own run, so the first run's
// spend is recorded on the first run.
describe("dispatchTask books the run's cost on the required-tools paths", () => {
  const usage = {
    promptTokens: 120,
    completionTokens: 30,
    actualModel: "test-actual-model",
    actualCostUsd: 0.0123,
    cacheReadTokens: 400,
    cacheCreationTokens: 50,
  };

  async function runAndCollectCost(
    toolCalls: string[],
    extra: { requiredTools?: string[]; _isRequiredToolRetry?: boolean },
  ) {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, output: "x", durationMs: 0, toolCalls, tokenUsage: { ...usage } }) as RunnerOutput,
    });
    const { taskId } = await submitTask({ title: "Cost on retry path", description: "d", ...extra });
    await vi.waitFor(() => {
      const done = emitTraceMock.mock.calls.some(
        (c) => c[0].taskId === taskId && (c[0].name === "task.failed" || c[0].name === "task.completed"),
      );
      if (!done) throw new Error("no terminal trace event yet");
    });
    const calls = vi.mocked(recordCost).mock.calls.filter((c) => c[0].taskId === taskId);
    return { taskId, calls };
  }

  function expectedCost(taskId: string) {
    return {
      runId: expect.any(String),
      taskId,
      agentType: "fast",
      model: "test-actual-model",
      promptTokens: 120,
      completionTokens: 30,
      costUsdOverride: 0.0123,
      cacheReadTokens: 400,
      cacheCreationTokens: 50,
    };
  }

  it("first attempt missing a required tool (auto-retry): one cost row for that run", async () => {
    const { taskId, calls } = await runAndCollectCost([], { requiredTools: ["pm_paper_rebalance"] });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(expectedCost(taskId));
  });

  it("retry still missing a required tool: one cost row for that run", async () => {
    const { taskId, calls } = await runAndCollectCost([], {
      requiredTools: ["pm_paper_rebalance"],
      _isRequiredToolRetry: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(expectedCost(taskId));
  });

  it("normal completion still books exactly one cost row", async () => {
    const { taskId, calls } = await runAndCollectCost(["pm_paper_rebalance"], {
      requiredTools: ["pm_paper_rebalance"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(expectedCost(taskId));
  });

  it("the cost row write fails → the task still completes and mc_write_failures_total{site=cost_task} went up by one", async () => {
    const costTaskCount = async () =>
      (await client.register.getSingleMetric("mc_write_failures_total")?.get())?.values.find(
        (v) => v.labels.site === "cost_task",
      )?.value ?? 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recordCost).mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    const before = await costTaskCount();
    const { taskId, calls } = await runAndCollectCost(["pm_paper_rebalance"], {
      requiredTools: ["pm_paper_rebalance"],
    });
    expect(calls).toHaveLength(1);
    expect(
      emitTraceMock.mock.calls.some((c) => c[0].taskId === taskId && c[0].name === "task.completed"),
    ).toBe(true);
    expect(await costTaskCount()).toBe(before + 1);
  });
});

// 2026-10-04: DONE_WITH_CONCERNS went 9% → 42% of fast tasks and the model's
// explanation was dropped. The dispatcher notes it for task_outcomes.
describe("dispatchTask notes the runner's concern for task_outcomes.concern_detail", () => {
  async function dispatchWith(result: RunnerOutput): Promise<string> {
    registerRunner({ type: "fast", execute: async () => result });
    const { taskId } = await submitTask({
      title: "Concern detail",
      description: "concern detail spec",
    });
    await vi.waitFor(() => {
      const names = emitTraceMock.mock.calls.map((c) => c[0].name);
      if (!names.some((n) => n === "task.completed" || n === "task.failed")) {
        throw new Error("no terminal trace event yet");
      }
    });
    return taskId;
  }

  it("DONE_WITH_CONCERNS: the first concern is noted, redacted and capped", async () => {
    // Built at runtime — no key-shaped literal in the (public) repo.
    const key = "AIza" + "b".repeat(35);
    const taskId = await dispatchWith({
      success: true,
      status: "DONE_WITH_CONCERNS",
      concerns: [` no pude confirmar con ${key} ${"z".repeat(600)}`, "second"],
      output: "x",
      durationMs: 0,
    });
    const detail = takeConcernDetail(taskId)!;
    expect(detail.startsWith("no pude confirmar con [REDACTED")).toBe(true);
    expect(detail).not.toMatch(/AIza|bbbbb/);
    expect(detail.length).toBe(500);
  });

  it("clean DONE: nothing is noted", async () => {
    const taskId = await dispatchWith({
      success: true,
      status: "DONE",
      output: "x",
      durationMs: 0,
    });
    expect(takeConcernDetail(taskId)).toBeNull();
  });

  // The tracker runs inside the task.completed handler, so the note must
  // already be there when the event fires (audit W1).
  it("the detail is noted BEFORE task.completed is emitted", async () => {
    let seenInEmit: string | null | "unset" = "unset";
    emitEventMock.mockImplementation(
      (name: string, data: { task_id: string }) => {
        if (name === "task.completed") seenInEmit = takeConcernDetail(data.task_id);
      },
    );
    try {
      await dispatchWith({
        success: true,
        status: "DONE_WITH_CONCERNS",
        concerns: ["sin datos del día"],
        output: "x",
        durationMs: 0,
      });
    } finally {
      emitEventMock.mockReset();
    }
    expect(seenInEmit).toBe("sin datos del día");
  });

  // Storage only: a malformed concern never changes the outcome (audit W3).
  it("a non-string first concern still completes the task, with no detail", async () => {
    const taskId = await dispatchWith({
      success: true,
      status: "DONE_WITH_CONCERNS",
      concerns: [{ not: "a string" } as unknown as string],
      output: "x",
      durationMs: 0,
    });
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.name).toBe("task.completed");
    expect(terminal.attrs).toMatchObject({ status: "completed_with_concerns" });
    expect(
      emitEventMock.mock.calls.some(
        (c) => c[0] === "task.completed" && c[1].task_id === taskId,
      ),
    ).toBe(true);
    expect(takeConcernDetail(taskId)).toBeNull();
  });
});

// Reliability audit R4 (2026-09-10): cancelTask() flipped the rows but never
// aborted the runner — the SDK call kept running (and billing) and a
// container task kept its slot until it exited on its own.
describe("cancelTask aborts the running runner (reliability audit R4)", () => {
  it("the RunnerInput.signal is aborted when the task is cancelled", async () => {
    let seenSignal: AbortSignal | undefined;
    let finished = false;
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seenSignal = input.signal;
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        finished = true;
        return { success: false, error: "aborted" } as RunnerOutput;
      },
    });
    const { taskId } = await submitTask({
      title: "cancel me",
      description: "long running chat",
    });
    await vi.waitFor(() => {
      if (!seenSignal) throw new Error("runner not yet executed");
    });
    expect(seenSignal!.aborted).toBe(false);
    expect(finished).toBe(false);

    mockGet.mockReturnValueOnce({ task_id: taskId, status: "running" });
    mockAll.mockReturnValueOnce([]); // no subtasks
    expect(cancelTask(taskId)).toBe(true);

    expect(seenSignal!.aborted).toBe(true);
    await vi.waitFor(() => {
      if (!finished) throw new Error("runner did not return after abort");
    });
  });
});

// A task the user cancelled is closed as cancelled whatever the runner hands
// back after the abort: the run row is not "completed" or "failed", no
// completed delivery and no failure alarm (task.cancelled already went out),
// and the spend of the partial run is still booked.
describe("dispatchTask: a result that arrives after its task was cancelled", () => {
  it.each([
    ["a success result (partial text)", true],
    ["a failure result", false],
  ])("%s closes the run as cancelled; no task.completed or task.failed", async (_label, success) => {
    let returned = false;
    registerRunner({
      type: "fast",
      execute: async (input) => {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        returned = true;
        const out: RunnerOutput = {
          success,
          output: { text: "Example Corp has three off" },
          ...(success ? { status: "DONE" as const } : { error: "cancelled" }),
          // Neither is the required tool: a run that reached the required-tools
          // check would spawn a retry task and write task.failed.
          toolCalls: ["file_read", "file_write"],
          tokenUsage: { promptTokens: 120, completionTokens: 9, actualCostUsd: 0.0123 },
          durationMs: 1,
        };
        return out;
      },
    });
    const { taskId } = await submitTask({
      title: "cancel me",
      description: "long running chat",
      tags: ["messaging"],
      requiredTools: ["web_search"],
    });
    await vi.waitFor(() => {
      if (!mockPrepare.mock.calls.length) throw new Error("not dispatched");
    });
    mockGet.mockReturnValueOnce({ task_id: taskId, status: "running" });
    mockAll.mockReturnValueOnce([]); // no subtasks
    expect(cancelTask(taskId)).toBe(true);
    await vi.waitFor(() => {
      if (!returned) throw new Error("runner did not return");
      if (!vi.mocked(recordCost).mock.calls.length) throw new Error("cost not booked yet");
    });

    // The cancelled branch returns before the required-tools check.
    expect(logMock.warn.mock.calls.map((c) => c[1])).not.toContain(
      "required tools missing, auto-retrying once",
    );
    const runRowStatuses = mockRun.mock.calls
      .map((c) => c[0] as { runId?: string; status?: string } | undefined)
      .filter((p) => p?.runId !== undefined && p.status !== undefined)
      .map((p) => p!.status);
    expect(runRowStatuses).not.toContain("completed");
    expect(runRowStatuses).not.toContain("failed");
    // The cancelled row keeps what the runner reported: its usage and its text.
    const cancelledRow = mockRun.mock.calls
      .map((c) => c[0] as Record<string, unknown> | undefined)
      .find((p) => p?.runId !== undefined && "tokenUsage" in p && !("status" in p));
    expect(cancelledRow).toBeDefined();
    expect(JSON.parse(String(cancelledRow!.tokenUsage))).toEqual({
      promptTokens: 120,
      completionTokens: 9,
      actualCostUsd: 0.0123,
    });
    expect(String(cancelledRow!.output)).toContain("Example Corp has three off");
    const sqls = mockPrepare.mock.calls.map((c) => String(c[0]));
    expect(
      sqls.some((q) => /UPDATE runs SET\s+status = 'cancelled'[\s\S]*run_id = @runId/.test(q)),
    ).toBe(true);

    const events = emitEventMock.mock.calls.map((c) => c[0]);
    expect(events).not.toContain("task.completed");
    expect(events).not.toContain("task.failed");
    expect(events.filter((e) => e === "task.cancelled")).toHaveLength(1);
    // No required-tools retry task is spawned for a cancelled run.
    expect(
      sqls.filter((q) => q.includes("INSERT INTO tasks")),
    ).toHaveLength(1);
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordCost).mock.calls[0][0]).toMatchObject({
      taskId,
      promptTokens: 120,
      completionTokens: 9,
    });

    // The timeline ends on exactly one terminal row, named for the cancel.
    const traces = emitTraceMock.mock.calls.map((c) => c[0]);
    const terminals = traces.filter(
      (t) => t.name.startsWith("task.") && t.name !== "task.started",
    );
    expect(terminals.map((t) => t.name)).toEqual(["task.cancelled"]);
    expect(terminals[0]).toMatchObject({
      tokensIn: 120,
      tokensOut: 9,
      costUsd: 0.0123,
      // The last tool the run called, as on the normal terminal row.
      tool: "file_write",
    });
    expect(typeof terminals[0].latencyMs).toBe("number");
    expect(terminals[0].attrs).toEqual({
      status: "cancelled",
      termination_reason: "aborted",
      agent_type: "fast",
      tool_calls: 2,
    });
  });

  it("a runner that throws on the abort closes the run as cancelled, not failed", async () => {
    registerRunner({
      type: "fast",
      execute: async (input) => {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("This operation was aborted");
      },
    });
    const { taskId } = await submitTask({
      title: "cancel me",
      description: "long running chat",
    });
    await vi.waitFor(() => {
      if (!mockPrepare.mock.calls.length) throw new Error("not dispatched");
    });
    mockGet.mockReturnValueOnce({ task_id: taskId, status: "running" });
    mockAll.mockReturnValueOnce([]); // no subtasks
    expect(cancelTask(taskId)).toBe(true);

    const runRowStatuses = () =>
      mockRun.mock.calls
        .map((c) => c[0] as { runId?: string; status?: string } | undefined)
        .filter((p) => p?.runId !== undefined && p.status !== undefined)
        .map((p) => p!.status);
    await vi.waitFor(() => {
      if (!runRowStatuses().length) throw new Error("run row not closed yet");
    });
    expect(runRowStatuses()).toEqual(["cancelled"]);
    expect(emitEventMock.mock.calls.map((c) => c[0])).not.toContain("task.failed");
    const terminals = emitTraceMock.mock.calls
      .map((c) => c[0])
      .filter((t) => t.name.startsWith("task.") && t.name !== "task.started");
    expect(terminals.map((t) => t.name)).toEqual(["task.cancelled"]);
    expect(terminals[0].attrs).toEqual({
      status: "cancelled",
      termination_reason: "aborted",
      thrown: true,
    });
  });
});

// The cancel can land after the first runner returned: during the fallback
// re-run, during the completion ledger, or as a row another process wrote.
// Each closes the run as cancelled with one task.cancelled timeline row and no
// completion or failure event on the bus (that event drives retries and
// alarms). A run that was not cancelled keeps its rows and its bus order.
describe("dispatchTask: a cancel that lands after the first runner returned", () => {
  const STATUS_SQL = "SELECT status FROM tasks WHERE task_id = ?";
  afterEach(() => {
    ledgerHook.before = undefined;
    emitEventMock.mockReset();
    emitTraceMock.mockReset();
    mockPrepare.mockImplementation((_sql: string) => ({
      run: mockRun,
      get: mockGet,
      all: mockAll,
    }));
  });

  const busNames = () => emitEventMock.mock.calls.map((c) => c[0] as string);
  const terminalTraces = () =>
    emitTraceMock.mock.calls
      .map((c) => c[0])
      .filter(
        (t) =>
          t.name.startsWith("task.") &&
          t.name !== "task.started" &&
          t.name !== "task.fallback",
      );
  const runStatuses = () =>
    mockRun.mock.calls
      .map((c) => c[0] as { runId?: string; status?: string } | undefined)
      .filter((p) => p?.runId !== undefined && p.status !== undefined)
      .map((p) => p!.status);
  const runWrites = () =>
    mockPrepare.mock.calls
      .map((c) => String(c[0]))
      .filter((q) => /UPDATE runs SET/.test(q) && /run_id = @runId/.test(q));
  const CANCELLED_RUN = /status = 'cancelled'/;
  // Closed one way or the other: a terminal timeline row, a terminal bus
  // event, or the cancelled run-row write.
  const settled = () => {
    if (
      !terminalTraces().length &&
      !busNames().some((n) => n === "task.completed" || n === "task.failed") &&
      !runWrites().some((q) => CANCELLED_RUN.test(q))
    ) {
      throw new Error("run not closed yet");
    }
  };
  const cancelRunning = (taskId: string) => {
    mockGet.mockReturnValueOnce({ task_id: taskId, status: "running" });
    mockAll.mockReturnValueOnce([]); // no subtasks
    expect(cancelTask(taskId)).toBe(true);
  };
  // Answers the dispatcher's task-status read through `decide`; every other
  // statement keeps the shared mocks.
  const installStatusRow = (decide: (id: unknown) => unknown) => {
    const statusGet = vi.fn();
    statusGet.mockImplementation(decide);
    mockPrepare.mockImplementation((sql: string) => ({
      run: mockRun,
      get: sql === STATUS_SQL ? statusGet : mockGet,
      all: mockAll,
    }));
    return statusGet;
  };
  const cancelPayloads = () =>
    emitEventMock.mock.calls
      .filter((c) => c[0] === "task.cancelled")
      .map((c) => c[1] as { cancelled_by?: string });
  const expectCancelledClose = () => {
    expect(terminalTraces().map((t) => t.name)).toEqual(["task.cancelled"]);
    expect(runWrites().at(-1)).toMatch(CANCELLED_RUN);
    expect(busNames()).not.toContain("task.completed");
    expect(busNames()).not.toContain("task.failed");
  };

  it("a cancel during the fallback re-run closes the run as cancelled; no task.failed on the bus", async () => {
    vi.mocked(classify).mockReturnValueOnce({
      agentType: "nanoclaw",
      score: 5,
      reason: "coding",
      explicit: false,
      modelTier: "standard",
    } as unknown as ReturnType<typeof classify>);
    registerRunner({
      type: "nanoclaw",
      // A no-op sandbox failure (no error) → the in-process fast fallback.
      execute: async () => ({ success: false }) as RunnerOutput,
    });
    let fallbackStarted = false;
    registerRunner({
      type: "fast",
      execute: async (input) => {
        fallbackStarted = true;
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        const out: RunnerOutput = {
          success: false,
          error: "cancelled",
          terminationReason: "aborted",
          toolCalls: ["web_search"],
          tokenUsage: { promptTokens: 40, completionTokens: 3 },
          durationMs: 1,
        };
        return out;
      },
    });
    const { taskId } = await submitTask({
      title: "misrouted chat",
      description: "d",
      tags: ["messaging"],
    });
    await vi.waitFor(() => {
      if (!fallbackStarted) throw new Error("fallback not started");
    });
    cancelRunning(taskId);
    await vi.waitFor(settled);

    expect(emitTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task.fallback" }),
    );
    expectCancelledClose();
    // The fallback's own usage is what the cancelled row carries.
    expect(terminalTraces()[0]).toMatchObject({
      tokensIn: 40,
      tokensOut: 3,
      tool: "web_search",
    });
    // The failed-run write is never reached.
    expect(runStatuses()).toEqual([]);
    // The reaction engine acts on bus task.failed; the only bus event after
    // the create is the cancel entry point's own announcement.
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
  });

  it("a cancel during the completion ledger closes the run as cancelled; no task.completed on the bus", async () => {
    registerRunner({
      type: "fast",
      execute: async () => {
        const out: RunnerOutput = {
          success: true,
          status: "DONE",
          output: "Example Corp has three offices",
          toolCalls: ["file_read", "file_write"],
          tokenUsage: { promptTokens: 70, completionTokens: 8 },
          durationMs: 1,
        };
        return out;
      },
    });
    ledgerHook.before = async ({ taskId }) => cancelRunning(taskId);
    await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(settled);

    expectCancelledClose();
    expect(terminalTraces()[0]).toMatchObject({ tool: "file_write" });
    expect(terminalTraces()[0].attrs).toMatchObject({ tool_calls: 2 });
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    // The spend is booked once.
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordCost).mock.calls[0][0]).toMatchObject({
      promptTokens: 70,
      completionTokens: 8,
    });
  });

  it("a cancel written to the task row by another process closes the run as cancelled and is announced once", async () => {
    let idSeen = "";
    registerRunner({
      type: "fast",
      execute: async (input) => {
        idSeen = input.taskId;
        return { success: true, status: "DONE", output: "ok", durationMs: 1 } as RunnerOutput;
      },
    });
    // The row turns cancelled while the ledger runs; nothing aborts the signal.
    // Only this task's row says so.
    let rowCancelled = false;
    ledgerHook.before = async () => {
      rowCancelled = true;
    };
    const statusGet = installStatusRow((id) => ({
      status: id === idSeen && rowCancelled ? "cancelled" : "running",
    }));
    const { taskId } = await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(settled);

    expectCancelledClose();
    // No entry point announced this cancel, so the close does, once.
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([
      expect.objectContaining({ task_id: taskId, cancelled_by: "db" }),
    ]);
    // The status read names this task.
    expect(statusGet.mock.calls.length).toBeGreaterThan(0);
    expect(new Set(statusGet.mock.calls.map((c) => c[0]))).toEqual(new Set([taskId]));
  });

  it.each(["completed", "completed_with_concerns", "failed"])(
    "an abort that fires after the task row is already %s leaves the normal close",
    async (terminalStatus) => {
      const ac = new AbortController();
      let idSeen = "";
      let rowDone = false;
      registerRunner({
        type: "fast",
        execute: async (input) => {
          idSeen = input.taskId;
          return { success: true, status: "DONE", output: "ok", durationMs: 1 } as RunnerOutput;
        },
      });
      installStatusRow((id) => ({
        status: id === idSeen && rowDone ? terminalStatus : "running",
      }));
      ledgerHook.before = async () => {
        rowDone = true;
        ac.abort();
      };
      await submitTask({ title: "answer me", description: "d", abortController: ac });
      await vi.waitFor(settled);

      expect(terminalTraces().map((t) => t.name)).toEqual(["task.completed"]);
      expect(busNames()).toEqual(["task.created", "task.completed"]);
      expect(runStatuses()).toEqual(["completed"]);
      expect(runWrites().some((q) => CANCELLED_RUN.test(q))).toBe(false);
    },
  );

  it("a status read that throws while the signal is set closes the run as cancelled, announced once", async () => {
    const ac = new AbortController();
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, status: "DONE", output: "ok", durationMs: 1 }) as RunnerOutput,
    });
    installStatusRow(() => {
      throw new Error("SQLITE_BUSY");
    });
    ledgerHook.before = async () => {
      ac.abort();
    };
    const { taskId } = await submitTask({ title: "answer me", description: "d", abortController: ac });
    await vi.waitFor(settled);

    expectCancelledClose();
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([
      expect.objectContaining({ task_id: taskId, cancelled_by: "signal" }),
    ]);
  });

  it("a cancel whose own announcement failed is announced once, by the close", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, status: "DONE", output: "ok", durationMs: 1 }) as RunnerOutput,
    });
    // The entry point's emit throws once; the cancel must not count as announced.
    let failedOnce = false;
    emitEventMock.mockImplementation((type: string) => {
      if (type === "task.cancelled" && !failedOnce) {
        failedOnce = true;
        throw new Error("event store unavailable");
      }
    });
    ledgerHook.before = async ({ taskId }) => cancelRunning(taskId);
    const { taskId } = await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(settled);

    expectCancelledClose();
    const delivered = emitEventMock.mock.calls
      .map((c, i) => ({ type: c[0], data: c[1], outcome: emitEventMock.mock.results[i].type }))
      .filter((e) => e.type === "task.cancelled" && e.outcome === "return")
      .map((e) => e.data);
    expect(delivered).toEqual([
      expect.objectContaining({ task_id: taskId, cancelled_by: "signal" }),
    ]);
    expect(_announcedCancelCountForTests()).toBe(0);
  });

  it("a throw before the run starts leaves no abort entry and no cancel record", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, status: "DONE", output: "ok", durationMs: 1 }) as RunnerOutput,
    });
    emitTraceMock.mockImplementation((e: { name: string }) => {
      if (e.name === "task.started") throw new Error("trace sink down");
    });
    const { taskId } = await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(() => {
      if (!logMock.error.mock.calls.some((c) => c[1] === "failed to dispatch task")) {
        throw new Error("dispatch not failed yet");
      }
    });

    expect(_activeAbortCountForTests()).toBe(0);
    // A later cancel request for the same id finds no run to record against.
    cancelRunning(taskId);
    expect(_announcedCancelCountForTests()).toBe(0);
  });

  it("a runner that throws while the signal is set marks the task row cancelled, not failed", async () => {
    const ac = new AbortController();
    registerRunner({
      type: "fast",
      execute: async () => {
        ac.abort();
        throw new Error("This operation was aborted");
      },
    });
    const taskWrites: Array<[string, unknown[]]> = [];
    const runningRow = vi.fn();
    runningRow.mockReturnValue({ status: "running" });
    mockPrepare.mockImplementation((sql: string) => {
      const run = vi.fn();
      run.mockImplementation((...args: unknown[]) => {
        if (sql.startsWith("UPDATE tasks SET status")) taskWrites.push([sql, args]);
        return mockRun(...args);
      });
      return { run, get: sql === STATUS_SQL ? runningRow : mockGet, all: mockAll };
    });
    await submitTask({ title: "answer me", description: "d", abortController: ac });
    await vi.waitFor(settled);

    expect(runStatuses()).toEqual(["cancelled"]);
    expect(taskWrites.some(([q]) => q.includes("status = 'failed'"))).toBe(false);
    expect(taskWrites.filter(([, a]) => a[0] === "cancelled")).toHaveLength(1);
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([expect.objectContaining({ cancelled_by: "signal" })]);
  });

  it("an abort whose cancelTask call is refused (row already cancelled) is announced once, by the close", async () => {
    const ac = new AbortController();
    let idSeen = "";
    let rowCancelled = false;
    let refused: boolean | undefined;
    registerRunner({
      type: "fast",
      execute: async (input) => {
        idSeen = input.taskId;
        return { success: true, status: "DONE", output: "ok", durationMs: 1 } as RunnerOutput;
      },
    });
    installStatusRow((id) => ({
      status: id === idSeen && rowCancelled ? "cancelled" : "running",
    }));
    // Another process cancelled the row; then the caller aborts and asks
    // cancelTask, which refuses an already-cancelled task and announces nothing.
    ledgerHook.before = async ({ taskId }) => {
      rowCancelled = true;
      ac.abort();
      mockGet.mockReturnValueOnce({ task_id: taskId, status: "cancelled" });
      refused = cancelTask(taskId);
    };
    const { taskId } = await submitTask({ title: "answer me", description: "d", abortController: ac });
    await vi.waitFor(settled);

    expect(refused).toBe(false);
    expectCancelledClose();
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([
      expect.objectContaining({ task_id: taskId, cancelled_by: "signal" }),
    ]);
    expect(_announcedCancelCountForTests()).toBe(0);
  });

  it("an abort with no cancel request at all is announced once, by the close, as a signal cancel", async () => {
    const ac = new AbortController();
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, status: "DONE", output: "ok", durationMs: 1 }) as RunnerOutput,
    });
    installStatusRow(() => ({ status: "running" }));
    // A caller that gives up and aborts before it knows the task id never
    // calls cancelTask; the row stays running.
    ledgerHook.before = async () => {
      ac.abort();
    };
    const { taskId } = await submitTask({ title: "answer me", description: "d", abortController: ac });
    await vi.waitFor(settled);

    expectCancelledClose();
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([
      expect.objectContaining({ task_id: taskId, cancelled_by: "signal" }),
    ]);
    expect(_announcedCancelCountForTests()).toBe(0);
  });

  it("an ordinary cancelTask is announced by the entry point only, and its record ends with the run", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, status: "DONE", output: "ok", durationMs: 1 }) as RunnerOutput,
    });
    let heldDuringRun = -1;
    ledgerHook.before = async ({ taskId }) => {
      cancelRunning(taskId);
      heldDuringRun = _announcedCancelCountForTests();
    };
    const { taskId } = await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(settled);

    expectCancelledClose();
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([
      expect.objectContaining({ task_id: taskId, cancelled_by: "api" }),
    ]);
    expect(heldDuringRun).toBe(1);
    expect(_announcedCancelCountForTests()).toBe(0);
  });

  it("a cancelTask on a task with no run in flight leaves no record", () => {
    mockGet.mockReturnValueOnce({ task_id: "t-queued", status: "queued" });
    mockAll.mockReturnValueOnce([]);
    expect(cancelTask("t-queued")).toBe(true);
    expect(cancelPayloads()).toEqual([
      expect.objectContaining({ task_id: "t-queued", cancelled_by: "api" }),
    ]);
    expect(_announcedCancelCountForTests()).toBe(0);
  });

  it("a status read that throws leaves a good run exactly as it was", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, status: "DONE", output: "ok", durationMs: 1 }) as RunnerOutput,
    });
    installStatusRow(() => {
      throw new Error("SQLITE_BUSY");
    });
    await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(settled);

    expect(busNames()).toEqual(["task.created", "task.completed"]);
    expect(emitTraceMock.mock.calls.map((c) => c[0].name)).toEqual([
      "attribution.resolved",
      "task.started",
      "numbers.audited",
      "task.completed",
    ]);
    expect(runStatuses()).toEqual(["completed"]);
    // One warn line per failed read (after the runner, before the terminal).
    expect(
      logMock.warn.mock.calls.filter(
        (c) => c[1] === "cancel check: task status unreadable, deciding by the abort signal",
      ),
    ).toHaveLength(2);
  });

  it("a runner that throws after a row-only cancel closes the run as cancelled, announced once", async () => {
    let idSeen = "";
    let rowCancelled = false;
    registerRunner({
      type: "fast",
      execute: async (input) => {
        idSeen = input.taskId;
        rowCancelled = true;
        throw new Error("tool loop broke");
      },
    });
    installStatusRow((id) => ({
      status: id === idSeen && rowCancelled ? "cancelled" : "running",
    }));
    await submitTask({ title: "answer me", description: "d" });
    await vi.waitFor(settled);

    expect(terminalTraces()).toEqual([
      expect.objectContaining({
        name: "task.cancelled",
        attrs: { status: "cancelled", termination_reason: "aborted", thrown: true },
      }),
    ]);
    expect(runStatuses()).toEqual(["cancelled"]);
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
    expect(cancelPayloads()).toEqual([expect.objectContaining({ cancelled_by: "db" })]);
  });

  it("a fallback that throws after the cancel books the first attempt's spend once; the row keeps it", async () => {
    vi.mocked(classify).mockReturnValueOnce({
      agentType: "nanoclaw",
      score: 5,
      reason: "coding",
      explicit: false,
      modelTier: "standard",
    } as unknown as ReturnType<typeof classify>);
    registerRunner({
      type: "nanoclaw",
      execute: async () =>
        ({ success: false, tokenUsage: { promptTokens: 10, completionTokens: 5 } }) as RunnerOutput,
    });
    let fallbackStarted = false;
    registerRunner({
      type: "fast",
      execute: async (input) => {
        fallbackStarted = true;
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("This operation was aborted");
      },
    });
    const { taskId } = await submitTask({
      title: "misrouted chat",
      description: "d",
      tags: ["messaging"],
    });
    await vi.waitFor(() => {
      if (!fallbackStarted) throw new Error("fallback not started");
    });
    cancelRunning(taskId);
    await vi.waitFor(settled);

    expectCancelledClose();
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordCost).mock.calls[0][0]).toMatchObject({
      agentType: "nanoclaw",
      promptTokens: 10,
      completionTokens: 5,
    });
    const cancelledRow = mockRun.mock.calls
      .map((c) => c[0] as Record<string, unknown> | undefined)
      .find((p) => p?.runId !== undefined && "tokenUsage" in p && !("status" in p));
    expect(JSON.parse(String(cancelledRow!.tokenUsage))).toEqual({
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(busNames()).toEqual(["task.created", "task.cancelled"]);
  });

  it.each([
    ["first attempt (would submit a retry task)", false],
    ["retry attempt (would raise the warning)", true],
  ])(
    "required tools missing on a cancelled task, %s: no retry, no warning, cancelled close",
    async (_label, isRetry) => {
      let idSeen = "";
      registerRunner({
        type: "fast",
        execute: async (input) => {
          idSeen = input.taskId;
          return {
            success: true,
            status: "DONE",
            output: "ok",
            toolCalls: ["file_read"],
            durationMs: 1,
          } as RunnerOutput;
        },
      });
      // The first read (right after the runner) sees the task running; the
      // row is cancelled by the time the required-tools check acts.
      let reads = 0;
      installStatusRow((id) => ({
        status: id === idSeen && ++reads > 1 ? "cancelled" : "running",
      }));
      await submitTask({
        title: "needs a search",
        description: "d",
        requiredTools: ["web_search"],
        ...(isRetry && { _isRequiredToolRetry: true }),
      });
      await vi.waitFor(settled);

      expectCancelledClose();
      expect(busNames()).toEqual(["task.created", "task.cancelled"]);
      expect(busNames()).not.toContain("notification.warning");
      const inserts = mockPrepare.mock.calls
        .map((c) => String(c[0]))
        .filter((q) => q.includes("INSERT INTO tasks"));
      expect(inserts).toHaveLength(1); // the task itself, no retry task
    },
  );

  it.each([
    [true, "task.completed", "completed"],
    [false, "task.failed", "failed"],
  ])(
    "not cancelled (success=%s): run row, timeline and bus order unchanged",
    async (success, terminal, runStatus) => {
      registerRunner({
        type: "fast",
        execute: async () =>
          ({
            success,
            output: "ok",
            ...(success ? {} : { error: "boom" }),
            tokenUsage: { promptTokens: 5, completionTokens: 1 },
            durationMs: 1,
          }) as RunnerOutput,
      });
      await submitTask({ title: "plain", description: "d" });
      await vi.waitFor(() => {
        if (!busNames().includes(terminal)) throw new Error("no terminal yet");
      });
      expect(busNames()).toEqual(["task.created", terminal]);
      expect(emitTraceMock.mock.calls.map((c) => c[0].name)).toEqual([
        "attribution.resolved",
        "task.started",
        "numbers.audited", // the completion ledger's own row
        terminal,
      ]);
      expect(runStatuses()).toEqual([runStatus]);
      expect(runWrites().some((q) => CANCELLED_RUN.test(q))).toBe(false);
      // The spend is booked before the terminal timeline row, which comes
      // before the terminal bus event.
      expect(recordCost).toHaveBeenCalledTimes(1);
      const costAt = vi.mocked(recordCost).mock.invocationCallOrder[0];
      const traceAt =
        emitTraceMock.mock.invocationCallOrder[
          emitTraceMock.mock.calls.findIndex((c) => c[0].name === terminal)
        ];
      const busAt =
        emitEventMock.mock.invocationCallOrder[
          emitEventMock.mock.calls.findIndex((c) => c[0] === terminal)
        ];
      expect(costAt).toBeLessThan(traceAt);
      expect(traceAt).toBeLessThan(busAt);
    },
  );
});

// 2026-09-29: the fast runner's DENUE guard reads ONLY the text the user (or
// the schedule author) wrote — dropping this forward silently reverts every
// chat and schedule to the title+description fallback.
describe("dispatchTask forwards detectionText to the runner", () => {
  it("submission.detectionText → RunnerInput.detectionText", async () => {
    let seen: string | undefined = "unset";
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seen = input.detectionText;
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({
      title: "Chat: hola",
      description: "persona + injected context",
      detectionText: "consulta DENUE farmacias en Puebla",
    });
    await vi.waitFor(() => {
      if (seen === "unset") throw new Error("runner not yet executed");
    });
    expect(seen).toBe("consulta DENUE farmacias en Puebla");
  });
});

// jarvis-pull: dropping this forward silently turns an external request back
// into an operator chat turn (JME + essentials injected, no round cap).
describe("dispatchTask forwards external to the runner", () => {
  it("submission.external → RunnerInput.external", async () => {
    let seen: unknown = "unset";
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seen = input.external;
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({
      title: "CRM jarvis-pull: q",
      description: "persona",
      agentType: "fast",
      external: { maxRounds: 8 },
    });
    await vi.waitFor(() => {
      if (seen === "unset") throw new Error("runner not yet executed");
    });
    expect(seen).toEqual({ maxRounds: 8 });
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

// Confirmation gate (audit 2026-09-30 C2/W3): the SDK gate reads the run's
// execution context — it must exist around EVERY runner, carry the right
// facts per population, and never let a sub-task or retry ask.
describe("dispatchTask confirmation-gate context", () => {
  type Facts = Pick<
    TaskExecutionContext,
    | "taskId"
    | "interactive"
    | "routerRoot"
    | "canAskOperator"
    | "chatOrigin"
    | "a2aOrigin"
    | "unattended"
  >;
  const seen = new Map<string, Facts | undefined>();
  const facts = (ctx: TaskExecutionContext | undefined): Facts | undefined =>
    ctx && {
      taskId: ctx.taskId,
      interactive: ctx.interactive,
      routerRoot: ctx.routerRoot,
      canAskOperator: ctx.canAskOperator,
      chatOrigin: ctx.chatOrigin,
      a2aOrigin: ctx.a2aOrigin,
      unattended: ctx.unattended,
    };
  let spawn: ((title: string) => Promise<void>) | null = null;

  beforeEach(() => {
    seen.clear();
    spawn = null;
    mockRun.mockReturnValue({ changes: 1 });
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seen.set(input.title, facts(currentExecutionContext()));
        if (spawn) await spawn(input.title);
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
  });

  async function runAll(
    subs: Array<Parameters<typeof submitTask>[0]>,
  ): Promise<void> {
    for (const sub of subs) await submitTask(sub);
    await vi.waitFor(() => {
      if (seen.size < subs.length) throw new Error("runners not yet executed");
    });
  }

  it("every population runs inside its own gate context with the right facts; background stays non-interactive", async () => {
    const chat = {
      threadId: "telegram:42",
      replyTracked: true,
      tags: ["messaging", "telegram"],
    };
    await runAll([
      { title: "chat-root", description: "d", ...chat },
      {
        title: "ritual",
        description: "d",
        interactive: false,
        ritualId: "morning-briefing",
      },
      {
        title: "scheduled",
        description: "d",
        interactive: false,
        tags: ["scheduled"],
      },
      { title: "cron-autonomous", description: "d", interactive: false },
      {
        title: "ritual-reaction-retry",
        description: "d",
        interactive: false,
        ritualId: "r",
        tags: ["ritual-retry"],
      },
      { title: "api", description: "d" },
      { title: "a2a", description: "d", interactive: true, tags: ["a2a"] },
      {
        title: "non-owner-chat",
        description: "d",
        tags: ["messaging", "whatsapp"],
        replyTracked: true,
      },
      // A reaction retry of a chat task: the router does not track it.
      {
        title: "chat-reaction-retry",
        description: "d",
        threadId: "telegram:42",
        tags: ["messaging"],
      },
      {
        title: "chat-required-tool-retry",
        description: "d",
        ...chat,
        _isRequiredToolRetry: true,
        retryCount: 1,
      },
      // Each retry marker alone also keeps the run from asking.
      {
        title: "chat-retry-flag-only",
        description: "d",
        ...chat,
        _isRequiredToolRetry: true,
      },
      {
        title: "chat-retry-count-only",
        description: "d",
        ...chat,
        retryCount: 1,
      },
      { title: "chat-subtask", description: "d", ...chat, parentTaskId: "p-1" },
    ]);
    const f = (title: string) => {
      const got = seen.get(title);
      expect(got, title).toBeDefined();
      expect(got!.canAskOperator, title).toBe(false); // the dispatcher's own context never asks
      return got!;
    };
    expect(f("chat-root")).toMatchObject({
      interactive: true,
      routerRoot: true,
      chatOrigin: true,
    });
    for (const bg of [
      "ritual",
      "scheduled",
      "cron-autonomous",
      "ritual-reaction-retry",
    ]) {
      expect(f(bg), bg).toMatchObject({
        interactive: false,
        routerRoot: false,
      });
    }
    expect(f("api")).toMatchObject({
      interactive: true,
      routerRoot: false,
      chatOrigin: false,
      a2aOrigin: false,
    });
    expect(f("a2a")).toMatchObject({
      interactive: true,
      routerRoot: false,
      chatOrigin: false,
      a2aOrigin: true,
    });
    expect(f("non-owner-chat")).toMatchObject({
      interactive: true,
      routerRoot: false,
      chatOrigin: true,
    });
    for (const t of [
      "chat-reaction-retry",
      "chat-required-tool-retry",
      "chat-retry-flag-only",
      "chat-retry-count-only",
      "chat-subtask",
    ]) {
      expect(f(t), t).toMatchObject({
        interactive: true,
        routerRoot: false,
        chatOrigin: true,
      });
    }
    expect(currentExecutionContext()).toBeUndefined(); // no leak out of the run
  });

  it("W-A: the nanoclaw→fast fallback runs inside the same gate context (routerRoot + chatOrigin)", async () => {
    vi.mocked(classify).mockReturnValueOnce({
      agentType: "nanoclaw",
      score: 5,
      reason: "coding",
      explicit: false,
      modelTier: "standard",
    } as unknown as ReturnType<typeof classify>);
    const nano: Array<Facts | undefined> = [];
    registerRunner({
      type: "nanoclaw",
      // A no-op sandbox failure (no error) → the in-process fast fallback.
      execute: async () => {
        nano.push(facts(currentExecutionContext()));
        return { success: false } as RunnerOutput;
      },
    });
    await runAll([
      {
        title: "misrouted-chat",
        description: "d",
        threadId: "telegram:42",
        replyTracked: true,
        tags: ["messaging", "telegram"],
      },
    ]);
    expect(nano).toHaveLength(1);
    const expected = {
      taskId: nano[0]!.taskId,
      interactive: true,
      routerRoot: true,
      chatOrigin: true,
      canAskOperator: false,
      a2aOrigin: false,
      unattended: false,
    };
    expect(nano[0]).toEqual(expected);
    expect(seen.get("misrouted-chat")).toEqual(expected); // the fast fallback
    expect(emitTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task.fallback" }),
    );
  });

  it("the failed attempt's cost row cannot be written → the fallback still runs and mc_write_failures_total{site=cost_attempt} went up by one", async () => {
    const attemptCount = async () =>
      (await client.register.getSingleMetric("mc_write_failures_total")?.get())?.values.find(
        (v) => v.labels.site === "cost_attempt",
      )?.value ?? 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(classify).mockReturnValueOnce({
      agentType: "nanoclaw",
      score: 5,
      reason: "coding",
      explicit: false,
      modelTier: "standard",
    } as unknown as ReturnType<typeof classify>);
    registerRunner({
      type: "nanoclaw",
      // A no-op sandbox failure that spent tokens → its attempt row is written.
      execute: async () =>
        ({ success: false, tokenUsage: { promptTokens: 10, completionTokens: 5 } }) as RunnerOutput,
    });
    // The first cost row is the attempt's (the fast fallback reports no usage).
    vi.mocked(recordCost).mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    const before = await attemptCount();
    await runAll([
      {
        title: "misrouted-chat-cost",
        description: "d",
        threadId: "telegram:42",
        replyTracked: true,
        tags: ["messaging", "telegram"],
      },
    ]);
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordCost).mock.calls[0][0]).toMatchObject({
      agentType: "nanoclaw",
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(seen.has("misrouted-chat-cost")).toBe(true); // the fast fallback ran
    expect(emitTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task.fallback" }),
    );
    expect(await attemptCount()).toBe(before + 1);
  });

  it("a sub-task inherits interactive=false and chat origin from the submitting run, never routerRoot", async () => {
    spawn = async (title) => {
      if (title === "ritual-parent") {
        await submitTask({ title: "ritual-child", description: "d" });
      } else if (title === "chat-parent") {
        await submitTask({
          title: "chat-child",
          description: "d",
          parentTaskId: "p",
        });
      } else if (title === "ritual-parent-detached") {
        // N1: a task spawned OUTSIDE the run context starts fresh.
        await outsideRunToolContext(() =>
          submitTask({ title: "detached-child", description: "d" }),
        );
      }
    };
    await runAll([
      {
        title: "ritual-parent",
        description: "d",
        interactive: false,
        ritualId: "r",
      },
      {
        title: "chat-parent",
        description: "d",
        threadId: "telegram:1",
        replyTracked: true,
        tags: ["messaging"],
      },
      {
        title: "ritual-parent-detached",
        description: "d",
        interactive: false,
        ritualId: "r",
      },
    ]);
    await vi.waitFor(() => {
      if (seen.size < 6) throw new Error("children not yet executed");
    });
    expect(seen.get("ritual-child")).toMatchObject({
      interactive: false,
      routerRoot: false,
    });
    expect(seen.get("chat-child")).toMatchObject({
      interactive: true,
      routerRoot: false,
      chatOrigin: true,
    });
    expect(seen.get("detached-child")).toMatchObject({
      interactive: true,
      chatOrigin: false,
    });
  });
});

describe("dispatchTask unattended fact (qa R4 W1)", () => {
  const seen = new Map<string, TaskExecutionContext | undefined>();

  beforeEach(() => {
    seen.clear();
    mockRun.mockReturnValue({ changes: 1 });
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seen.set(input.title, currentExecutionContext());
        if (input.title === "bg-agent") {
          await submitTask({ title: "bg-child", description: "d", parentTaskId: "p" });
        }
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
  });

  it("a user-background agent (router shape) and its sub-task are unattended; either marker alone suffices; a chat root is attended", async () => {
    // Same shape as the router's background-agent submission (router.ts).
    await submitTask({
      title: "bg-agent",
      description: "d",
      spawnType: "user-background",
      tags: ["messaging", "telegram", "background-agent"],
      threadId: "telegram:42",
      interactive: true,
      replyTracked: true,
    });
    await submitTask({
      title: "spawntype-only",
      description: "d",
      spawnType: "user-background",
      threadId: "telegram:42",
      replyTracked: true,
    });
    await submitTask({
      title: "tag-only",
      description: "d",
      tags: ["background-agent"],
      threadId: "telegram:42",
      replyTracked: true,
    });
    await submitTask({
      title: "chat-root",
      description: "d",
      tags: ["messaging", "telegram"],
      threadId: "telegram:42",
      replyTracked: true,
    });
    await vi.waitFor(() => {
      if (seen.size < 5) throw new Error("runners not yet executed");
    });
    // routerRoot alone would let the agent pass operator-only checks.
    expect(seen.get("bg-agent")).toMatchObject({ routerRoot: true, unattended: true });
    expect(seen.get("spawntype-only")).toMatchObject({ unattended: true });
    expect(seen.get("tag-only")).toMatchObject({ unattended: true });
    expect(seen.get("bg-child")).toMatchObject({ routerRoot: false, unattended: true });
    expect(seen.get("chat-root")).toMatchObject({ routerRoot: true, unattended: false });
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
    // S6 WS2: the insert-time attribution trace precedes the run.
    expect(names.slice(0, 2)).toEqual(["attribution.resolved", "task.started"]);
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
    stubRunner({ success: false, error: "no scope" });
    const names = await traceNamesAfterDispatch();
    expect(
      names.filter((n) => n !== "task.started" && n !== "attribution.resolved"),
    ).toEqual(["task.failed"]);
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.attrs).toMatchObject({ status: "failed", error: "no scope" });
  });

  // V8.1 gate instrumentation (ruling 2026-10-06): the reason CODE from
  // classifyConcernReason rides the terminal trace event.
  const terminalEvent = () => {
    const events = emitTraceMock.mock.calls.map((c) => c[0]);
    return events.filter((e) => e.name === "task.completed" || e.name === "task.failed").at(-1)!;
  };

  it("task.completed carries concern_reason for a DONE_WITH_CONCERNS run", async () => {
    stubRunner({
      success: true,
      status: "DONE_WITH_CONCERNS",
      output: "partial synthetic report; stopped at error_max_turns",
    });
    await traceNamesAfterDispatch();
    const terminal = terminalEvent();
    expect(terminal.name).toBe("task.completed");
    expect(terminal.attrs).toMatchObject({
      status: "completed_with_concerns",
      concern_reason: "max_turns",
    });
  });

  it("concern-flagged run with no defect marker classifies as partial", async () => {
    stubRunner({ success: true, status: "DONE_WITH_CONCERNS", output: "synthetic caveat" });
    await traceNamesAfterDispatch();
    expect(terminalEvent().attrs.concern_reason).toBe("partial");
  });

  it("clean run carries concern_reason \"none\"", async () => {
    stubRunner({ success: true, output: "done" });
    await traceNamesAfterDispatch();
    const terminal = terminalEvent();
    expect(terminal.attrs).toMatchObject({ status: "completed", concern_reason: "none" });
  });

  it("concern_reason is the code only: no output / concern text reaches attrs", async () => {
    stubRunner({
      success: true,
      status: "DONE_WITH_CONCERNS",
      output: "SYNTHETIC-OUTPUT-TEXT",
      concerns: ["SYNTHETIC-CONCERN-TEXT"],
    });
    await traceNamesAfterDispatch();
    const attrs = terminalEvent().attrs;
    expect(attrs.concern_reason).toBe("partial");
    const serialized = JSON.stringify(attrs);
    expect(serialized).not.toContain("SYNTHETIC-OUTPUT-TEXT");
    expect(serialized).not.toContain("SYNTHETIC-CONCERN-TEXT");
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

  it("runs.input stores title + description length, not a second copy of the description (audit 2026-09-22)", async () => {
    mockRun.mockReturnValue({ changes: 1 });
    registerRunner({
      type: "fast",
      execute: async () => ({ success: true, output: "ok" }) as RunnerOutput,
    });
    const description = "x".repeat(5000);
    await submitTask({ title: "dup-check", description });
    const runInsert = mockRun.mock.calls
      .map((c) => c[0] as Record<string, unknown> | undefined)
      .find((a) => a && typeof a.runId === "string" && "input" in a);
    expect(runInsert).toBeDefined();
    const stored = JSON.parse(runInsert!.input as string);
    expect(stored).toEqual({ title: "dup-check", descriptionChars: 5000 });
    expect((runInsert!.input as string).length).toBeLessThan(100);
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

// ---------------------------------------------------------------------------
// Durable-sink credential redaction (Hermes 4e740313 port, 2026-10-01)
// ---------------------------------------------------------------------------

describe("dispatchTask redacts credentials in runs.output / runs.error / tasks.error", () => {
  // Built at runtime — no key-shaped literal in the (public) repo.
  const SECRET = "sk-" + "a".repeat(24);

  async function dispatchWith(execute: () => Promise<RunnerOutput>) {
    registerRunner({ type: "fast", execute });
    await submitTask({ title: "Redact me", description: "redaction spec" });
    await vi.waitFor(() => {
      const names = emitTraceMock.mock.calls.map((c) => c[0].name);
      if (!names.some((n) => n === "task.completed" || n === "task.failed")) {
        throw new Error("no terminal trace event yet");
      }
    });
  }

  /** The `UPDATE runs SET status = @status, …` named-parameter write. */
  function runsUpdate(): { output: string | null; error: string | null } {
    const call = mockRun.mock.calls.find(
      (c) => c[0] && typeof c[0] === "object" && "runnerStatus" in c[0],
    );
    expect(call).toBeDefined();
    return call![0] as { output: string | null; error: string | null };
  }

  it("failed result: runs.error and tasks.error carry the token, never the raw key", async () => {
    await dispatchWith(
      async () =>
        ({ success: false, error: `provider 401 ${SECRET}` }) as RunnerOutput,
    );
    expect(runsUpdate().error).toBe("provider 401 [REDACTED_KEY]");
    const flat = mockRun.mock.calls.flat();
    expect(
      flat.some(
        (a) =>
          typeof a === "string" && a.includes("provider 401 [REDACTED_KEY]"),
      ),
    ).toBe(true);
    expect(JSON.stringify(mockRun.mock.calls)).not.toContain(SECRET);
  });

  // A fixed-length key rule (AIza + 35) misses a key cut by .slice(0, 300),
  // so the trace attrs must be redacted BEFORE the cut.
  const AIZA = "AIza" + "b".repeat(35);
  const straddle = "x".repeat(289) + " " + AIZA; // key spans 290..328

  it("failed result: trace attrs error is redacted before the 300-char cut", async () => {
    await dispatchWith(
      async () => ({ success: false, error: straddle }) as RunnerOutput,
    );
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.name).toBe("task.failed");
    expect(terminal.attrs.error).not.toMatch(/AIza|bbbbb/);
  });

  it("runner throw: trace attrs error is redacted before the 300-char cut", async () => {
    await dispatchWith(async () => {
      throw new Error(straddle);
    });
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).at(-1)!;
    expect(terminal.attrs.thrown).toBe(true);
    expect(terminal.attrs.error).not.toMatch(/AIza|bbbbb/);
  });

  it("required-tools concern is redacted before its 200-char cut", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({
          success: true,
          status: "DONE_WITH_CONCERNS",
          concerns: ["y".repeat(189) + " " + AIZA],
          output: "x",
          durationMs: 0,
          toolCalls: [],
        }) as RunnerOutput,
    });
    await submitTask({
      title: "PM daily rebalance",
      description: "rebalance",
      requiredTools: ["pm_paper_rebalance"],
      _isRequiredToolRetry: true,
    });
    await vi.waitFor(() => {
      if (
        !mockRun.mock.calls.some((c) =>
          c.some((a) => typeof a === "string" && a.includes("— runner: yyy")),
        )
      )
        throw new Error("failed-status write not seen yet");
    });
    expect(JSON.stringify(mockRun.mock.calls)).not.toMatch(/AIza|bbbbb/);
  });

  it("task.started trace title is redacted BEFORE its 120-char cut", async () => {
    registerRunner({
      type: "fast",
      execute: async () => ({ success: true, output: "ok" }) as RunnerOutput,
    });
    await submitTask({
      title: "x".repeat(99) + " " + AIZA, // key spans 100..138
      description: "title cut spec",
    });
    await vi.waitFor(() => {
      if (!emitTraceMock.mock.calls.some((c) => c[0].name === "task.started"))
        throw new Error("no task.started yet");
    });
    const started = emitTraceMock.mock.calls
      .map((c) => c[0])
      .find((e) => e.name === "task.started")!;
    expect(started.attrs.title).toContain("[REDACTED");
    expect(started.attrs.title).not.toMatch(/AIza|bbbbb/);
  });

  it("runner throw: the catch-path runs.error and tasks.error are redacted", async () => {
    await dispatchWith(async () => {
      throw new Error(`boom ${SECRET}`);
    });
    expect(
      mockRun.mock.calls.some(
        (c) => (c[0] as { error?: string })?.error === "boom [REDACTED_KEY]",
      ),
    ).toBe(true);
    expect(JSON.stringify(mockRun.mock.calls)).not.toContain(SECRET);
  });

  it("completed: runs.output redacted except pendingConfirmation; tasks.output verbatim", async () => {
    const output = {
      finalAnswer: `here ${SECRET}`,
      toolCalls: ["shell_exec"],
      pendingConfirmation: {
        toolName: "shell_exec",
        args: { command: `curl -H "x-api-key: ${SECRET}" https://example.com` },
      },
    };
    const trace = [{ type: "phase_error", error: `Error: 401 ${SECRET}` }];
    await dispatchWith(
      async () => ({ success: true, output, trace }) as unknown as RunnerOutput,
    );
    // runs.trace (Prometheus phase_error text) is redacted like runs.error.
    const storedTrace = (runsUpdate() as unknown as { trace: string }).trace;
    expect(JSON.parse(storedTrace)).toEqual([
      { type: "phase_error", error: "Error: 401 [REDACTED_KEY]" },
    ]);
    const stored = JSON.parse(runsUpdate().output!);
    expect(stored.finalAnswer).toBe("here [REDACTED_KEY]");
    expect(stored.toolCalls).toEqual(["shell_exec"]);
    // The router executes these args on the operator's "sí" — byte-identical.
    expect(stored.pendingConfirmation).toEqual(output.pendingConfirmation);
    // tasks.output stays raw: swarm parents deliver child tasks.output.
    expect(
      mockRun.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(`here ${SECRET}`),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mailbox-password store rule (store-withhold.ts): a value the mailbox tool
// printed is stored as the placeholder in every task and run column that
// holds text; the runner and the bus get the value as it came (delivery is
// decided by the reply check, not here). pendingConfirmation stays verbatim.
// ---------------------------------------------------------------------------

describe("dispatchTask: mailbox-password store rule on task and run rows", () => {
  const PW = "FakeTestPassWordXYZ2345";
  const P = PASSWORD_WITHHELD_PLACEHOLDER;
  beforeEach(() => {
    const fp = passwordFingerprint(PW);
    setStoreSeenCheck({ size: () => 1, has: (f) => f === fp });
  });
  afterEach(() => {
    _resetStoreWithhold();
    ledgerHook.before = undefined;
  });

  const runsUpdate = () =>
    mockRun.mock.calls.find(
      (c) => c[0] && typeof c[0] === "object" && "runnerStatus" in c[0],
    )?.[0] as Record<string, string | null> | undefined;
  const terminal = () => {
    const names = emitTraceMock.mock.calls.map((c) => c[0].name);
    if (!names.some((n) => n === "task.completed" || n === "task.failed" || n === "task.cancelled"))
      throw new Error("not terminal yet");
  };

  it("submit: the task row's title, description and input, and the run row's title, hold the placeholder; the runner gets the value", async () => {
    let seen = "";
    registerRunner({
      type: "fast",
      execute: async (input) => {
        seen = input.description;
        return { success: true, output: "ok" } as RunnerOutput;
      },
    });
    await submitTask({
      title: `Buzón ${PW}`,
      description: `entra con ${PW}`,
      input: { note: `contraseña ${PW}`, n: 3 },
    });
    await vi.waitFor(terminal);
    const insert = mockRun.mock.calls[0]![0] as Record<string, string>;
    expect(insert.title).toBe(`Buzón ${P}`);
    expect(insert.description).toBe(`entra con ${P}`);
    expect(JSON.parse(insert.input!)).toEqual({ note: `contraseña ${P}`, n: 3 });
    const runInsert = mockRun.mock.calls
      .map((c) => c[0] as Record<string, string> | undefined)
      .find((a) => a && typeof a === "object" && "agentType" in a && "runId" in a && "input" in a)!;
    expect(JSON.parse(runInsert.input!).title).toBe(`Buzón ${P}`);
    expect(seen).toBe(`entra con ${PW}`);
    expect(JSON.stringify(mockRun.mock.calls)).not.toContain(PW);
  });

  it("completed: tasks.output, runs.output, runs.trace and runs.goal_graph hold the placeholder; the bus result and pendingConfirmation keep the value", async () => {
    const pendingConfirmation = { toolName: "gmail_send", args: { body: `clave ${PW}` } };
    const goalGraph = { goals: { "g-1": { id: "g-1", description: `entra con ${PW}`, dependsOn: [] } } };
    registerRunner({
      type: "fast",
      execute: async () =>
        ({
          success: true,
          output: { finalAnswer: `contraseña: ${PW}`, pendingConfirmation },
          trace: [{ type: "note", text: `vi ${PW}` }],
          goalGraph,
        }) as unknown as RunnerOutput,
    });
    await submitTask({ title: "store rule", description: "d" });
    await vi.waitFor(terminal);
    const run = runsUpdate()!;
    const out = JSON.parse(run.output!);
    expect(out.finalAnswer).toBe(`contraseña: ${P}`);
    expect(out.pendingConfirmation).toEqual(pendingConfirmation);
    expect(run.trace).not.toContain(PW);
    expect(JSON.parse(run.goalGraph!).goals["g-1"].description).toBe(`entra con ${P}`);
    expect(JSON.parse(run.goalGraph!).goals["g-1"].id).toBe("g-1");
    const taskOutput = mockRun.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a === "string" && a.includes('"finalAnswer"')) as string;
    expect(JSON.parse(taskOutput).finalAnswer).toBe(`contraseña: ${P}`);
    const completed = emitEventMock.mock.calls.find((c) => c[0] === "task.completed")!;
    expect(JSON.stringify(completed[1])).toContain(`contraseña: ${PW}`);
  });

  it("submit: a value inside an array of the input is stored as the placeholder", async () => {
    registerRunner({
      type: "fast",
      execute: async () => ({ success: true, output: "ok" }) as RunnerOutput,
    });
    await submitTask({ title: "lista", description: "d", input: { list: ["a " + PW] } });
    await vi.waitFor(terminal);
    const insert = mockRun.mock.calls[0]![0] as Record<string, string>;
    expect(JSON.parse(insert.input!)).toEqual({ list: [`a ${P}`] });
  });

  it("completed: every string of the goal graph is withheld, whatever its key or depth", async () => {
    const goalGraph = {
      goals: {
        "g-1": {
          id: "g-1",
          description: "revisar",
          completionCriteria: ["usa " + PW],
          metadata: { note: PW },
        },
      },
    };
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: true, output: "ok", goalGraph }) as unknown as RunnerOutput,
    });
    await submitTask({ title: "grafo", description: "d" });
    await vi.waitFor(terminal);
    const stored = JSON.parse(runsUpdate()!.goalGraph!);
    expect(stored.goals["g-1"].completionCriteria).toEqual([`usa ${P}`]);
    expect(stored.goals["g-1"].metadata).toEqual({ note: P });
    expect(JSON.stringify(stored)).not.toContain(PW);
  });

  it("failed: tasks.output and tasks.error hold the placeholder", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({ success: false, error: `falló con ${PW}`, output: { finalAnswer: `intenté ${PW}` } }) as unknown as RunnerOutput,
    });
    await submitTask({ title: "store rule failed", description: "d" });
    await vi.waitFor(terminal);
    const flat = mockRun.mock.calls.flat().filter((a) => typeof a === "string") as string[];
    expect(flat).toContain(`falló con ${P}`);
    expect(flat.some((a) => a.includes(`"intenté ${P}"`))).toBe(true);
    expect(JSON.stringify(mockRun.mock.calls)).not.toContain(PW);
  });

  it("cancelled close: the cancelled run row's output and error hold the placeholder", async () => {
    registerRunner({
      type: "fast",
      execute: async () =>
        ({
          success: true,
          status: "DONE",
          output: `contraseña: ${PW}`,
          error: `nota ${PW}`,
          durationMs: 1,
        }) as RunnerOutput,
    });
    ledgerHook.before = async ({ taskId }) => {
      mockGet.mockReturnValueOnce({ task_id: taskId, status: "running" });
      mockAll.mockReturnValueOnce([]);
      expect(cancelTask(taskId)).toBe(true);
    };
    await submitTask({ title: "store rule cancelled", description: "d" });
    await vi.waitFor(terminal);
    const cancelledRun = mockRun.mock.calls
      .map((c) => c[0] as Record<string, string | null> | undefined)
      .find((a) => a && typeof a === "object" && "durationMs" in a && !("runnerStatus" in a))!;
    expect(JSON.parse(cancelledRun.output!)).toBe(`contraseña: ${P}`);
    expect(cancelledRun.error).toBe(`nota ${P}`);
    expect(JSON.stringify(mockRun.mock.calls)).not.toContain(PW);
  });

  it("cancelled close: pendingConfirmation stays verbatim, the other output text is withheld", async () => {
    const pendingConfirmation = { toolName: "gmail_send", args: { body: PW } };
    registerRunner({
      type: "fast",
      execute: async () =>
        ({
          success: true,
          status: "DONE",
          output: { pendingConfirmation, text: PW },
          durationMs: 1,
        }) as unknown as RunnerOutput,
    });
    ledgerHook.before = async ({ taskId }) => {
      mockGet.mockReturnValueOnce({ task_id: taskId, status: "running" });
      mockAll.mockReturnValueOnce([]);
      expect(cancelTask(taskId)).toBe(true);
    };
    await submitTask({ title: "store rule cancelled keep", description: "d" });
    await vi.waitFor(terminal);
    const cancelledRun = mockRun.mock.calls
      .map((c) => c[0] as Record<string, string | null> | undefined)
      .find((a) => a && typeof a === "object" && "durationMs" in a && !("runnerStatus" in a))!;
    const out = JSON.parse(cancelledRun.output!);
    expect(out.pendingConfirmation).toEqual(pendingConfirmation);
    expect(out.text).toBe(P);
  });
});

// ---------------------------------------------------------------------------
// Operator ruling 2026-10-03: in a NON-interactive run, a batch_decompose
// child may not use a high-risk tool / carrier the run did not declare.
// ---------------------------------------------------------------------------

describe("background batch child: undeclared high-risk tools (ruling 2026-10-03)", () => {
  const registry = {
    getEffectiveRiskTier: (n: string): "low" | "medium" | "high" =>
      n === "gmail_send" ? "high" : "low",
    has: () => true,
    get: () => undefined,
    execute: vi.fn(async () => JSON.stringify({ ok: true })),
  } as unknown as ToolRegistry;
  const outcome = new Map<string, string>();
  const childIds = new Map<string, string>();
  const ctxs = new Map<string, TaskExecutionContext | undefined>();
  /** What each child's runner calls (title → tool). */
  let childCalls: Record<string, string> = {};

  beforeEach(() => {
    outcome.clear();
    childIds.clear();
    ctxs.clear();
    childCalls = {};
    vi.mocked(recordRitualFailure).mockClear();
    mockRun.mockReturnValue({ changes: 1 });
    registerRunner({
      type: "fast",
      execute: async (input) => {
        ctxs.set(input.title, currentExecutionContext());
        if (input.title.startsWith("root")) {
          // batch_decompose's submission shape (batch.ts): the child's own
          // `tools` is model-chosen — it may name gmail_send; it is not the
          // run's declared set.
          const sub = await submitTask({
            title: `child-of-${input.title}`,
            description: "d",
            agentType: "fast",
            tools: ["gmail_send"],
            tags: ["batch", "chunk:1/1"],
          });
          childIds.set(`child-of-${input.title}`, sub.taskId);
          return { success: true, output: "root ok" } as RunnerOutput;
        }
        if (input.title.startsWith("child-of-root-nested")) {
          const sub = await submitTask({
            title: "grandchild",
            description: "d",
            agentType: "fast",
            tools: ["gmail_send"],
            tags: ["batch"],
          });
          childIds.set("grandchild", sub.taskId);
        }
        const tool = childCalls[input.title] ?? "gmail_send";
        // The fast runner's own context (shares the dispatcher's sink).
        const ctx = runnerExecutionContext(input.taskId, true);
        outcome.set(input.title, await createTaskExecutor(registry, ctx)(tool, { to: "user5@example.com" }));
        return { success: true, output: "child ok" } as RunnerOutput;
      },
    });
  });

  async function runRoot(sub: Parameters<typeof submitTask>[0], expected: string[]) {
    await submitTask(sub);
    await vi.waitFor(() => {
      for (const t of expected) if (!outcome.has(t)) throw new Error(`${t} not yet run`);
    });
    await vi.waitFor(() => {
      for (const t of expected) {
        const id = childIds.get(t)!;
        if (!emitTraceMock.mock.calls.some((c) => c[0].taskId === id && /^task\.(failed|completed)$/.test(c[0].name)))
          throw new Error(`${t} not settled`);
      }
    });
  }
  const finalOf = (title: string) =>
    emitTraceMock.mock.calls
      .map((c) => c[0] as { taskId: string; name: string; attrs?: Record<string, unknown>; tool?: string })
      .filter((e) => e.taskId === childIds.get(title));

  const scheduled = (title: string, tools: string[]) => ({
    title,
    description: "d",
    interactive: false,
    tools,
    tags: ["scheduled", "schedule:sch-1"],
  });

  it("an undeclared gmail_send is refused at the child's gate; the child FAILS and the schedule gets the failure", async () => {
    await runRoot(scheduled("root-undeclared", ["web_search", "batch_decompose"]), ["child-of-root-undeclared"]);
    expect(JSON.parse(outcome.get("child-of-root-undeclared")!)).toEqual({
      error: undeclaredToolError("gmail_send"),
    });
    expect(registry.execute).not.toHaveBeenCalled();
    const ctx = ctxs.get("child-of-root-undeclared")!;
    expect(ctx.inheritedDeclaredTools).toEqual(["web_search", "batch_decompose"]);
    expect(ctx.originScheduleId).toBe("sch-1");
    const events = finalOf("child-of-root-undeclared");
    expect(events).toContainEqual(
      expect.objectContaining({ name: "tool.gated", tool: "gmail_send", attrs: { decision: "refused_undeclared" } }),
    );
    expect(events.map((e) => e.name)).toContain("task.failed");
    expect(events.map((e) => e.name)).not.toContain("task.completed");
    await vi.waitFor(() => expect(recordRitualFailure).toHaveBeenCalledTimes(1));
    expect(recordRitualFailure).toHaveBeenCalledWith(
      "sch-1",
      undeclaredRunFailure(["gmail_send"]),
      "execute",
    );
  });

  it("a declared gmail_send is allowed and the child completes", async () => {
    await runRoot(scheduled("root-declared", ["web_search", "gmail_send"]), ["child-of-root-declared"]);
    expect(JSON.parse(outcome.get("child-of-root-declared")!)).toEqual({ ok: true });
    expect(registry.execute).toHaveBeenCalledWith("gmail_send", { to: "user5@example.com" });
    const names = finalOf("child-of-root-declared").map((e) => e.name);
    expect(names).toContain("task.completed");
    expect(names).not.toContain("task.failed");
    expect(recordRitualFailure).not.toHaveBeenCalled();
  });

  it("chat is unchanged: a chat root's batch child carries no inherited limit and is never refused as undeclared", async () => {
    await runRoot(
      {
        title: "root-chat",
        description: "d",
        threadId: "telegram:42",
        replyTracked: true,
        tags: ["messaging", "telegram"],
        tools: ["web_search"],
      },
      ["child-of-root-chat"],
    );
    expect(ctxs.get("child-of-root-chat")!.inheritedDeclaredTools).toBeUndefined();
    expect(outcome.get("child-of-root-chat")).not.toContain(undeclaredToolError("gmail_send"));
    expect(
      emitTraceMock.mock.calls.some((c) => c[0].attrs?.decision === "refused_undeclared"),
    ).toBe(false);
    expect(recordRitualFailure).not.toHaveBeenCalled();
  });

  it("audit A1: a background root that declared NO tools gives its children an EMPTY allow-list — high-risk refused, low-risk unaffected", async () => {
    await runRoot(
      { title: "root-nolist", description: "d", interactive: false, tags: ["scheduled", "schedule:sch-1"] },
      ["child-of-root-nolist"],
    );
    expect(ctxs.get("child-of-root-nolist")!.inheritedDeclaredTools).toEqual([]);
    expect(JSON.parse(outcome.get("child-of-root-nolist")!)).toEqual({
      error: undeclaredToolError("gmail_send"),
    });
    expect(registry.execute).not.toHaveBeenCalled();
    const names = finalOf("child-of-root-nolist").map((e) => e.name);
    expect(names).toContain("task.failed");
    expect(names).not.toContain("task.completed");
    await vi.waitFor(() => expect(recordRitualFailure).toHaveBeenCalledTimes(1));
    expect(recordRitualFailure).toHaveBeenCalledWith("sch-1", undeclaredRunFailure(["gmail_send"]), "execute");

    // A low-risk tool in a child of the same kind of run still runs.
    vi.mocked(recordRitualFailure).mockClear();
    childCalls["child-of-root-nolist-low"] = "web_search";
    await runRoot(
      { title: "root-nolist-low", description: "d", interactive: false, tags: ["scheduled"] },
      ["child-of-root-nolist-low"],
    );
    expect(JSON.parse(outcome.get("child-of-root-nolist-low")!)).toEqual({ ok: true });
    expect(registry.execute).toHaveBeenCalledWith("web_search", { to: "user5@example.com" });
    expect(finalOf("child-of-root-nolist-low").map((e) => e.name)).toContain("task.completed");
    expect(recordRitualFailure).not.toHaveBeenCalled();
  });

  it("audit A1: an INTERACTIVE root that declared no tools leaves its children unrestricted (unchanged)", async () => {
    await runRoot({ title: "root-api-nolist", description: "d", interactive: true }, ["child-of-root-api-nolist"]);
    expect(ctxs.get("child-of-root-api-nolist")!.inheritedDeclaredTools).toBeUndefined();
    expect(outcome.get("child-of-root-api-nolist")).not.toContain(undeclaredToolError("gmail_send"));
    expect(
      emitTraceMock.mock.calls.some((c) => c[0].attrs?.decision === "refused_undeclared"),
    ).toBe(false);
    expect(recordRitualFailure).not.toHaveBeenCalled();
  });

  it("audit S3: background root → interactive:true child → interactive:false grandchild keeps the ROOT's list", () => {
    const root = gateContextFor("t-root", {
      title: "r",
      description: "d",
      interactive: false,
      tools: ["web_search"],
    });
    const child = runWithExecutionContext(root, () =>
      gateContextFor("t-child", { title: "c", description: "d", interactive: true, tools: ["gmail_send"] }),
    );
    expect(child.interactive).toBe(true);
    expect(child.inheritedDeclaredTools).toEqual(["web_search"]);
    const grandchild = runWithExecutionContext(child, () =>
      gateContextFor("t-grand", { title: "g", description: "d", interactive: false, tools: ["gmail_send"] }),
    );
    expect(grandchild.inheritedDeclaredTools).toEqual(["web_search"]);
    // A root (no parent) and an interactive root's child still set no limit.
    expect(root.inheritedDeclaredTools).toBeUndefined();
    const chatRoot = gateContextFor("t-chat", { title: "r", description: "d", interactive: true, tools: ["web_search"] });
    expect(
      runWithExecutionContext(chatRoot, () => gateContextFor("t-cc", { title: "c", description: "d" }))
        .inheritedDeclaredTools,
    ).toBeUndefined();
  });

  it("a nested carrier (batch_decompose) the run did not declare is refused; a grandchild keeps the ROOT's list", async () => {
    childCalls["child-of-root-nested"] = "batch_decompose";
    childCalls.grandchild = "gmail_send";
    await runRoot(scheduled("root-nested", ["web_search"]), ["child-of-root-nested", "grandchild"]);
    expect(JSON.parse(outcome.get("child-of-root-nested")!)).toEqual({
      error: undeclaredToolError("batch_decompose"),
    });
    expect(finalOf("child-of-root-nested").map((e) => e.name)).toContain("task.failed");
    // The grandchild's own `tools` (["gmail_send"]) does not widen the root's.
    expect(ctxs.get("grandchild")!.inheritedDeclaredTools).toEqual(["web_search"]);
    expect(ctxs.get("grandchild")!.originScheduleId).toBe("sch-1");
    expect(JSON.parse(outcome.get("grandchild")!)).toEqual({ error: undeclaredToolError("gmail_send") });
    expect(registry.execute).not.toHaveBeenCalled();
  });
});

// Queue 4f (B): a long root swarm/heavy answer is saved to the KB by the
// harness and the delivered text gains one ledger footer naming the path.
describe("dispatchTask persists a long root swarm/heavy answer (queue 4f B)", () => {
  // Digit-free so the numbers audit leaves the text untouched.
  const body = (n: number) => "Informe de cobertura regional. ".padEnd(n, "x");
  const TITLE = "Chat: cobertura regional Zacatecas";
  const SLUG = "chat-cobertura-regional";

  beforeEach(() => {
    // 03:30 UTC Oct 18 = 21:30 Oct 17 in Mexico City: the path date is MX.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T03:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  async function run(opts: {
    agentType: "swarm" | "heavy" | "fast";
    finalAnswer: string;
    spawnType?: "root" | "subtask" | "user-background";
    title?: string;
    success?: boolean;
    status?: RunnerOutput["status"];
    output?: RunnerOutput["output"];
    ritualId?: string;
    tags?: string[];
  }): Promise<{ taskId: string; delivered: Record<string, unknown> }> {
    vi.mocked(classify).mockReturnValueOnce({
      agentType: opts.agentType,
      score: 9,
      reason: "spec",
      explicit: true,
      modelTier: "standard",
    } as ReturnType<typeof classify>);
    registerRunner({
      type: opts.agentType,
      execute: async () =>
        ({
          success: opts.success ?? true,
          ...(opts.status && { status: opts.status }),
          output: opts.output ?? { content: "Meta resumen del reflector.", score: 0.9, finalAnswer: opts.finalAnswer },
        }) as RunnerOutput,
    });
    const { taskId } = await submitTask({
      title: opts.title ?? TITLE,
      description: "persist spec",
      ...(opts.spawnType && { spawnType: opts.spawnType }),
      ...(opts.spawnType === "subtask" && { parentTaskId: "parent-0001" }),
      ...(opts.ritualId && { ritualId: opts.ritualId }),
      ...(opts.tags && { tags: opts.tags }),
    });
    const terminal = (c: unknown[]) =>
      (c[0] === "task.completed" || c[0] === "task.failed") && (c[1] as { task_id: string }).task_id === taskId;
    await vi.waitFor(() => {
      if (!emitEventMock.mock.calls.some(terminal)) throw new Error("terminal event not emitted yet");
    });
    const ev = emitEventMock.mock.calls.find(terminal)!;
    return { taskId, delivered: ev[1].result as Record<string, unknown> };
  }

  /** The `tasks` status write (positional: status-specific UPDATE, output JSON). */
  function taskOutputWrites(): string {
    return JSON.stringify(mockRun.mock.calls.filter((c) => typeof c[0] !== "object"));
  }

  it("root swarm > 4000 chars: one upsertFile with the exact path, verbatim content, tags + section; footer appended", async () => {
    const FINAL = body(LONG_ANSWER_PERSIST_MIN_CHARS + 1);
    const { taskId, delivered } = await run({ agentType: "swarm", finalAnswer: FINAL });
    const path = `workspace/reports/${taskId.slice(0, 8)}-${SLUG}-2026-10-17.md`;
    expect(upsertFileMock).toHaveBeenCalledTimes(1);
    expect(upsertFileMock).toHaveBeenCalledWith(path, TITLE, FINAL, ["report", "swarm"], "workspace");
    const footer = `📄 Reporte guardado: ${path}`;
    expect(delivered.finalAnswer).toBe(`${FINAL}\n\n${footer}`);
    expect(delivered.content).toBe("Meta resumen del reflector.");
    // tasks.output carries the same footer (the status write).
    expect(JSON.stringify(mockRun.mock.calls)).toContain(JSON.stringify(footer).slice(1, -1));
    // The footer is ONE harness line.
    const last = String(delivered.finalAnswer).split("\n").at(-1)!;
    expect(last).toBe(footer);
    expect(isLedgerLine(last)).toBe(true);
    expect(logMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, path }),
      "[report-persist] saved",
    );
  });

  it("3999 and exactly 4000 chars: no write, no footer", async () => {
    for (const n of [LONG_ANSWER_PERSIST_MIN_CHARS - 1, LONG_ANSWER_PERSIST_MIN_CHARS]) {
      const FINAL = body(n);
      const { delivered } = await run({ agentType: "swarm", finalAnswer: FINAL });
      expect(delivered.finalAnswer).toBe(FINAL);
    }
    expect(LONG_ANSWER_PERSIST_MIN_CHARS).toBe(4000);
    expect(upsertFileMock).not.toHaveBeenCalled();
  });

  it("root heavy > 4000 chars: written with the heavy tag", async () => {
    const FINAL = body(5000);
    const { taskId, delivered } = await run({ agentType: "heavy", finalAnswer: FINAL });
    const path = `workspace/reports/${taskId.slice(0, 8)}-${SLUG}-2026-10-17.md`;
    expect(upsertFileMock).toHaveBeenCalledTimes(1);
    expect(upsertFileMock).toHaveBeenCalledWith(path, TITLE, FINAL, ["report", "heavy"], "workspace");
    expect(delivered.finalAnswer).toBe(`${FINAL}\n\n📄 Reporte guardado: ${path}`);
  });

  it("a child (subtask / user-background) swarm never persists", async () => {
    const FINAL = body(6000);
    for (const spawnType of ["subtask", "user-background"] as const) {
      const { delivered } = await run({ agentType: "swarm", finalAnswer: FINAL, spawnType });
      expect(delivered.finalAnswer).toBe(FINAL);
    }
    expect(upsertFileMock).not.toHaveBeenCalled();
  });

  it("a fast root never persists", async () => {
    const FINAL = body(6000);
    const { delivered } = await run({ agentType: "fast", finalAnswer: FINAL });
    expect(delivered.finalAnswer).toBe(FINAL);
    expect(upsertFileMock).not.toHaveBeenCalled();
  });

  it("upsertFile throws: delivered text intact, no footer, task still completes, one [report-persist] warn", async () => {
    upsertFileMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const FINAL = body(5000);
    const { taskId, delivered } = await run({ agentType: "swarm", finalAnswer: FINAL });
    expect(upsertFileMock).toHaveBeenCalledTimes(1);
    expect(delivered.finalAnswer).toBe(FINAL);
    expect(JSON.stringify(delivered)).not.toContain("Reporte guardado");
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).filter((e) => e.taskId === taskId).at(-1)!;
    expect(terminal.name).toBe("task.completed");
    expect(logMock.warn).toHaveBeenCalledWith(
      { taskId, err: "disk full" },
      "[report-persist] failed",
    );
  });

  it("the saved text is the DELIVERED text: persisted after the completion ledger (its inline marks included)", async () => {
    const FINAL = body(5000) + " Ventas del trimestre: $9,400,000 en la región.";
    const { delivered } = await run({ agentType: "swarm", finalAnswer: FINAL });
    const content = upsertFileMock.mock.calls[0]![2] as string;
    expect(content).toContain("(sin verificar)");
    expect(String(delivered.finalAnswer).startsWith(content)).toBe(true);
    expect(content).not.toContain("Reporte guardado");
  });

  it("secrets never reach the path, title or saved content (scrubSecrets on title and text)", async () => {
    // Built at runtime — synthetic marker, scrubbed by the mocked index.
    const SECRET = "zz" + "Q".repeat(12);
    scrubSecretsMock.mockImplementation((t: string) => t.split(SECRET).join("ref"));
    try {
      const FINAL = body(5000) + ` clave ${SECRET}`;
      const { taskId } = await run({ agentType: "swarm", finalAnswer: FINAL, title: `Chat: ${SECRET} cobertura` });
      const [path, title, content] = upsertFileMock.mock.calls[0]!;
      expect(path).toBe(`workspace/reports/${taskId.slice(0, 8)}-chat-ref-cobertura-2026-10-17.md`);
      expect(title).toBe("Chat: ref cobertura");
      expect(content).toBe(FINAL.split(SECRET).join("ref"));
      expect(JSON.stringify(upsertFileMock.mock.calls)).not.toContain(SECRET);
    } finally {
      scrubSecretsMock.mockImplementation((t: string) => t);
    }
  });

  it("key-shaped tokens are pattern-redacted in the saved title and content (redactCredentials)", async () => {
    // Built at runtime — no key-shaped literal in the (public) repo.
    const KEY = "sk-" + "a".repeat(24);
    const FINAL = body(5000) + ` clave ${KEY} fin`;
    await run({ agentType: "swarm", finalAnswer: FINAL, title: `Chat: llave ${KEY}` });
    const [, title, content] = upsertFileMock.mock.calls[0]!;
    expect(content).toBe(body(5000) + " clave [REDACTED_KEY] fin");
    expect(title).toBe("Chat: llave [REDACTED_KEY]");
    expect(JSON.stringify(upsertFileMock.mock.calls)).not.toContain(KEY);
  });

  it("a failed heavy root (6k finalAnswer) never persists: no write, no footer", async () => {
    const FINAL = body(6000);
    const { delivered } = await run({ agentType: "heavy", finalAnswer: FINAL, success: false });
    expect(upsertFileMock).not.toHaveBeenCalled();
    expect(delivered.finalAnswer).toBe(FINAL);
    expect(taskOutputWrites()).not.toContain("Reporte guardado");
  });

  it("a completed_with_concerns swarm root persists", async () => {
    const FINAL = body(5000);
    const { taskId, delivered } = await run({ agentType: "swarm", finalAnswer: FINAL, status: "DONE_WITH_CONCERNS" });
    const path = `workspace/reports/${taskId.slice(0, 8)}-${SLUG}-2026-10-17.md`;
    expect(upsertFileMock).toHaveBeenCalledWith(path, TITLE, FINAL, ["report", "swarm"], "workspace");
    expect(delivered.finalAnswer).toBe(`${FINAL}\n\n📄 Reporte guardado: ${path}`);
    const terminal = emitTraceMock.mock.calls.map((c) => c[0]).filter((e) => e.taskId === taskId).at(-1)!;
    expect(terminal.attrs).toMatchObject({ status: "completed_with_concerns" });
  });

  it("producers nobody reads in chat never persist: ritual, scheduled run, background-agent tag", async () => {
    const FINAL = body(6000);
    const cases = [
      { ritualId: "evolution-log" },
      { tags: ["scheduled", "schedule:sched-0001"] },
      { tags: ["messaging", "telegram", "background-agent"] },
    ];
    for (const c of cases) {
      const { delivered } = await run({ agentType: "heavy", finalAnswer: FINAL, ...c });
      expect(delivered.finalAnswer).toBe(FINAL);
    }
    expect(upsertFileMock).not.toHaveBeenCalled();
  });

  it("a content-only deliverable (reflector meta-summary) over 4000 chars never persists", async () => {
    const CONTENT = body(5000);
    const { delivered } = await run({
      agentType: "heavy",
      finalAnswer: "",
      output: { content: CONTENT, score: 0.9, finalAnswer: null },
    });
    expect(upsertFileMock).not.toHaveBeenCalled();
    expect(delivered.content).toBe(CONTENT);
  });

  it("a `text`-carried answer over 4000 chars persists (finalAnswer / text both count)", async () => {
    const TEXT = body(5000);
    const { taskId } = await run({ agentType: "swarm", finalAnswer: "", output: { text: TEXT, content: "meta" } });
    const path = `workspace/reports/${taskId.slice(0, 8)}-${SLUG}-2026-10-17.md`;
    expect(upsertFileMock).toHaveBeenCalledWith(path, TITLE, TEXT, ["report", "swarm"], "workspace");
  });
});
