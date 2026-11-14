/**
 * `rituals/dynamic` statements on the real schema (`initDatabase(":memory:")`):
 * schedule reads and writes, the run-tracking rows and the dead-run reaper.
 * Every case has schedules or tasks whose ids sort on each side of the one
 * acted on, which must stay out of the result or as they were.
 *
 * Only SQL paths run: task submission and the operator alert are stubs that
 * record their calls (submission fails unless a case sets its result), the
 * strategic-surface switch is unset, and the cron scheduler is never started.
 * Fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
  broadcastToAll: vi.fn(),
}));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({
  getRouter: () => ({ broadcastToAll: mocks.broadcastToAll }),
}));

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  createSchedule,
  deleteSchedule,
  ensureScheduledTasksTable,
  executeScheduleNow,
  getSchedule,
  handleScheduledTaskFailure,
  inFlightScheduleRun,
  listSchedules,
  setScheduleActive,
  watchScheduledTask,
} from "./dynamic.js";

const OLD_RUN = "2020-01-02 03:04:05";
let savedSyncId: string | undefined;
/** Task ids left in the module's pending map; drained after each case. */
const pending: string[] = [];

function sched(id: string): void {
  createSchedule({
    scheduleId: id,
    name: `Report ${id}`,
    description: `Prompt for ${id}`,
    cronExpr: "0 9 * * 1",
    tools: ["web_search"],
    delivery: "telegram",
  });
}

function scheduleRow(id: string): Record<string, unknown> | undefined {
  return getDatabase().prepare("SELECT * FROM scheduled_tasks WHERE schedule_id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

function runsOf(scheduleId: string): Array<Record<string, unknown>> {
  return getDatabase()
    .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id")
    .all(scheduleId) as Array<Record<string, unknown>>;
}

/** A schedule_runs row written directly; `age` is a datetime() modifier. */
function seedRun(scheduleId: string, taskId: string, age: string, status = "running"): void {
  getDatabase()
    .prepare(
      `INSERT INTO schedule_runs (schedule_id, task_id, spawned_at, status, result_summary)
       VALUES (?, ?, datetime('now', ?), ?, 'earlier summary')`,
    )
    .run(scheduleId, taskId, age, status);
}

/** A task row; `completedAge` null = not completed. */
function seedTask(taskId: string, status: string, completedAge: string | null): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, completed_at)
       VALUES (?, 'synthetic', 'synthetic', ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
    )
    .run(taskId, status, completedAge, completedAge);
}

function nextTask(taskId: string): void {
  mocks.submitTask.mockResolvedValueOnce({
    taskId,
    agentType: "fast",
    classification: { score: 1, reason: "", explicit: true },
  });
  pending.push(taskId);
}

beforeEach(() => {
  savedSyncId = process.env.V82_SYNC_SCHEDULE_ID;
  delete process.env.V82_SYNC_SCHEDULE_ID;
  initDatabase(":memory:");
  ensureScheduledTasksTable();
  mocks.submitTask.mockReset();
  mocks.submitTask.mockRejectedValue(new Error("submitTask: no result set by this case"));
  mocks.broadcastToAll.mockReset();
  mocks.broadcastToAll.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const id of pending.splice(0)) handleScheduledTaskFailure(id, "drained");
  closeDatabase();
  vi.restoreAllMocks();
  if (savedSyncId === undefined) delete process.env.V82_SYNC_SCHEDULE_ID;
  else process.env.V82_SYNC_SCHEDULE_ID = savedSyncId;
});

describe("getSchedule", () => {
  it("reads the one schedule by id; an id below the lowest reads nothing", () => {
    sched("sch-c");
    sched("sch-a");
    sched("sch-b");
    expect(getSchedule("sch-b")).toMatchObject({ schedule_id: "sch-b", name: "Report sch-b" });
    expect(getSchedule("sch-0")).toBeNull();
  });
});

describe("listSchedules", () => {
  // created_at order differs from insertion order; one schedule is paused.
  it("lists by created_at ascending, active only by default", () => {
    for (const id of ["s-x", "s-y", "s-z", "s-w"]) sched(id);
    const stamp = getDatabase().prepare("UPDATE scheduled_tasks SET created_at = ? WHERE schedule_id = ?");
    stamp.run("2026-01-03 00:00:00", "s-x");
    stamp.run("2026-01-01 00:00:00", "s-y");
    stamp.run("2026-01-02 00:00:00", "s-z");
    stamp.run("2026-01-02 12:00:00", "s-w");
    getDatabase().prepare("UPDATE scheduled_tasks SET active = 0 WHERE schedule_id = 's-z'").run();
    expect(listSchedules().map((s) => s.schedule_id)).toEqual(["s-y", "s-w", "s-x"]);
    expect(listSchedules(false).map((s) => s.schedule_id)).toEqual(["s-y", "s-z", "s-w", "s-x"]);
  });
});

describe("deleteSchedule", () => {
  it("removes only that schedule; an absent id removes nothing", () => {
    sched("sch-c");
    sched("sch-a");
    sched("sch-b");
    expect(deleteSchedule("sch-0")).toBe(false);
    expect(deleteSchedule("sch-b")).toBe(true);
    expect(scheduleRow("sch-b")).toBeUndefined();
    expect(scheduleRow("sch-a")).toBeDefined();
    expect(scheduleRow("sch-c")).toBeDefined();
  });
});

