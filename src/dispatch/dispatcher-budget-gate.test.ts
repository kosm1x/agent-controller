/**
 * Budget-gate behavior in dispatcher.submitTask.
 *
 * Three modes (P6 from 2026-05-24 /diagnose):
 *  - disabled       (budgetEnabled=false): no warn, no block
 *  - soft-cap       (budgetEnabled=true, budgetEnforce=false): log warn, proceed
 *  - enforce        (budgetEnabled=true, budgetEnforce=true): log info, block
 *
 * These tests isolate the gate via dedicated mocks rather than reusing the
 * shared dispatcher.test.ts mock plumbing — keeps the gate-specific
 * scenarios easy to read without disturbing the 15 unrelated submitTask
 * tests that file already covers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRun, mockAll, mockPrepare } = vi.hoisted(() => {
  const mockRun = vi.fn(() => ({ changes: 1, lastInsertRowid: 1 }));
  const mockGet = vi.fn();
  const mockAll = vi.fn().mockReturnValue([]);
  const mockPrepare = vi.fn(() => ({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  }));
  return { mockRun, mockAll, mockPrepare };
});

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: mockPrepare,
    exec: vi.fn(),
  }),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({ emitEvent: vi.fn() }),
}));

vi.mock("./classifier.js", () => ({
  classify: vi.fn(() => ({
    agentType: "fast",
    score: 1,
    reason: "auto",
    explicit: false,
    modelTier: "standard",
  })),
}));

// Per-test mutable config so each test can flip budgetEnabled / budgetEnforce.
const { mockConfig, mockIsAnyWindowExceeded, mockGetThreeWindowStatus } =
  vi.hoisted(() => ({
    mockConfig: {
      inferencePrimaryProvider: "openai",
      inferencePrimaryUrl: "http://localhost:9999/v1",
      inferencePrimaryKey: "test",
      inferencePrimaryModel: "test-model",
      inferenceTimeoutMs: 5000,
      budgetEnabled: false,
      budgetEnforce: false,
      budgetDailyLimitUsd: 30,
      budgetHourlyLimitUsd: 2,
      budgetMonthlyLimitUsd: 400,
      maxConcurrentContainers: 5,
    },
    mockIsAnyWindowExceeded: vi.fn(() => false),
    mockGetThreeWindowStatus: vi.fn(() => ({
      hourly: { spend: 0.5, limit: 2, remaining: 1.5, exceeded: false },
      daily: { spend: 5, limit: 30, remaining: 25, exceeded: false },
      monthly: { spend: 100, limit: 400, remaining: 300, exceeded: false },
    })),
  }));

vi.mock("../config.js", () => ({
  getConfig: () => mockConfig,
}));

vi.mock("../budget/service.js", () => ({
  isAnyWindowExceeded: () => mockIsAnyWindowExceeded(),
  getThreeWindowStatus: () => mockGetThreeWindowStatus(),
  recordCost: vi.fn(),
}));

vi.mock("./checkout.js", () => ({
  checkoutTask: vi.fn(() => ({ success: true, taskId: "mock-id" })),
}));

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));

vi.mock("../tools/flailing-guard.js", () => ({
  ritualContext: { run: (_store: unknown, fn: () => unknown) => fn() },
}));

vi.mock("../observability/prometheus.js", () => ({
  taskStarted: vi.fn(),
  taskCompleted: vi.fn(),
}));

vi.mock("../messaging/router.js", () => ({
  stripCacheMarker: (s: string) => s,
}));

vi.mock("../inference/claude-sdk.js", () => ({
  SONNET_MODEL_ID: "claude-sonnet-4-6",
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { submitTask, registerRunner } from "./dispatcher.js";

// Dummy runner so dispatchTask doesn't bail at the "No runner registered"
// check before reaching the budget gate. The runnerExecute mock is the
// positive-assertion surface for the gate's "did the task proceed?"
// invariant: enforce → not called; soft-cap → called; disabled → called.
// Without this, the test could pass for a buggy implementation that
// returns early WITHOUT blocking but also without dispatching.
const runnerExecute = vi.fn(async () => ({
  success: true,
  output: { text: "ok" },
  tokenUsage: { promptTokens: 0, completionTokens: 0 },
  toolCalls: [],
  durationMs: 0,
}));
registerRunner({
  type: "fast",
  execute: runnerExecute,
});

/** dispatcher.ts:dispatchTask is fired fire-and-forget from submitTask().
 *  Tests need to drain the microtask queue + one macrotask tick so the
 *  budget gate runs before assertions. */
async function drainAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function findBlockedUpdateCall(): unknown[] | undefined {
  // updateTaskStatus(_, 'blocked', ...) calls `db.prepare(`UPDATE tasks SET
  // status = ?, error = ? ...`).run(status, error, taskId)` — find that.
  const prepareCalls = mockPrepare.mock.calls as unknown as Array<[string]>;
  const runCalls = mockRun.mock.calls as unknown as Array<unknown[]>;
  for (const call of prepareCalls) {
    const sql = call[0];
    if (
      sql.includes("UPDATE tasks SET status = ?, error = ?") &&
      sql.includes("WHERE task_id = ?")
    ) {
      // Find the corresponding .run() call. The run mock receives positional
      // args (status, error, taskId).
      for (const runCall of runCalls) {
        if (runCall[0] === "blocked") return runCall;
      }
    }
  }
  return undefined;
}

