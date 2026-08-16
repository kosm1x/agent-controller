/**
 * V8.4 — POST /api/tasks accepts optional `gates` (source "submission"),
 * validated at the edge: a malformed ledger is a 400, never a task that
 * silently runs ungated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
}));
vi.mock("../../dispatch/dispatcher.js", () => ({
  submitTask: mocks.submitTask,
  listTasks: vi.fn(() => []),
  getTaskWithRuns: vi.fn(() => null),
  cancelTask: vi.fn(),
}));

import { tasks } from "./tasks.js";

const app = new Hono();
app.route("/api/tasks", tasks);

beforeEach(() => {
  mocks.submitTask.mockReset();
  mocks.submitTask.mockResolvedValue({
    taskId: "t-1",
    agentType: "fast",
    classification: { score: 1, reason: "", explicit: false },
  });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/tasks gates", () => {
  it("forwards validated gates to submitTask; omits the field when absent", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "gated",
        description: "do it",
        gates: [{ criterion: "typecheck", check: "npx tsc --noEmit" }],
      }),
    });
    expect(res.status).toBe(201);
    expect(mocks.submitTask).toHaveBeenCalledWith(
      expect.objectContaining({
        gates: [{ criterion: "typecheck", check: "npx tsc --noEmit" }],
      }),
    );
    const plain = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "plain", description: "no gates" }),
    });
    expect(plain.status).toBe(201);
    expect(mocks.submitTask.mock.calls[1]![0]).not.toHaveProperty("gates");
  });

  it("rejects a malformed gates payload with 400 and never submits", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "bad",
        description: "d",
        gates: [{ check: "orphan" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/gates: .*criterion/),
    });
    expect(mocks.submitTask).not.toHaveBeenCalled();
  });
});
