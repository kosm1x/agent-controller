/**
 * run_schedule — run an EXISTING dynamic schedule now (2026-09-29). Real
 * in-memory DB and the real `executeScheduleNow`; only the dispatcher and the
 * messaging router are mocked, so the in-flight guard is exercised through
 * dynamic.ts's own pending-run tracking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
  getRouter: vi.fn(() => null),
  stores: [] as unknown[],
}));
vi.mock("../../dispatch/dispatcher.js", () => ({
  submitTask: mocks.submitTask,
}));
vi.mock("../../messaging/index.js", () => ({ getRouter: mocks.getRouter }));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  createSchedule,
  ensureScheduledTasksTable,
  getSchedule,
  handleScheduledTaskFailure,
  handleScheduledTaskResult,
  inFlightScheduleRun,
} from "../../rituals/dynamic.js";
import {
  BACKGROUND_ORIGIN,
  enterRunToolContext,
  runToolContext,
} from "../rule-of-two.js";
import {
  deleteScheduleTool,
  listSchedulesTool,
  runScheduleTool,
  scheduleTaskTool,
} from "./schedule.js";

const CHAT_ORIGIN = { source: "operator" as const, threadId: "telegram:1" };

function submitted(taskId: string) {
  return {
    taskId,
    agentType: "fast",
    classification: { score: 1, reason: "", explicit: true },
  };
}

function seed(
  scheduleId: string,
  opts: { delivery?: "telegram" | "email" | "both"; emailTo?: string } = {},
): void {
  createSchedule({
    scheduleId,
    name: "Reporte Diario Pharma",
    description: "Busca noticias de pharma y cáncer.",
    cronExpr: "0 8 * * *",
    tools: ["web_search"],
    delivery: opts.delivery ?? "telegram",
    emailTo: opts.emailTo,
  });
}

/** Run the tool the way a chat task does: inside an operator run context. */
async function runInChat(args: Record<string, unknown>) {
  const raw = await enterRunToolContext(
    "chat-task",
    () => runScheduleTool.execute(args),
    CHAT_ORIGIN,
  );
  return JSON.parse(raw as string) as Record<string, unknown>;
}

let taskSeq = 0;
beforeEach(() => {
  initDatabase(":memory:");
  ensureScheduledTasksTable();
  taskSeq = 0;
  mocks.stores.length = 0;
  mocks.submitTask.mockReset();
  mocks.submitTask.mockImplementation(async () => {
    mocks.stores.push(runToolContext.getStore());
    return submitted(`task-${++taskSeq}`);
  });
});
afterEach(() => {
  // Drain any run a test left pending so the module map starts clean.
  for (const id of ["s1", "s2"]) {
    const t = inFlightScheduleRun(id);
    if (t) handleScheduledTaskFailure(t, "test cleanup");
  }
  closeDatabase();
  vi.restoreAllMocks();
});

