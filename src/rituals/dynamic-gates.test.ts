/**
 * V8.4 — a schedule's `gates` column rides every submission of that schedule
 * as the task's ledger (source "ritual"); a malformed column runs the ritual
 * UNGATED (never blocks it); the column is added to pre-existing tables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
  getRouter: vi.fn(() => null),
  scheduleCron: vi.fn(),
}));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({ getRouter: mocks.getRouter }));
vi.mock("../lib/cron.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cron.js")>()),
  scheduleCron: mocks.scheduleCron,
}));

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  createSchedule,
  ensureScheduledTasksTable,
  executeScheduleNow,
  getSchedule,
  getScheduleRuns,
  handleScheduledTaskFailure,
  handleScheduledTaskResult,
  inFlightScheduleRun,
  scheduleGates,
  startDynamicScheduler,
  stopDynamicScheduler,
  watchScheduledTask,
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
  it("a STORED gate whose expect can never fail comes back ABANDONED, not dropped — the live tweet ritual of 2026-09-12 (qa C1)", () => {
    getDatabase()
      .prepare(
        `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr, tools, delivery, gates)
         VALUES ('s-live', 'MexicoNecesario — Tweet Diario', 'd', '0 13 * * *', '["tweet_post"]', 'telegram', ?)`,
      )
      .run(
        JSON.stringify([
          {
            criterion: "tweet_post was actually invoked in THIS run",
            id: "G1",
            check: "./mc-ctl db \"SELECT COUNT(*) AS n FROM task_trace_events WHERE task_id='$MC_TASK_ID' AND tool='tweet_post'\"",
            expect: "/^[1-9][0-9]*$/m",
          },
        ]),
      );
    const specs = scheduleGates(getSchedule("s-live")!);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: "G1",
      expect: "/^[1-9][0-9]*$/m",
      abandonReason: expect.stringMatching(/^expect cannot fail — .*names only digits/),
    });
    // A genuinely malformed column still degrades to ungated, as before.
    getDatabase()
      .prepare(`UPDATE scheduled_tasks SET gates = '[{"check":"x"}]' WHERE schedule_id = 's-live'`)
      .run();
    expect(scheduleGates(getSchedule("s-live")!)).toEqual([]);
  });

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
      // The schedule's own prompt, without appended blocks (DENUE guard text).
      detectionText: "d",
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

// The DENUE guard reads `detectionText`: every submit site must set it to the
// schedule's own prompt, never the description with the appended blocks.
describe("schedule submissions carry detectionText (2026-09-29)", () => {
  afterEach(() => stopDynamicScheduler());
  const create = (delivery: string) =>
    createSchedule({
      scheduleId: "s-dt",
      name: "DT",
      description: "d",
      cronExpr: "* * * * *",
      tools: [],
      delivery,
    });

  it("cron tick", async () => {
    create("telegram");
    startDynamicScheduler();
    const tick = mocks.scheduleCron.mock.calls[0]![2] as () => void;
    tick();
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.submitTask.mock.calls[0]![0]).toMatchObject({
      title: expect.stringMatching(/^\[Scheduled\] DT/),
      detectionText: "d",
    });
  });

  // Ruling 2026-10-01: the yes is asked when the schedule is created; an
  // existing schedule carrying gmail_send keeps firing unattended
  // (interactive:false → the confirmation gate proceeds).
  it("cron tick of a schedule carrying gmail_send stays non-interactive", async () => {
    createSchedule({
      scheduleId: "s-dt",
      name: "DT",
      description: "d",
      cronExpr: "* * * * *",
      tools: ["web_search", "gmail_send"],
      delivery: "email",
      emailTo: "a@b.mx",
    });
    startDynamicScheduler();
    (mocks.scheduleCron.mock.calls[0]![2] as () => void)();
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.submitTask.mock.calls[0]![0]).toMatchObject({
      interactive: false,
      tools: ["web_search", "gmail_send"],
    });
  });

  it("delivery-miss retry", async () => {
    create("email");
    watchScheduledTask("t-miss", getSchedule("s-dt")!);
    handleScheduledTaskResult("t-miss", "done", "completed", []);
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.submitTask.mock.calls[0]![0]).toMatchObject({
      tags: expect.arrayContaining(["retry"]),
      detectionText: "d",
    });
  });
});

// A runner that THROWS is marked failed by the dispatcher catch, which emits no
// bus event — the pending entry would block run_schedule until restart.
describe("inFlightScheduleRun reaps a dead entry (dead-owner reclaim)", () => {
  afterEach(() => {
    mocks.getRouter.mockReturnValue(null);
    const t = inFlightScheduleRun("s-dead");
    if (t) handleScheduledTaskFailure(t, "test cleanup");
    vi.restoreAllMocks();
  });

  /** Watch `taskId` with a schedule_runs row, its task row in `status`,
   *  terminal `agoSeconds` ago (null = no completed_at, i.e. not terminal). */
  function seedRun(taskId: string, status: string, agoSeconds: number | null) {
    createSchedule({
      scheduleId: "s-dead",
      name: "Dead",
      description: "d",
      cronExpr: "0 9 * * *",
      tools: [],
      delivery: "telegram",
    });
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, completed_at)
       VALUES (?, 't', 'd', ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
    ).run(taskId, status, agoSeconds, `-${agoSeconds ?? 0} seconds`);
    db.prepare(
      "INSERT INTO schedule_runs (schedule_id, task_id) VALUES ('s-dead', ?)",
    ).run(taskId);
    watchScheduledTask(taskId, getSchedule("s-dead")!);
  }
  const runStatus = () => getScheduleRuns("s-dead")[0]!.status;

  it("(a) failed past the grace → not in flight, entry gone, run row failed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedRun("t-thrown", "failed", 300);
    expect(inFlightScheduleRun("s-dead")).toBeNull();
    // Entry gone: a late failure handler finds nothing to clear.
    handleScheduledTaskFailure("t-thrown", "late");
    expect(runStatus()).toBe("failed");
    expect(getScheduleRuns("s-dead")[0]!.result_summary).toMatch(
      /^lost: task failed/,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/reaped dead in-flight run .*schedule s-dead, task t-thrown failed/),
    );
  });

  it("(b) task still running → still in flight", () => {
    seedRun("t-run", "running", null);
    expect(inFlightScheduleRun("s-dead")).toBe("t-run");
    expect(runStatus()).toBe("running");
  });

  it("(c) terminal but inside the grace → still in flight (completion event may be about to land)", () => {
    seedRun("t-fresh", "completed", 30);
    expect(inFlightScheduleRun("s-dead")).toBe("t-fresh");
    expect(runStatus()).toBe("running");
    // The bus-driven result still finds its entry and delivers.
    handleScheduledTaskResult("t-fresh", "ok", "completed", []);
    expect(runStatus()).toBe("completed");
  });

  it("(d) completed past the grace with the entry still pending → reaped; undelivered run recorded failed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedRun("t-lost", "completed", 300);
    expect(inFlightScheduleRun("s-dead")).toBeNull();
    expect(runStatus()).toBe("failed");
    expect(getScheduleRuns("s-dead")[0]!.result_summary).toMatch(
      /^lost: task completed/,
    );
  });

  it("a schedule_runs write that throws (SQLITE_BUSY class) never escapes — still reaped, not in flight", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedRun("t-busy", "failed", 300);
    getDatabase().exec(
      `CREATE TRIGGER busy BEFORE UPDATE ON schedule_runs BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    expect(() => inFlightScheduleRun("s-dead")).not.toThrow();
    expect(inFlightScheduleRun("s-dead")).toBeNull();
    expect(runStatus()).toBe("running"); // the write failed; the entry is still gone
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/schedule_runs update\/alert failed for task t-busy: .*database is locked/),
    );
  });

  it("a NON-terminal task with an old completed_at is never reaped (status filter pin)", () => {
    seedRun("t-nt", "needs_context", 300);
    expect(inFlightScheduleRun("s-dead")).toBe("t-nt");
    expect(runStatus()).toBe("running");
  });

  describe("operator alert on reap", () => {
    const quiet = () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("flipping a running row sends exactly one broadcast naming the schedule — a second caller sends none", async () => {
      quiet();
      const broadcastToAll = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
      mocks.getRouter.mockReturnValue({ broadcastToAll } as never);
      seedRun("t-alert", "failed", 300);
      expect(inFlightScheduleRun("s-dead")).toBeNull();
      expect(inFlightScheduleRun("s-dead")).toBeNull();
      await flush();
      expect(broadcastToAll).toHaveBeenCalledTimes(1);
      expect(broadcastToAll.mock.calls[0]![0]).toBe(
        '⚠️ Scheduled task "Dead" FAILED: lost: task failed but its result never reached the scheduler',
      );
    });

    it("a row already terminal → reaped silently, no broadcast", async () => {
      quiet();
      const broadcastToAll = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
      mocks.getRouter.mockReturnValue({ broadcastToAll } as never);
      seedRun("t-quiet", "failed", 300);
      getDatabase()
        .prepare("UPDATE schedule_runs SET status = 'delivery_miss' WHERE task_id = 't-quiet'")
        .run();
      expect(inFlightScheduleRun("s-dead")).toBeNull();
      await flush();
      expect(broadcastToAll).not.toHaveBeenCalled();
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("telegram down"))],
      ["throws", () => { throw new Error("router exploded"); }],
    ])("a broadcast that %s → reap still completes, no unhandled rejection", async (_label, impl) => {
      quiet();
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", onUnhandled);
      try {
        // A plain function, not vi.fn: a spy observes the returned promise
        // (settledResults), which would mark the rejection handled.
        mocks.getRouter.mockReturnValue({ broadcastToAll: impl } as never);
        seedRun("t-down", "failed", 300);
        expect(inFlightScheduleRun("s-dead")).toBeNull();
        expect(runStatus()).toBe("failed");
        await flush();
        await flush();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  it("a run row already settled is not overwritten", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedRun("t-settled", "failed", 300);
    getDatabase()
      .prepare("UPDATE schedule_runs SET status = 'delivery_miss' WHERE task_id = 't-settled'")
      .run();
    expect(inFlightScheduleRun("s-dead")).toBeNull();
    expect(runStatus()).toBe("delivery_miss");
  });
});
