import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { ScheduledTaskRow } from "./dynamic.js";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  schedules: [] as unknown[],
  setScheduleActive: vi.fn(() => true),
}));
vi.mock("../db/index.js", () => ({ getDatabase: () => mocks.db }));
vi.mock("./dynamic.js", () => ({
  listSchedules: () => mocks.schedules,
  setScheduleActive: mocks.setScheduleActive,
}));

import { rituals } from "./config.js";
import { GLOBAL_MUTE_ID, activeMuteUntil, enqueueDeferral, isRitualPaused } from "./ritual-controls.js";
import {
  findEntry,
  handleRitualesCommand,
  listRitualEntries,
  parseRitualesCommand,
  parseUntil,
  renderList,
  zonedInstant,
} from "./rituales-command.js";

const NOW = new Date("2026-08-24T18:30:00Z"); // Mon 12:30 MX
const ENABLED = rituals.filter((r) => r.enabled).length;

function sched(overrides: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    id: 1,
    schedule_id: "id",
    name: "x",
    description: "",
    cron_expr: "0 8 * * *",
    tools: "[]",
    delivery: "telegram",
    email_to: null,
    email_subject: null,
    active: 1,
    last_run_at: "2026-08-24 14:00:00",
    created_at: "2026-08-01 00:00:00",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.setScheduleActive.mockClear();
  mocks.schedules = [
    sched({ id: 47, schedule_id: "6c312196-ms", name: "Morning Sync — Piotr 8am", cron_expr: "0 8 * * *" }),
    sched({ id: 58, schedule_id: "bdb82f0c-post", name: "Transición al Posthumanismo — Reflexión", cron_expr: "0 12 * * 1-5" }),
    sched({ id: 59, schedule_id: "cbd14c88-quim", name: "Química Básica — Tarjeta", cron_expr: "0 13 * * *", active: 0, last_run_at: "2026-08-23 19:00:00" }),
    sched({ id: 3, schedule_id: "c98f48b0-old", name: "PipeSong Tech Radar", cron_expr: "0 9 */3 * *", active: 0, last_run_at: "2026-06-01 15:00:00" }),
  ];
});
afterEach(() => {
  (mocks.db as Database.Database).close();
  vi.restoreAllMocks();
});

describe("parseRitualesCommand", () => {
  it("grammar", () => {
    expect(parseRitualesCommand("/rituales")).toEqual({ kind: "list" });
    expect(parseRitualesCommand("rituales")).toEqual({ kind: "list" });
    expect(parseRitualesCommand("/rituales pausa 3")).toEqual({ kind: "pause", target: "3" });
    expect(parseRitualesCommand("/rituales pausar química")).toEqual({ kind: "pause", target: "química" });
    expect(parseRitualesCommand("/rituales reanuda 3")).toEqual({ kind: "resume", target: "3" });
    expect(parseRitualesCommand("/rituales silencio hasta 15:00")).toEqual({ kind: "mute", until: "15:00" });
    expect(parseRitualesCommand("/rituales silencio 3pm")).toEqual({ kind: "mute", until: "3pm" });
    expect(parseRitualesCommand("/rituales silencio off")).toEqual({ kind: "unmute" });
    expect(parseRitualesCommand("/rituales completo 42")).toEqual({ kind: "full", id: 42 });
    expect(parseRitualesCommand("/rituales completo #7")).toEqual({ kind: "full", id: 7 });
    expect(parseRitualesCommand("/rituales qué")).toEqual({ kind: "help" });
    expect(parseRitualesCommand("ritualesco")).toBeNull();
    expect(parseRitualesCommand("dame los rituales")).toBeNull();
  });
});

