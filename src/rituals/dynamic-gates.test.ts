/**
 * V8.4 — a schedule's `gates` column rides every submission of that schedule
 * as the task's ledger (source "ritual"); a malformed column runs the ritual
 * UNGATED (never blocks it); the column is added to pre-existing tables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
  getRouter: vi.fn(() => null),
}));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({ getRouter: mocks.getRouter }));

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  createSchedule,
  ensureScheduledTasksTable,
  executeScheduleNow,
  getSchedule,
  scheduleGates,
} from "./dynamic.js";

beforeEach(() => {
  initDatabase(":memory:");
  ensureScheduledTasksTable();
  mocks.submitTask.mockReset();
  mocks.submitTask.mockResolvedValue({
    taskId: "task-1",
    agentType: "fast",
    classification: { score: 1, reason: "", explicit: true },
  });
});
afterEach(() => closeDatabase());

describe("scheduled_tasks.gates", () => {
  it("createSchedule persists validated gates; scheduleGates reads them back", () => {
    createSchedule({
      scheduleId: "s1",
      name: "Publish tweet",
      description: "publica",
      cronExpr: "0 9 * * 1-5",
      tools: ["shell_exec"],
      delivery: "telegram",
      gates: [
        {
          criterion: "tweet URL returned",
          check: "test -s /tmp/last-tweet-url",
          expect: "",
        },
      ],
    });
    const row = getSchedule("s1")!;
    expect(row.gates).toContain('"criterion":"tweet URL returned"');
    expect(scheduleGates(row)).toEqual([
      {
        criterion: "tweet URL returned",
        check: "test -s /tmp/last-tweet-url",
        expect: "",
      },
    ]);
    createSchedule({
      scheduleId: "s2",
      name: "No gates",
      description: "d",
      cronExpr: "0 9 * * *",
      tools: [],
      delivery: "telegram",
    });
    expect(getSchedule("s2")!.gates).toBeNull();
    expect(scheduleGates(getSchedule("s2")!)).toEqual([]);
  });

  it("createSchedule refuses malformed gates loudly (validation at the write, not the run)", () => {
    expect(() =>
      createSchedule({
        scheduleId: "s3",
        name: "bad",
        description: "d",
        cronExpr: "0 9 * * *",
        tools: [],
        delivery: "telegram",
        gates: [{ criterion: "", check: "x" }],
      }),
    ).toThrow(/criterion/);
  });

  it("executeScheduleNow forwards gates + gatesSource='ritual' to submitTask; a corrupt column runs ungated", async () => {
    createSchedule({
      scheduleId: "s4",
      name: "Gated ritual",
      description: "d",
      cronExpr: "0 9 * * *",
      tools: [],
      delivery: "telegram",
      gates: [{ criterion: "report mentions the date" }],
    });
    await executeScheduleNow("s4");
    expect(mocks.submitTask).toHaveBeenCalledTimes(1);
    expect(mocks.submitTask.mock.calls[0]![0]).toMatchObject({
      gates: [{ criterion: "report mentions the date" }],
      gatesSource: "ritual",
      tags: expect.arrayContaining(["scheduled", "schedule:s4"]),
    });

    getDatabase()
      .prepare(
        `UPDATE scheduled_tasks SET gates = '{"not":"an array"}' WHERE schedule_id = 's4'`,
      )
      .run();
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await executeScheduleNow("s4");
    expect(mocks.submitTask.mock.calls[1]![0]).toMatchObject({
      gates: [],
      gatesSource: "ritual",
    });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/invalid gates column — running ungated/),
    );
    errSpy.mockRestore();
  });

  it("ensureScheduledTasksTable adds the gates column to a pre-existing (legacy) table", () => {
    // Fresh in-memory DB whose scheduled_tasks predates V8.4.
    closeDatabase();
    initDatabase(":memory:");
    getDatabase().exec(`
      CREATE TABLE scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, cron_expr TEXT NOT NULL, tools TEXT DEFAULT '[]', delivery TEXT DEFAULT 'telegram',
        email_to TEXT, email_subject TEXT, active INTEGER DEFAULT 1, last_run_at TEXT, created_at TEXT DEFAULT (datetime('now'))
      )`);
    ensureScheduledTasksTable();
    const cols = (
      getDatabase()
        .prepare("SELECT name FROM pragma_table_info('scheduled_tasks')")
        .all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("gates");
    // Idempotent
    ensureScheduledTasksTable();
  });
});
