import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  getSchedule: vi.fn(),
  googleFetch: vi.fn(),
}));
vi.mock("../../db/jarvis-fs.js", () => ({ getFile: mocks.getFile }));
vi.mock("../../rituals/dynamic.js", () => ({ getSchedule: mocks.getSchedule }));
vi.mock("../../google/client.js", () => ({ googleFetch: mocks.googleFetch }));

import {
  registerReadbackVerifiers,
  verifyDocWrite,
  verifyKbFile,
  verifySchedule,
  verifySheetWrite,
} from "./readback-verifiers.js";
import { _resetReadbacks, hasReadback, sha8 } from "./readback.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  _resetReadbacks();
});

describe("verifyKbFile", () => {
  it("met when the row exists with the written hash; failed on missing row or different content", async () => {
    mocks.getFile.mockReturnValue({ content: "hola", updated_at: "2026-08-23 01:00:00" });
    expect(await verifyKbFile({ path: "a.md", sha8: sha8("hola") })).toMatchObject({ ok: true });
    expect((await verifyKbFile({ path: "a.md", sha8: sha8("otro") })).evidence).toContain("contenido distinto");
    mocks.getFile.mockReturnValue(null);
    expect((await verifyKbFile({ path: "a.md", sha8: "x" })).evidence).toContain("no existe");
  });

  it("R1 audit W8: an update proves the appended text is PRESENT and the row is fresh — the #11750 'never persisted' class", async () => {
    mocks.getFile.mockReturnValue({ content: "# Log\n\nentrada vieja", updated_at: "2026-08-23 01:00:00" });
    const stale = await verifyKbFile({ path: "log.md", must_contain: "entrada nueva", declared_at: "2026-08-23 02:00:00" });
    expect(stale.ok).toBe(false);
    expect(stale.evidence).toContain("el texto agregado no aparece");
    mocks.getFile.mockReturnValue({ content: "# Log\n\nentrada vieja\n\nentrada  nueva", updated_at: "2026-08-23 02:00:01" });
    expect(await verifyKbFile({ path: "log.md", must_contain: "entrada nueva", declared_at: "2026-08-23 02:00:00" })).toMatchObject({ ok: true });
    mocks.getFile.mockReturnValue({ content: "x", updated_at: "2026-08-23 01:00:00" });
    expect((await verifyKbFile({ path: "log.md", declared_at: "2026-08-23 02:00:00" })).evidence).toContain("sin cambios desde");
  });
});

describe("verifySheetWrite", () => {
  it("compares the first written row cell by cell (corpus 11959: 16 MDP confirmed, 12 MDP written)", async () => {
    mocks.googleFetch.mockResolvedValue({ values: [["Margen bruto", "12 MDP", "30%"]] });
    const bad = await verifySheetWrite({ spreadsheet_id: "s", range: "Hoja!A5:C5", first_row: ["Margen bruto", "16 MDP", "40%"] });
    expect(bad.ok).toBe(false);
    expect(bad.evidence).toContain("col 2 dice «12 MDP», escribí «16 MDP»");
    mocks.googleFetch.mockResolvedValue({ values: [["Margen bruto", "16 MDP", "40%"]] });
    const ok = await verifySheetWrite({ spreadsheet_id: "s", range: "Hoja!A5:C5", first_row: ["Margen bruto", "16 MDP", "40%"] });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.evidence).toContain("Hoja!A5:C5");
    mocks.googleFetch.mockResolvedValue({});
    expect((await verifySheetWrite({ spreadsheet_id: "s", range: "Hoja!A5:C5", first_row: ["x"] })).evidence).toContain("vacío");
  });
});

describe("verifyDocWrite", () => {
  it("met when the doc body contains the written snippet (whitespace-normalized); failed otherwise", async () => {
    mocks.googleFetch.mockResolvedValue({
      title: "W34",
      body: { content: [{ paragraph: { elements: [{ textRun: { content: "Resumen  W34\n" } }, { textRun: { content: "para principiantes" } }] } }] },
    });
    expect(await verifyDocWrite({ document_id: "d", snippet: "Resumen W34 para" })).toMatchObject({ ok: true });
    expect((await verifyDocWrite({ document_id: "d", snippet: "Texto que nunca escribí" })).evidence).toContain("no contiene");
  });
});

describe("verifySchedule", () => {
  it("requires an existing, active row with the cron we set", async () => {
    mocks.getSchedule.mockReturnValue({ name: "Química", active: 1, cron_expr: "0 13 * * *" });
    expect(await verifySchedule({ schedule_id: "abc", cron_expr: "0 13 * * *" })).toMatchObject({ ok: true });
    expect((await verifySchedule({ schedule_id: "abc", cron_expr: "0 9 * * *" })).evidence).toContain("cron");
    mocks.getSchedule.mockReturnValue({ name: "Química", active: 0, cron_expr: "0 13 * * *" });
    expect((await verifySchedule({ schedule_id: "abc" })).evidence).toContain("inactivo");
    mocks.getSchedule.mockReturnValue(null);
    expect((await verifySchedule({ schedule_id: "abc" })).evidence).toContain("no existe");
  });
});

describe("registerReadbackVerifiers", () => {
  it("registers the six write classes", () => {
    registerReadbackVerifiers();
    for (const t of ["jarvis_file_write", "jarvis_file_update", "jarvis_files_batch_write", "gsheets_write", "gdocs_write", "schedule_task"]) {
      expect(hasReadback(t), t).toBe(true);
    }
  });
});

describe("cellEquals (USER_ENTERED round-trips)", () => {
  it("treats formatted/numeric equivalents as equal, real differences as different", async () => {
    const { cellEquals } = await import("./readback-verifiers.js");
    expect(cellEquals("0.4", "40%")).toBe(true);
    expect(cellEquals("40%", "40 %")).toBe(true);
    expect(cellEquals("1000", "1,000")).toBe(true);
    expect(cellEquals("$16", "16")).toBe(true);
    expect(cellEquals("16 MDP", "16 mdp")).toBe(true);
    expect(cellEquals("12 MDP", "16 MDP")).toBe(false);
    expect(cellEquals("0.3", "40%")).toBe(false);
    // R1 audit W9: dates, formulas, accounting negatives
    expect(cellEquals("22/08/2026", "2026-08-22")).toBe(true);
    expect(cellEquals("8/22/2026", "2026-08-22")).toBe(true);
    expect(cellEquals("23/08/2026", "2026-08-22")).toBe(false);
    expect(cellEquals("42", "=SUM(A1:A2)")).toBe(true);
    expect(cellEquals("(1,234)", "-1234")).toBe(true);
  });
});