describe("listRitualEntries", () => {
  it("numbers code rituals first (config order), then visible schedules; 30-day-old inactive rows are hidden", () => {
    const entries = listRitualEntries(NOW);
    expect(entries.slice(0, ENABLED).every((e) => e.kind === "ritual")).toBe(true);
    expect(entries[0].id).toBe("signal-intelligence");
    const names = entries.map((e) => e.name);
    expect(names).toContain("Morning Sync — Piotr 8am");
    expect(names).toContain("Química Básica — Tarjeta");
    expect(names).not.toContain("PipeSong Tech Radar");
    expect(entries.map((e) => e.n)).toEqual(entries.map((_, i) => i + 1));
    // Inactive rows sort last so an ageing-out row cannot renumber the active ones (R1 W7).
    expect(entries.at(-1)?.name).toBe("Química Básica — Tarjeta");
  });

  it("next fire is in the ritual's own zone; paused entries have no next", () => {
    const entries = listRitualEntries(NOW);
    const post = entries.find((e) => e.id === "bdb82f0c-post")!;
    // Mon 12:30 MX → next L-V 12:00 is Tue 18:00Z
    expect(post.next?.toISOString()).toBe("2026-08-25T18:00:00.000Z");
    const mm = entries.find((e) => e.id === "market-morning-scan")!;
    expect(mm.timezone).toBe("America/New_York");
    expect(mm.next?.toISOString()).toBe("2026-08-25T12:00:00.000Z"); // 08:00 EDT
    const quim = entries.find((e) => e.id === "cbd14c88-quim")!;
    expect(quim.active).toBe(false);
    expect(quim.next).toBeNull();
  });
});

describe("findEntry", () => {
  it("by number, by accent-insensitive prefix, ambiguity", () => {
    const entries = listRitualEntries(NOW);
    expect(findEntry(entries, "1")?.id).toBe("signal-intelligence");
    expect(findEntry(entries, "quimica")?.id).toBe("cbd14c88-quim");
    expect(findEntry(entries, "QUÍMICA BÁSICA")?.id).toBe("cbd14c88-quim");
    expect(findEntry(entries, "market")).toBe("ambiguous");
    expect(findEntry(entries, "market-eod")?.id).toBe("market-eod-scan");
    expect(findEntry(entries, "999")).toBeNull();
    expect(findEntry(entries, "zzz")).toBeNull();
  });
});

describe("parseUntil / zonedInstant", () => {
  it("MX wall-clock → UTC", () => {
    expect(zonedInstant(NOW, "America/Mexico_City", 15, 0).toISOString()).toBe("2026-08-24T21:00:00.000Z");
    expect(zonedInstant(NOW, "America/Mexico_City", 6, 0, 1).toISOString()).toBe("2026-08-25T12:00:00.000Z");
  });

  it("15:00 today; 3pm; a past hour rolls to tomorrow; mañana = 06:00 next day; garbage → null", () => {
    expect(parseUntil("15:00", NOW)?.toISOString()).toBe("2026-08-24T21:00:00.000Z");
    expect(parseUntil("3pm", NOW)?.toISOString()).toBe("2026-08-24T21:00:00.000Z");
    expect(parseUntil("las 3 pm", NOW)?.toISOString()).toBe("2026-08-24T21:00:00.000Z");
    expect(parseUntil("10:00", NOW)?.toISOString()).toBe("2026-08-25T16:00:00.000Z");
    expect(parseUntil("mañana", NOW)?.toISOString()).toBe("2026-08-25T12:00:00.000Z");
    expect(parseUntil("25:00", NOW)).toBeNull();
    expect(parseUntil("luego", NOW)).toBeNull();
  });
});

