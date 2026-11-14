/**
 * POST /admin/kill-autonomous — its task SELECT on the real schema
 * (`initDatabase(":memory:")`), through Hono's in-process `app.request`
 * (no port). The cancel call is a stub that records the ids it receives, so
 * no task is touched; the two environment names the route reads or writes
 * are saved and restored. Fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancelled = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../../dispatch/dispatcher.js", () => ({
  cancelTask: (id: string) => {
    cancelled.ids.push(id);
    return true;
  },
}));

import { Hono } from "hono";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { admin } from "./admin.js";

const ENV_NAMES = ["KILL_PASSPHRASE", "AUTONOMOUS_IMPROVEMENT_ENABLED"] as const;
const saved: Partial<Record<(typeof ENV_NAMES)[number], string>> = {};

function task(taskId: string, title: string, status: string): void {
  getDatabase()
    .prepare("INSERT INTO tasks (task_id, title, description, status) VALUES (?, ?, 'synthetic', ?)")
    .run(taskId, title, status);
}

beforeEach(() => {
  for (const n of ENV_NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  initDatabase(":memory:");
  cancelled.ids = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("POST /admin/kill-autonomous — which tasks it cancels", () => {
  // Matching titles in each of the three live statuses are cancelled; the
  // same titles in every other status are not, and neither are live tasks
  // whose title only resembles the marker.
  it("cancels live auto-improvement tasks only", async () => {
    const statuses = [
      "pending", "classifying", "queued", "running", "completed",
      "completed_with_concerns", "needs_context", "blocked", "failed", "cancelled",
    ];
    for (const s of statuses) task(`t-mid-${s}`, `Nightly Auto-improvement: ${s}`, s);
    task("t-start-running", "Auto-improvement pass", "running");
    task("t-end-queued", "Weekly Auto-improvement", "queued");
    task("t-no-hyphen", "Nightly Auto improvement", "running");
    task("t-cut", "Nightly Auto-improvemen", "pending");

    const app = new Hono();
    app.route("/admin", admin);
    const res = await app.request("/admin/kill-autonomous", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled_tasks: string[] };

    const expected = ["t-end-queued", "t-mid-pending", "t-mid-queued", "t-mid-running", "t-start-running"];
    expect([...cancelled.ids].sort()).toEqual(expected);
    expect([...body.cancelled_tasks].sort()).toEqual(expected);
    expect(process.env.AUTONOMOUS_IMPROVEMENT_ENABLED).toBe("false");
  });
});