describe("setScheduleActive", () => {
  // One neighbour starts active and one paused, so a change that reached
  // either one shows in both directions.
  it("pauses and resumes only that schedule", () => {
    sched("sch-c");
    sched("sch-a");
    sched("sch-b");
    getDatabase().prepare("UPDATE scheduled_tasks SET active = 0 WHERE schedule_id = 'sch-c'").run();
    const states = () => ["sch-a", "sch-b", "sch-c"].map((id) => scheduleRow(id)?.active);

    expect(setScheduleActive("sch-0", false)).toBe(false);
    expect(states()).toEqual([1, 1, 0]);
    expect(setScheduleActive("sch-b", false)).toBe(true);
    expect(states()).toEqual([1, 0, 0]);
    expect(setScheduleActive("sch-b", true)).toBe(true);
    expect(states()).toEqual([1, 1, 0]);
  });
});

describe("executeScheduleNow — run row and last_run_at", () => {
  beforeEach(() => {
    sched("sch-c");
    sched("sch-a");
    sched("sch-b");
    getDatabase().prepare("UPDATE scheduled_tasks SET last_run_at = ?").run(OLD_RUN);
  });

  // Neighbours both ran seconds ago; this schedule's own last run is just
  // past the one-minute window (a slow run only moves it further out), so a
  // new run row is written for it.
  it("writes a run row with its own schedule and task id and stamps only its last_run_at", async () => {
    seedRun("sch-a", "t-a-recent", "-10 seconds");
    seedRun("sch-c", "t-c-recent", "-10 seconds");
    seedRun("sch-b", "t-b-old", "-65 seconds", "completed");
    nextTask("t-b-new");
    expect(await executeScheduleNow("sch-b")).toBe("t-b-new");

    const runs = runsOf("sch-b");
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      schedule_id: "sch-b",
      task_id: "t-b-new",
      status: "running",
      result_summary: null,
    });
    expect(runs[1].spawned_at).toEqual(expect.any(String));
    expect(runsOf("sch-a")).toHaveLength(1);
    expect(runsOf("sch-c")).toHaveLength(1);

    expect(scheduleRow("sch-b")?.last_run_at).not.toBe(OLD_RUN);
    expect((scheduleRow("sch-b")?.last_run_at as string) > OLD_RUN).toBe(true);
    expect(scheduleRow("sch-a")?.last_run_at).toBe(OLD_RUN);
    expect(scheduleRow("sch-c")?.last_run_at).toBe(OLD_RUN);
  });

  it("writes no second run row when this schedule's own run is inside the minute", async () => {
    seedRun("sch-b", "t-b-recent", "-20 seconds");
    nextTask("t-b-new");
    await executeScheduleNow("sch-b");
    expect(runsOf("sch-b").map((r) => r.task_id)).toEqual(["t-b-recent"]);
  });
});

describe("inFlightScheduleRun — dead-run reaper", () => {
  function watch(taskId: string, scheduleId = "sch-b"): void {
    const s = getSchedule(scheduleId);
    if (!s) throw new Error("schedule missing");
    watchScheduledTask(taskId, s);
    pending.push(taskId);
  }

  beforeEach(() => {
    sched("sch-b");
    // Neighbour tasks are terminal and long dead, with running run rows.
    seedTask("t-a", "failed", "-10 minutes");
    seedTask("t-c", "failed", "-10 minutes");
    seedRun("sch-x", "t-a", "-11 minutes");
    seedRun("sch-x", "t-c", "-11 minutes");
  });

  it("a task terminal for less than the grace is still in flight", () => {
    seedTask("t-b", "completed", "-1 minute");
    seedRun("sch-b", "t-b", "-2 minutes");
    watch("t-b");
    expect(inFlightScheduleRun("sch-b")).toBe("t-b");
    expect(mocks.broadcastToAll).not.toHaveBeenCalled();
  });

  // Reaped rows sit just past the 120-second grace (a slow run only ages
  // them further), so a wider grace leaves them in flight.
  it("a task terminal past the grace is reaped: only its own run row is marked failed", () => {
    seedTask("t-b", "completed", "-130 seconds");
    seedRun("sch-b", "t-b", "-135 seconds");
    watch("t-b");
    expect(inFlightScheduleRun("sch-b")).toBeNull();
    pending.splice(pending.indexOf("t-b"), 1);
    expect(runsOf("sch-b")[0]).toMatchObject({
      status: "failed",
      result_summary: "lost: task completed but its result never reached the scheduler",
    });
    for (const r of runsOf("sch-x")) {
      expect(r).toMatchObject({ status: "running", result_summary: "earlier summary" });
    }
    expect(mocks.broadcastToAll).toHaveBeenCalledTimes(1);
  });

  // The reaped task has no run row of its own; the neighbours' running rows
  // must not be read in its place (no alert, nothing changed).
  it("a reaped task without a run row raises no alert and changes no other row", () => {
    seedTask("t-b", "completed", "-130 seconds");
    watch("t-b");
    expect(inFlightScheduleRun("sch-b")).toBeNull();
    pending.splice(pending.indexOf("t-b"), 1);
    expect(mocks.broadcastToAll).not.toHaveBeenCalled();
    for (const r of runsOf("sch-x")) expect(r.status).toBe("running");
  });
});