describe("handleRitualesCommand", () => {
  it("list renders every entry with state and the help line", () => {
    const out = handleRitualesCommand("/rituales", NOW)!;
    expect(out.startsWith("🗓 Rituales (hora MX)")).toBe(true);
    expect(out).toContain("1. Signal intelligence — diario 06:00 → ");
    expect(out).toContain("Química Básica — Tarjeta — diario 13:00 PAUSADO");
    expect(out).toContain("L-V 08:00 NY");
    expect(out).toContain("/rituales silencio hasta <hora>");
    expect(out).not.toContain("Silencio hasta");
  });

  it("pausa/reanuda a code ritual flips ritual_controls; a schedule flips scheduled_tasks.active", () => {
    expect(handleRitualesCommand("/rituales pausa 1", NOW)).toBe(
      "Pausado: Signal intelligence. Reanuda con /rituales reanuda Signal intelligence.",
    );
    expect(isRitualPaused("signal-intelligence")).toBe(true);
    expect(handleRitualesCommand("/rituales", NOW)).toContain("1. Signal intelligence — diario 06:00 PAUSADO");
    expect(handleRitualesCommand("/rituales reanuda signal", NOW)).toBe("Reanudado: Signal intelligence.");
    expect(isRitualPaused("signal-intelligence")).toBe(false);

    expect(handleRitualesCommand("/rituales reanuda quimica", NOW)).toBe("Reanudado: Química Básica — Tarjeta.");
    expect(mocks.setScheduleActive).toHaveBeenCalledWith("cbd14c88-quim", true);
    // The reply names the schedule (R2 W1: numbers re-sort after a pause).
    expect(handleRitualesCommand("/rituales pausa posthumanismo", NOW)).toBe(
      "Pausado: Transición al Posthumanismo — Reflexión. Reanuda con /rituales reanuda Transición al Posthumanismo.",
    );
    expect(mocks.setScheduleActive).toHaveBeenCalledWith("bdb82f0c-post", false);
  });

  it("completo <id> returns the stored full text; pending deferrals are listed with their handles", () => {
    const id = enqueueDeferral("schedule:post", "t1", "Posthumanismo — 2026-08-24", "Tesis del día: el cuerpo como hardware heredado…", "budget");
    expect(handleRitualesCommand(`/rituales completo ${id}`, NOW)).toBe(
      "📄 Posthumanismo — 2026-08-24\n\nTesis del día: el cuerpo como hardware heredado…",
    );
    expect(handleRitualesCommand("/rituales completo 999", NOW)).toContain("No hay ningún mensaje guardado con id 999");
    expect(handleRitualesCommand("/rituales", NOW)).toContain(`📬 Diferidos pendientes (1): Posthumanismo — 2026-08-24 → /rituales completo ${id}`);
  });

  it("a never-run schedule paused from the phone stays listed (R2 W4)", () => {
    mocks.schedules = [
      ...(mocks.schedules as ScheduledTaskRow[]),
      sched({ id: 60, schedule_id: "new-never-run", name: "Nuevo ritual", active: 0, last_run_at: null, created_at: "2026-08-20 00:00:00" }),
    ];
    expect(listRitualEntries(NOW).map((e) => e.name)).toContain("Nuevo ritual");
  });

  it("unknown / ambiguous targets answer without touching anything", () => {
    expect(handleRitualesCommand("/rituales pausa 99", NOW)).toContain("No encuentro");
    expect(handleRitualesCommand("/rituales pausa market", NOW)).toContain("coincide con varios");
    expect(mocks.setScheduleActive).not.toHaveBeenCalled();
    expect(isRitualPaused("market-morning-scan")).toBe(false);
  });

  it("silencio hasta sets the global mute; the list shows it; off clears it", () => {
    expect(handleRitualesCommand("/rituales silencio hasta 15:00", NOW)).toContain("🔇 Silencio hasta");
    expect(activeMuteUntil(GLOBAL_MUTE_ID, NOW)).toBe("2026-08-24T21:00:00.000Z");
    expect(renderList(listRitualEntries(NOW), NOW)).toContain("🔇 Silencio hasta");
    expect(handleRitualesCommand("/rituales silencio 99:00", NOW)).toContain("Hora no válida");
    expect(handleRitualesCommand("/rituales silencio off", NOW)).toBe("🔔 Silencio desactivado.");
    expect(activeMuteUntil(GLOBAL_MUTE_ID, NOW)).toBeNull();
  });

  it("non-commands return null", () => {
    expect(handleRitualesCommand("hola", NOW)).toBeNull();
  });
});