describe("dispatcher budget gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerExecute.mockClear();
    mockAll.mockReturnValue([]);
    mockConfig.budgetEnabled = false;
    mockConfig.budgetEnforce = false;
    mockIsAnyWindowExceeded.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disabled: no warn, no block when exceeded", async () => {
    mockConfig.budgetEnabled = false;
    mockIsAnyWindowExceeded.mockReturnValue(true);

    await submitTask({
      title: "Disabled mode",
      description: "Gate must not fire",
    });
    await drainAsync();

    expect(mockLogWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      "budget soft-cap exceeded (tracking only, task proceeds)",
    );
    expect(findBlockedUpdateCall()).toBeUndefined();
    // Disabled mode falls through to dispatch.
    expect(runnerExecute).toHaveBeenCalled();
  });

  it("soft-cap: log warn, task proceeds (NOT blocked) when exceeded", async () => {
    mockConfig.budgetEnabled = true;
    mockConfig.budgetEnforce = false;
    mockIsAnyWindowExceeded.mockReturnValue(true);
    mockGetThreeWindowStatus.mockReturnValueOnce({
      hourly: { spend: 0.5, limit: 2, remaining: 1.5, exceeded: false },
      daily: { spend: 45.18, limit: 30, remaining: 0, exceeded: true },
      monthly: { spend: 576, limit: 400, remaining: 0, exceeded: true },
    });

    await submitTask({
      title: "Soft-cap mode",
      description: "Should proceed despite breach",
    });
    await drainAsync();

    // Warn was logged with the breach detail
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        exceeded: expect.stringContaining("daily"),
        enforce: false,
      }),
      "budget soft-cap exceeded (tracking only, task proceeds)",
    );
    // Task was NOT blocked
    expect(findBlockedUpdateCall()).toBeUndefined();
    // CRITICAL — the task actually proceeded to the runner.
    // This is the positive-assertion half of "task proceeds despite breach".
    expect(runnerExecute).toHaveBeenCalled();
  });

  it("enforce: block task with 'blocked' status when exceeded", async () => {
    mockConfig.budgetEnabled = true;
    mockConfig.budgetEnforce = true;
    mockIsAnyWindowExceeded.mockReturnValue(true);
    mockGetThreeWindowStatus.mockReturnValueOnce({
      hourly: { spend: 0.5, limit: 2, remaining: 1.5, exceeded: false },
      daily: { spend: 45.18, limit: 30, remaining: 0, exceeded: true },
      monthly: { spend: 100, limit: 400, remaining: 300, exceeded: false },
    });

    await submitTask({
      title: "Enforce mode",
      description: "Should be blocked",
    });
    await drainAsync();

    // Info logged with the block intent
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        exceeded: expect.stringContaining("daily"),
        enforce: true,
      }),
      "task blocked: budget exceeded",
    );
    // Task WAS blocked (updateTaskStatus called with 'blocked')
    const blockedCall = findBlockedUpdateCall();
    expect(blockedCall).toBeDefined();
    expect(blockedCall![0]).toBe("blocked");
    expect(blockedCall![1]).toContain("daily");
    // CRITICAL — the task did NOT reach the runner.
    expect(runnerExecute).not.toHaveBeenCalled();
  });

  it("no breach: neither warn nor block fires", async () => {
    mockConfig.budgetEnabled = true;
    mockConfig.budgetEnforce = true; // even with enforce on
    mockIsAnyWindowExceeded.mockReturnValue(false); // but no breach

    await submitTask({
      title: "Within budget",
      description: "All windows healthy",
    });
    await drainAsync();

    expect(mockLogWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      "budget soft-cap exceeded (tracking only, task proceeds)",
    );
    expect(mockLogInfo).not.toHaveBeenCalledWith(
      expect.anything(),
      "task blocked: budget exceeded",
    );
    expect(findBlockedUpdateCall()).toBeUndefined();
    // Even with enforce=true, the task proceeded because no breach was present.
    expect(runnerExecute).toHaveBeenCalled();
  });

  it("soft-cap reports the FIRST exceeded window (hourly > daily > monthly precedence)", async () => {
    mockConfig.budgetEnabled = true;
    mockConfig.budgetEnforce = false;
    mockIsAnyWindowExceeded.mockReturnValue(true);
    mockGetThreeWindowStatus.mockReturnValueOnce({
      hourly: { spend: 3.5, limit: 2, remaining: 0, exceeded: true },
      daily: { spend: 45, limit: 30, remaining: 0, exceeded: true },
      monthly: { spend: 100, limit: 400, remaining: 300, exceeded: false },
    });

    await submitTask({
      title: "Multi-window breach",
      description: "Hourly fires first",
    });
    await drainAsync();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        exceeded: expect.stringContaining("hourly"),
      }),
      "budget soft-cap exceeded (tracking only, task proceeds)",
    );
  });
});
