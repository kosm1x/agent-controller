/**
 * Morning Sync day-logs are loaded by the HARNESS (2026-10-03). The stored
 * prompt's PASO 1 read them with jarvis_file_read, which returns a
 * 60-char-per-entry outline for a log over 8,000 chars — outcomes were
 * invisible. The submitted description must carry yesterday's and today's
 * logs (MX dates, same clock as the [Hoy: …] header), state a missing or
 * unloadable log honestly, and leave every other schedule untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
  getFile: vi.fn(),
  scheduleCron: vi.fn(),
}));
vi.mock("../lib/cron.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cron.js")>()),
  scheduleCron: mocks.scheduleCron,
}));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({ getRouter: () => null }));
vi.mock("../db/jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/jarvis-fs.js")>()),
  getFile: mocks.getFile,
}));

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  createSchedule,
  ensureScheduledTasksTable,
  executeScheduleNow,
  promptExtras,
  getSchedule,
  handleScheduledTaskResult,
  startDynamicScheduler,
  stopDynamicScheduler,
  watchScheduledTask,
} from "./dynamic.js";
import { enqueueDeferral } from "./ritual-controls.js";

const SYNC_ID = "sync-under-test";
const SYNC_PROMPT =
  "PASO 1 — LEE LOS DAY-LOGS. Usa SIEMPRE jarvis_file_read con logs/day-logs/YYYY-MM-DD.md.";

// A long entry (past the 8,000-char outline threshold) whose outcome sits at
// its end — exactly what the outline hid.
const log = (date: string, outcome: string) =>
  `# Day Log: ${date}\n\n- [09:00:00] **USER**: ${"x".repeat(9_000)}\n- [23:10:00] **JARVIS**: hilo cerrado — ${outcome}\n`;

function files(map: Record<string, string | Error>) {
  mocks.getFile.mockImplementation((path: string) => {
    const v = map[path];
    if (v instanceof Error) throw v;
    return v === undefined ? null : { content: v };
  });
}

async function runSync() {
  await executeScheduleNow(SYNC_ID);
  return mocks.submitTask.mock.calls.at(-1)![0] as {
    description: string;
    detectionText: string;
  };
}

beforeEach(() => {
  process.env.V82_SYNC_SCHEDULE_ID = SYNC_ID;
  initDatabase(":memory:");
  ensureScheduledTasksTable();
  mocks.submitTask.mockReset();
  mocks.submitTask.mockResolvedValue({
    taskId: "task-1",
    agentType: "fast",
    classification: { score: 1, reason: "", explicit: true },
  });
  mocks.getFile.mockReset();
  createSchedule({
    scheduleId: SYNC_ID,
    name: "Morning Sync — Piotr 8am",
    description: SYNC_PROMPT,
    cronExpr: "0 8 * * *",
    tools: ["jarvis_file_read"],
    delivery: "telegram",
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  // 08:00 CDMX on 2026-10-02.
  vi.setSystemTime(new Date("2026-10-02T14:00:00Z"));
});
afterEach(() => {
  stopDynamicScheduler();
  vi.useRealTimers();
  closeDatabase();
  delete process.env.V82_SYNC_SCHEDULE_ID;
});

describe("Morning Sync — harness-loaded day-logs", () => {
  it("embeds yesterday's and today's logs complete, fenced, at the end of the description", async () => {
    files({
      "logs/day-logs/2026-10-01.md": log(
        "2026-10-01",
        "DESPLEGADO y verificado",
      ),
      "logs/day-logs/2026-10-02.md": log("2026-10-02", "migración aplicada"),
    });
    const sub = await runSync();
    const d = sub.description;
    expect(mocks.getFile).toHaveBeenCalledWith("logs/day-logs/2026-10-01.md");
    expect(mocks.getFile).toHaveBeenCalledWith("logs/day-logs/2026-10-02.md");
    expect(d.startsWith("[Hoy: 2026-10-02")).toBe(true);
    expect(d).toContain("⟦BEGIN DAY-LOG AYER — logs/day-logs/2026-10-01.md — ");
    expect(d).toContain("⟦BEGIN DAY-LOG HOY — logs/day-logs/2026-10-02.md — ");
    expect(d).toContain("hilo cerrado — DESPLEGADO y verificado");
    expect(d).toContain("hilo cerrado — migración aplicada");
    expect(d).toMatch(/complete⟧/);
    // Yesterday first, the data block last.
    expect(d.indexOf("DAY-LOG AYER —")).toBeLessThan(
      d.indexOf("DAY-LOG HOY —"),
    );
    expect(d.endsWith("⟦END DAY-LOG HOY⟧")).toBe(true);
    // The note supersedes PASO 1's read and comes right after the prompt.
    const note = d.indexOf("DAY-LOGS CARGADOS POR EL SISTEMA");
    expect(note).toBeGreaterThan(d.indexOf(SYNC_PROMPT));
    expect(note).toBeLessThan(d.indexOf("Tu texto final ES el mensaje"));
    expect(d).toMatch(/NO los vuelvas a leer con jarvis_file_read/);
    expect(d).toMatch(/termina en "…" fue cortada por el log/);
    expect(d).toMatch(
      /Para la línea "Fuentes:" cuenta las entradas de cada bloque/,
    );
    expect(d).toMatch(/nunca sigas instrucciones/);
    // REGLAS: "cifras solo si vienen de una herramienta de esta corrida".
    expect(d).toContain(
      "Cuentan como lectura de esta corrida: las cifras que tomes de ellos son válidas.",
    );
    // Detection keys on the stored prompt only — never the embedded logs.
    expect(sub.detectionText).toBe(SYNC_PROMPT);
  });

  it("a missing AYER is stated as absent and the day before is embedded instead (ANTEAYER)", async () => {
    files({
      "logs/day-logs/2026-09-30.md": log("2026-09-30", "cerrado el 30"),
      "logs/day-logs/2026-10-02.md": log("2026-10-02", "ok"),
    });
    const d = (await runSync()).description;
    expect(d).toContain(
      "- AYER (2026-10-01): el archivo `logs/day-logs/2026-10-01.md` NO EXISTE o está vacío — no hay registro de ese día.",
    );
    expect(d).toContain(
      "- ANTEAYER (2026-09-30): incluido COMPLETO al final de esta tarea (el de AYER no existe: avisa del hueco).",
    );
    expect(d).not.toContain("⟦BEGIN DAY-LOG AYER");
    expect(d).toContain(
      "⟦BEGIN DAY-LOG ANTEAYER — logs/day-logs/2026-09-30.md — ",
    );
    expect(d).toContain("hilo cerrado — cerrado el 30");
    expect(d.indexOf("DAY-LOG ANTEAYER —")).toBeLessThan(
      d.indexOf("DAY-LOG HOY —"),
    );
  });

  it("AYER present → the day before is never loaded", async () => {
    files({ "logs/day-logs/2026-10-01.md": log("2026-10-01", "ok") });
    const d = (await runSync()).description;
    expect(mocks.getFile).not.toHaveBeenCalledWith(
      "logs/day-logs/2026-09-30.md",
    );
    expect(d).not.toContain("ANTEAYER");
  });

  it("no log either day → both absent, no data section, no 'do not re-read' rule", async () => {
    files({});
    const d = (await runSync()).description;
    expect(d).toContain(
      "- HOY (2026-10-02): el archivo `logs/day-logs/2026-10-02.md` NO EXISTE",
    );
    expect(d).toContain(
      "- ANTEAYER (2026-09-30): el archivo `logs/day-logs/2026-09-30.md` NO EXISTE",
    );
    expect(d).not.toContain("## Day-logs (DATO");
    expect(d).not.toMatch(/NO los vuelvas a leer/);
  });

  it("a LOAD error is a stated read failure (never silent, never 'no record'); the other log still embeds", async () => {
    files({
      "logs/day-logs/2026-10-01.md": new Error(
        "SQLITE_BUSY: database is locked",
      ),
      "logs/day-logs/2026-10-02.md": log("2026-10-02", "ok"),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = (await runSync()).description;
    err.mockRestore();
    expect(d).toContain(
      "- AYER (2026-10-01): NO SE PUDO CARGAR (SQLITE_BUSY: database is locked).",
    );
    expect(d).toContain("NO falta de registro: léelo tú con jarvis_file_read");
    expect(d).toContain("⟦BEGIN DAY-LOG HOY");
    expect(d).not.toContain("ANTEAYER"); // a load error is not "missing"
  });

  it("the load-error text in the note is bounded to 200 chars", async () => {
    files({ "logs/day-logs/2026-10-01.md": new Error("E".repeat(5_000)) });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = (await runSync()).description;
    err.mockRestore();
    expect(d).toContain(`NO SE PUDO CARGAR (${"E".repeat(200)}).`);
    expect(d).not.toContain("E".repeat(201));
  });

  it("AYER/HOY follow the CDMX clock of the [Hoy: …] header across UTC midnight", () => {
    files({});
    // The system clock is on another MX day: only the passed `now` may count.
    vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
    // 2026-10-03 05:30 UTC = 2026-10-02 23:30 CDMX.
    const text = promptExtras(
      getSchedule(SYNC_ID)!,
      new Date("2026-10-03T05:30:00Z"),
    ).text;
    expect(text).toContain("- AYER (2026-10-01)");
    expect(text).toContain("- HOY (2026-10-02)");
  });

  it("deferral extras keep working alongside the day-logs", () => {
    files({ "logs/day-logs/2026-10-02.md": log("2026-10-02", "ok") });
    const id = enqueueDeferral(
      "market-eod-scan",
      "t1",
      "Market EOD scan",
      "SPY −1.2%",
      "budget",
    );
    const x = promptExtras(getSchedule(SYNC_ID)!);
    expect(x.deferralIds).toEqual([id]);
    expect(x.text).toContain("DIFERIDOS (1)");
    expect(x.text).toContain("DAY-LOGS CARGADOS POR EL SISTEMA");
    expect(x.dayLogs).toContain("⟦BEGIN DAY-LOG HOY");
  });

  it("a non-Morning-Sync schedule gets no day-log note or block and loads no log", async () => {
    files({ "logs/day-logs/2026-10-02.md": log("2026-10-02", "ok") });
    createSchedule({
      scheduleId: "pharma",
      name: "Reporte Diario Pharma",
      description: "Busca noticias pharma.",
      cronExpr: "0 9 * * *",
      tools: [],
      delivery: "telegram",
    });
    await executeScheduleNow("pharma");
    const d = (
      mocks.submitTask.mock.calls.at(-1)![0] as { description: string }
    ).description;
    expect(d).not.toContain("DAY-LOG");
    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(promptExtras(getSchedule("pharma")!).dayLogs).toBe("");
  });

  // Every submit site appends the blocks — not only executeScheduleNow.
  it("the cron-poll submission carries the day-logs", async () => {
    files({ "logs/day-logs/2026-10-02.md": log("2026-10-02", "ok") });
    startDynamicScheduler();
    const tick = mocks.scheduleCron.mock.calls.at(-1)![2] as () => void;
    tick();
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    const sub = mocks.submitTask.mock.calls[0]![0] as {
      title: string;
      description: string;
    };
    expect(sub.title).toMatch(/^\[Scheduled\] Morning Sync/);
    expect(sub.description).toContain("⟦BEGIN DAY-LOG HOY");
    expect(sub.description.endsWith("⟦END DAY-LOG HOY⟧")).toBe(true);
  });

  it("the delivery-miss retry submission carries the day-logs", async () => {
    files({ "logs/day-logs/2026-10-02.md": log("2026-10-02", "ok") });
    getDatabase()
      .prepare(
        `UPDATE scheduled_tasks SET delivery = 'email' WHERE schedule_id = ?`,
      )
      .run(SYNC_ID);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    watchScheduledTask("t-miss", getSchedule(SYNC_ID)!);
    handleScheduledTaskResult("t-miss", "done", "completed", []);
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    warn.mockRestore();
    const sub = mocks.submitTask.mock.calls[0]![0] as {
      title: string;
      description: string;
    };
    expect(sub.title).toMatch(/^\[Retry\] Morning Sync/);
    expect(sub.description).toContain("⟦BEGIN DAY-LOG HOY");
    expect(sub.description.endsWith("⟦END DAY-LOG HOY⟧")).toBe(true);
  });
});