describe("run_schedule — definition", () => {
  it("is a confirmed, non-deferred write tool with one required schedule_id", () => {
    expect(runScheduleTool.name).toBe("run_schedule");
    expect(runScheduleTool.definition.function.name).toBe("run_schedule");
    expect(runScheduleTool.readOnlyHint).toBe(false);
    expect(runScheduleTool.destructiveHint).toBe(true);
    expect(runScheduleTool.idempotentHint).toBe(false);
    expect(runScheduleTool.openWorldHint).toBe(true);
    expect(runScheduleTool.requiresConfirmation).toBe(true);
    expect(runScheduleTool.deferred).toBeUndefined();
    expect(runScheduleTool.triggerPhrases).toContain(
      "ejecuta ahora el schedule",
    );
    const params = runScheduleTool.definition.function.parameters as {
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
    expect(params.required).toEqual(["schedule_id"]);
    expect(params.properties.schedule_id.type).toBe("string");
    expect(params.properties.schedule_id.description).toMatch(/list_schedules/);
    const desc = runScheduleTool.definition.function.description;
    expect(desc).toContain("USE WHEN:");
    expect(desc).toContain("DO NOT USE WHEN:");
    expect(desc).toContain("schedule_task");
    // Truthful on the claude-sdk path, where no confirmation gate runs.
    expect(desc).not.toMatch(/needs the user's confirmation/i);
    expect(desc).toMatch(/does not re-send the last report/);
  });
});

describe("run_schedule — refusals", () => {
  it.each([
    [{}],
    [{ schedule_id: "" }],
    [{ schedule_id: "   " }],
    [{ schedule_id: 42 }],
  ])(
    "missing or empty schedule_id %j → {error}, nothing submitted",
    async (args) => {
      const out = await runInChat(args);
      expect(out.error).toMatch(/schedule_id/);
      expect(out.success).toBeUndefined();
      expect(mocks.submitTask).not.toHaveBeenCalled();
    },
  );

  it("unknown id → {error}, nothing submitted", async () => {
    const out = await runInChat({ schedule_id: "nope" });
    expect(out.error).toMatch(/No existe el schedule nope/);
    expect(mocks.submitTask).not.toHaveBeenCalled();
  });

  it("inactive schedule → {error} naming both resume paths, nothing submitted", async () => {
    seed("s1");
    getDatabase()
      .prepare("UPDATE scheduled_tasks SET active = 0 WHERE schedule_id = 's1'")
      .run();
    const out = await runInChat({ schedule_id: "s1" });
    expect(out.error).toMatch(/inactivo/);
    expect(out.error).toContain("/rituales reanuda Reporte Diario Pharma");
    expect(out.error).toContain("./mc-ctl schedule-resume s1");
    expect(mocks.submitTask).not.toHaveBeenCalled();
    expect(getSchedule("s1")!.last_run_at).toBeNull();
  });
});

describe("run_schedule — happy path", () => {
  it("submits the cron-shaped run and returns the spawned task id + delivery", async () => {
    seed("s1", { delivery: "email", emailTo: "ana@example.com" });
    const out = await runInChat({ schedule_id: " s1 " });
    expect(out).toMatchObject({
      success: true,
      schedule_id: "s1",
      task_id: "task-1",
      name: "Reporte Diario Pharma",
      delivery: "email",
      email_to: "ana@example.com",
    });
    expect(out.message).toMatch(/iniciada \(task task-1\)/);
    expect(out.message).toContain("email a ana@example.com");
    expect(out.error).toBeUndefined();

    expect(mocks.submitTask).toHaveBeenCalledTimes(1);
    const sub = mocks.submitTask.mock.calls[0][0];
    expect(sub.title).toMatch(
      /^\[Scheduled\] Reporte Diario Pharma — \d{4}-\d{2}-\d{2}$/,
    );
    expect(sub.description).toContain("Busca noticias de pharma y cáncer.");
    expect(sub.description).toContain("gmail_send a ana@example.com");
    expect(sub.detectionText).toBe("Busca noticias de pharma y cáncer.");
    expect(sub.agentType).toBe("fast");
    expect(sub.interactive).toBe(false);
    expect(sub.tools).toEqual(["web_search", "gmail_send"]);
    expect(sub.tags).toEqual(["scheduled", "immediate", "schedule:s1"]);
    expect(sub.gatesSource).toBe("ritual");
    expect(getSchedule("s1")!.last_run_at).not.toBeNull();
    expect(inFlightScheduleRun("s1")).toBe("task-1");
  });

  it("telegram and both deliveries are described to the user", async () => {
    seed("s1");
    expect((await runInChat({ schedule_id: "s1" })).message).toMatch(
      /llegará por Telegram/,
    );
    seed("s2", { delivery: "both" });
    const both = await runInChat({ schedule_id: "s2" });
    expect(both.message).toContain(
      "Telegram y email a el destinatario por defecto",
    );
    expect(both.email_to).toBeNull();
  });
});

describe("run_schedule — callers (no loops from background runs)", () => {
  it("a background run (cron, ritual, a run it started) is refused, nothing submitted", async () => {
    seed("s1");
    const raw = await enterRunToolContext(
      "scheduled-task",
      () => runScheduleTool.execute({ schedule_id: "s1" }),
      BACKGROUND_ORIGIN,
    );
    const out = JSON.parse(raw as string) as Record<string, unknown>;
    expect(out.error).toMatch(/solo está disponible en una conversación/);
    expect(out.success).toBeUndefined();
    expect(mocks.submitTask).not.toHaveBeenCalled();
    expect(getSchedule("s1")!.last_run_at).toBeNull();
  });

  it("a run with no explicit origin and no parent reads as background → refused", async () => {
    seed("s1");
    const raw = await enterRunToolContext("api-task", () =>
      runScheduleTool.execute({ schedule_id: "s1" }),
    );
    expect(JSON.parse(raw as string).error).toMatch(/segundo plano/);
    expect(mocks.submitTask).not.toHaveBeenCalled();
  });

  it("an operator chat run starts it", async () => {
    seed("s1");
    expect((await runInChat({ schedule_id: "s1" })).task_id).toBe("task-1");
  });

  it("no run context (the router's confirmed call) starts it", async () => {
    seed("s1");
    const out = JSON.parse(
      (await runScheduleTool.execute({ schedule_id: "s1" })) as string,
    ) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.task_id).toBe("task-1");
  });
});

describe("run_schedule — run context (item 4)", () => {
  it("submits OUTSIDE the chat run's context — a root task like the cron's", async () => {
    seed("s1");
    await runInChat({ schedule_id: "s1" });
    expect(mocks.stores).toEqual([undefined]);
  });

  it("schedule_task's immediate run is submitted outside the chat context too", async () => {
    const raw = await enterRunToolContext(
      "chat-task",
      () =>
        scheduleTaskTool.execute({
          name: "Nuevo",
          description: "x",
          cron: "0 9 * * *",
          tools: [],
          delivery: "telegram",
        }),
      CHAT_ORIGIN,
    );
    expect(JSON.parse(raw as string).success).toBe(true);
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.stores).toEqual([undefined]);
  });
});

