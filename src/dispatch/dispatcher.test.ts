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

vi.mock("../rituals/scheduler.js", () => ({ recordRitualFailure: vi.fn() }));

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
  undeclaredRunFailure,
} from "./dispatcher.js";
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
  type TaskExecutionContext,
} from "../inference/execution-context.js";
import { outsideRunToolContext } from "../tools/rule-of-two.js";
import { classify } from "./classifier.js";

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
        outcome.set(input.title, await createTaskExecutor(registry, ctx)(tool, { to: "a@b.mx" }));
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
    expect(registry.execute).toHaveBeenCalledWith("gmail_send", { to: "a@b.mx" });
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
