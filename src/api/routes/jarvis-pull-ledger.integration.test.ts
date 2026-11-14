/**
 * `ledgerFor` (the token and cost totals the jarvis-pull route reports for its
 * task) on the real schema (`initDatabase(":memory:")`). jarvis-pull.test.ts
 * stubs the database. Only the reader is called: every import of the route
 * that could act (task submission, event bus, tool registry, prompt builder,
 * model call, knowledge-base read) is a stub that throws, asserted never
 * called.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const never = vi.hoisted(() => {
  const stub = (name: string) =>
    vi.fn((..._args: unknown[]): never => {
      throw new Error(`${name} must not be reached by the ledger reader`);
    });
  return {
    submitTask: stub("submitTask"),
    cancelTask: stub("cancelTask"),
    getRunToolCalls: stub("getRunToolCalls"),
    getEventBus: stub("getEventBus"),
    toolRegistryGet: stub("toolRegistry.get"),
    buildExternalJarvisSystemPrompt: stub("buildExternalJarvisSystemPrompt"),
    infer: stub("infer"),
    getFilesByQualifier: stub("getFilesByQualifier"),
  };
});

vi.mock("../../dispatch/dispatcher.js", () => ({
  submitTask: never.submitTask,
  cancelTask: never.cancelTask,
  getRunToolCalls: never.getRunToolCalls,
}));
vi.mock("../../lib/event-bus.js", () => ({ getEventBus: never.getEventBus }));
vi.mock("../../tools/registry.js", () => ({ toolRegistry: { get: never.toolRegistryGet } }));
vi.mock("../../messaging/router.js", () => ({
  buildExternalJarvisSystemPrompt: never.buildExternalJarvisSystemPrompt,
  CACHE_BREAK_MARKER: "\n<!--CACHE_BREAK_v1-->\n",
}));
vi.mock("../../inference/adapter.js", () => ({ infer: never.infer }));
vi.mock("../../db/jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/jarvis-fs.js")>()),
  getFilesByQualifier: never.getFilesByQualifier,
}));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { ledgerFor } from "./jarvis-pull.js";

function seedCost(taskId: string, runId: string, promptTokens: number, completionTokens: number, costUsd: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO cost_ledger (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, 'fast', 'syn-model', ?, ?, ?)`,
    )
    .run(runId, taskId, promptTokens, completionTokens, costUsd);
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

afterAll(() => {
  for (const [name, stub] of Object.entries(never)) {
    expect(stub, name).not.toHaveBeenCalled();
  }
});

describe("ledgerFor on the real schema (neighbours on both sides of the task id)", () => {
  beforeEach(() => {
    // The task's three rows: a sum differs from a count, a maximum or any one
    // row, and one row repeats another's token total and cost, so a sum of
    // distinct values differs from the sum of every row.
    seedCost("task-1", "run-1", 1000, 1, 2);
    seedCost("task-2", "run-2a", 100, 20, 0.25);
    seedCost("task-3", "run-3", 5000, 5, 4);
    seedCost("task-2", "run-2b", 3, 4, 0.5);
    seedCost("task-2", "run-2c", 115, 5, 0.25);
  });

  it("sums prompt plus completion tokens and the cost of the task's rows only", () => {
    expect(ledgerFor("task-2")).toEqual({ tokens: 247, costUsd: 1 });
    expect(ledgerFor("task-1")).toEqual({ tokens: 1001, costUsd: 2 });
    expect(ledgerFor("task-3")).toEqual({ tokens: 5005, costUsd: 4 });
  });

  it("a task with no rows, below or above every seeded id, reads as zero", () => {
    expect(ledgerFor("task-0")).toEqual({ tokens: 0, costUsd: 0 });
    expect(ledgerFor("task-25")).toEqual({ tokens: 0, costUsd: 0 });
    expect(ledgerFor("task-9")).toEqual({ tokens: 0, costUsd: 0 });
  });
});