describe("run_schedule — in-flight guard", () => {
  it("refuses a second run while the first is pending; released after its result", async () => {
    seed("s1");
    expect((await runInChat({ schedule_id: "s1" })).task_id).toBe("task-1");
    const second = await runInChat({ schedule_id: "s1" });
    expect(second.error).toMatch(/en curso \(task task-1\)/);
    expect(mocks.submitTask).toHaveBeenCalledTimes(1);

    handleScheduledTaskResult("task-1", "reporte", "completed", []);
    const third = await runInChat({ schedule_id: "s1" });
    expect(third.task_id).toBe("task-2");
  });

  it("released after the run fails", async () => {
    seed("s1");
    await runInChat({ schedule_id: "s1" });
    handleScheduledTaskFailure("task-1", "boom");
    expect((await runInChat({ schedule_id: "s1" })).task_id).toBe("task-2");
  });

  it("refuses while the first submission is still being set up", async () => {
    seed("s1");
    let release!: () => void;
    mocks.submitTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(submitted("task-slow"));
        }),
    );
    const first = runInChat({ schedule_id: "s1" });
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    const second = await runInChat({ schedule_id: "s1" });
    expect(second.error).toMatch(/en curso/);
    release();
    expect((await first).task_id).toBe("task-slow");
    expect(mocks.submitTask).toHaveBeenCalledTimes(1);
  });

  it("a rejected submission is logged, returned as {error}, and releases the guard", async () => {
    seed("s1");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.submitTask.mockRejectedValueOnce(new Error("db locked"));
    const out = await runInChat({ schedule_id: "s1" });
    expect(out.error).toBe(
      "No pude iniciar «Reporte Diario Pharma»: db locked",
    );
    expect(out.success).toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      expect.stringMatching(/^\[run_schedule\] Failed to start .*db locked/),
    );
    expect(inFlightScheduleRun("s1")).toBeNull();
    expect((await runInChat({ schedule_id: "s1" })).task_id).toBe("task-1");
  });
});

// Whole-text pins: this description is what the model reads when it chooses
// a tool. No handler is called.
describe("delete_schedule — description text", () => {
  it("the whole description, with its not-for block", () => {
    expect(deleteScheduleTool.definition.function.description).toBe(`Delete a recurring scheduled task by its schedule_id. Use list_schedules when it is among your tools to look up the IDs.

DO NOT USE WHEN:
- The user wants to pause a schedule or stop it for a while: this tool deletes the schedule for good, with no undo; the /rituales pausa command pauses it and keeps it resumable.
- The routine is a built-in ritual: this tool deletes only stored schedules and returns "not found" for any other id.
- A run of the schedule has already started and the user wants it stopped: deleting the schedule does not cancel a run in progress.`);
  });

  // The deferred catalog shows the first 120 characters of the whole text:
  // they are exactly the two opening sentences, with no line break.
  it("the catalog cut (first 120 characters) is exactly the two opening sentences", () => {
    expect(deleteScheduleTool.definition.function.description.slice(0, 120)).toBe(
      "Delete a recurring scheduled task by its schedule_id. Use list_schedules when it is among your tools to look up the IDs.",
    );
  });
});

// Description pins: each tool's whole description text as registered, and the exact text of the parameters pinned below.
describe("tool description texts", () => {
  it("schedule_task: the whole description", () => {
    expect(scheduleTaskTool.definition.function.description).toBe(`Create a recurring scheduled task that runs automatically on a cron schedule.

DO NOT USE WHEN: the user wants a calendar appointment or an entry on their agenda (a schedule runs Jarvis tasks; it is not a calendar event).
Use this when the user asks for recurring reports, daily summaries, periodic checks, or any task that should repeat on a schedule.

The task will be executed autonomously — you write the task description (what to do), specify the tools needed, and choose the delivery method (telegram, email, or both).

Examples:
- "Send me a daily AI news report at 8am" → cron "0 8 * * *", tools: ["web_search", "gmail_send"], delivery: "email", email_to: the address the user gives
- "Every Monday remind me of my weekly goals" → cron "0 9 * * 1", tools: ["jarvis_file_read"], delivery: "telegram"
- "Check my overdue tasks twice a day" → cron "0 9,18 * * *", tools: ["jarvis_file_read"], delivery: "telegram"

Cron format: minute hour day-of-month month day-of-week
- "0 8 * * *" = every day at 8:00 AM
- "0 8 * * 1-5" = weekdays at 8:00 AM
- "0 9,18 * * *" = twice daily at 9:00 AM and 6:00 PM
- "30 7 * * 1" = every Monday at 7:30 AM

All times are in the user's timezone (Mexico City).

DO NOT schedule tasks that send emails or modify data without explicit user request.
Scheduled tasks run AUTONOMOUSLY — only schedule read/report tasks unless the user specifically asks for write actions.

AFTER CREATING: Report the schedule name, cron in human-readable form, and delivery method.`);
  });

  it("schedule_task: the email_to parameter text", () => {
    const params = scheduleTaskTool.definition.function.parameters as { properties: Record<string, { description: string }> };
    expect(params.properties.email_to.description).toBe("Email recipient (required if delivery is 'email' or 'both').");
  });
  it("list_schedules: the whole description", () => {
    expect(listSchedulesTool.definition.function.description).toBe(`List all active recurring scheduled tasks (reports, monitors, syncs). Shows: name, cron schedule, delivery method, and last run time.

DO NOT USE WHEN:
- The user asks about their agenda, meetings or events → use calendar_list when it is among your tools.

USE WHEN:
- User asks "qué tareas tengo programadas", "mis schedules", "tareas recurrentes"
- User wants to verify a report is scheduled
- Before creating/deleting a schedule — check what already exists

RELATED: schedule_task (create), run_schedule (run now), delete_schedule (remove)`);
  });
  it("run_schedule: the whole description", () => {
    expect(runScheduleTool.definition.function.description).toBe(`Run an EXISTING recurring schedule now, on demand, outside its cron time. It is the same run the cron starts (same prompt, tools, gates and delivery: Telegram, email or both), marked as a manual run. It starts in the background and this tool returns at once; the report arrives later through the schedule's own delivery, not in this reply.

USE WHEN:
- "ejecuta ahora el schedule X", "corre el reporte ahora", "lanza la rutina de X", "run the daily report now"
- The user wants one extra run of a schedule that already exists

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- The schedule does not exist yet → schedule_task (it also runs once on creation)
- The user only wants to see the schedules or their last run → list_schedules
- The user wants to stop or remove a schedule → delete_schedule

Get schedule_id from list_schedules first. If the request does not make clear WHICH schedule, ask the user before calling: the run delivers, possibly an email to a third party. Refused when the id is unknown, the schedule is inactive (paused), a run of it is still in progress (no duplicate deliveries), or the caller is a background task (only a conversation with the user can start a run).

It is an extra run, not a re-send: it leaves out items already sent in earlier runs, and the items it sends count as sent for the next run. It does not re-send the last report.

AFTER STARTING: tell the user the run started and where the result will arrive (delivery, email_to).`);
  });
});
