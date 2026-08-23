/**
 * Usability Phase 3.2 wiring: the real write handlers refuse unsourced
 * figures inside a run (real in-memory DB, real tool code), accept figures
 * backed by this run's tool evidence, the task's own input, a block marker
 * or the `fuente` parameter; shadow logs without rejecting; outside a run
 * nothing is checked. Mutation guard: rejection must be a real refusal —
 * the file must NOT exist afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { getFile } from "../../db/jarvis-fs.js";
import { enterRunToolContext, recordRunTool } from "../../tools/rule-of-two.js";
import { _resetToolEvidence, recordToolEvidence } from "./numbers.js";
import {
  checkArtifactProvenance,
  fuenteIsCheckable,
  provenanceMode,
} from "./provenance-gate.js";

vi.mock("../../db/jarvis-sync.js", () => ({
  syncToDrive: vi.fn(),
  syncFileToDrive: vi.fn(),
}));
const google = vi.hoisted(() => ({ googleFetch: vi.fn() }));
vi.mock("../../google/client.js", () => ({ googleFetch: google.googleFetch }));

const ENV = "PROVENANCE_GATE";
let savedEnv: string | undefined;

function seedTask(id: string, description: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, priority, agent_type)
       VALUES (?, 'Task', ?, 'running', 'medium', 'fast')`,
    )
    .run(id, description);
}

function traces(taskId: string): Array<Record<string, unknown>> {
  return (
    getDatabase()
      .prepare(
        `SELECT attrs FROM task_trace_events WHERE task_id = ? AND name = 'provenance.checked' ORDER BY id`,
      )
      .all(taskId) as Array<{ attrs: string }>
  ).map((r) => JSON.parse(r.attrs));
}

beforeEach(() => {
  initDatabase(":memory:");
  _resetToolEvidence();
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  google.googleFetch.mockReset();
});
afterEach(() => {
  closeDatabase();
  _resetToolEvidence();
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("provenanceMode", () => {
  it("defaults to enforce; off/shadow are honoured; garbage → enforce", () => {
    expect(provenanceMode({})).toBe("enforce");
    expect(provenanceMode({ PROVENANCE_GATE: "shadow" })).toBe("shadow");
    expect(provenanceMode({ PROVENANCE_GATE: "OFF" })).toBe("off");
    expect(provenanceMode({ PROVENANCE_GATE: "maybe" })).toBe("enforce");
  });
});

describe("jarvis_file_write", () => {
  it("REJECTS a figure from memory — and the file is not written", async () => {
    const { jarvisFileWriteTool } =
      await import("../../tools/builtin/jarvis-files.js");
    seedTask("t-kb", "Guarda el análisis de Tubi en el KB");
    const out = JSON.parse(
      await enterRunToolContext("t-kb", () =>
        jarvisFileWriteTool.execute({
          path: "knowledge/domain/tubi.md",
          title: "Tubi",
          content: "Tubi tiene 80M usuarios en EEUU y creció 35% en 2025.",
        }),
      ),
    );
    expect(out.error).toMatch(
      /Escritura rechazada \(jarvis_file_write\): 2 cifras sin procedencia — «80M», «35%»/,
    );
    expect(out.error).toContain("fuente:");
    expect(out.unsourced).toEqual(["80M", "35%"]);
    expect(getFile("knowledge/domain/tubi.md")).toBeNull();
    expect(traces("t-kb")).toEqual([
      expect.objectContaining({
        artifact: "kb:knowledge/domain/tubi.md",
        figures: 2,
        unsourced: 2,
        mode: "enforce",
        rejected: true,
      }),
    ]);
  });

  it("ACCEPTS figures backed by this run's tool evidence, the user's message, or a fuente:/calc: block", async () => {
    const { jarvisFileWriteTool } =
      await import("../../tools/builtin/jarvis-files.js");
    seedTask("t-ok", "El cliente reportó $12,500 MXN de ventas; guárdalo.");
    recordToolEvidence("t-ok", '{"rows": 94, "users": "80,000,000"}');
    const content = [
      "Ventas reportadas: $12,500 MXN.",
      "Usuarios: 80M; filas procesadas: 94.",
      "",
      "Margen: 35% (calc: utilidad / ventas).",
      "",
      "| Año | Sucursales |",
      "| 2025 | 7,000 |",
      "fuente: https://denue.inegi.org.mx",
    ].join("\n");
    const out = JSON.parse(
      await enterRunToolContext("t-ok", () =>
        jarvisFileWriteTool.execute({
          path: "projects/x/stats.md",
          title: "Stats",
          content,
        }),
      ),
    );
    expect(out.success).toBe(true);
    expect(getFile("projects/x/stats.md")?.content).toBe(content);
    expect(traces("t-ok")[0]).toMatchObject({
      figures: 5,
      unsourced: 0,
      rejected: false,
    });
  });

  it("shadow mode writes anyway and records the would-be rejection; outside a run nothing is checked", async () => {
    const { jarvisFileWriteTool } =
      await import("../../tools/builtin/jarvis-files.js");
    process.env[ENV] = "shadow";
    seedTask("t-sh", "x");
    const out = JSON.parse(
      await enterRunToolContext("t-sh", () =>
        jarvisFileWriteTool.execute({
          path: "a/b.md",
          title: "B",
          content: "Cap: $300M",
        }),
      ),
    );
    expect(out.success).toBe(true);
    expect(traces("t-sh")[0]).toMatchObject({
      unsourced: 1,
      mode: "shadow",
      rejected: false,
    });

    delete process.env[ENV];
    const direct = JSON.parse(
      await jarvisFileWriteTool.execute({
        path: "a/c.md",
        title: "C",
        content: "Cap: $300M",
      }),
    );
    expect(direct.success).toBe(true);
  });
});

describe("jarvis_file_update / jarvis_files_batch_write", () => {
  it("update checks only the appended text; batch reports per-item 'rejected' and writes the clean siblings", async () => {
    const {
      jarvisFileWriteTool,
      jarvisFileUpdateTool,
      jarvisFilesBatchWriteTool,
    } = await import("../../tools/builtin/jarvis-files.js");
    seedTask("t-up", "x");
    await enterRunToolContext("t-up", () =>
      jarvisFileWriteTool.execute({
        path: "p/log.md",
        title: "Log",
        content: "inicio",
      }),
    );
    const rejected = JSON.parse(
      await enterRunToolContext("t-up", () =>
        jarvisFileUpdateTool.execute({
          path: "p/log.md",
          append: "Cierre: $1,200,000 USD",
        }),
      ),
    );
    expect(rejected.error).toMatch(/jarvis_file_update.*«\$1,200,000 USD»/);
    expect(getFile("p/log.md")?.content).toBe("inicio");
    const ok = JSON.parse(
      await enterRunToolContext("t-up", () =>
        jarvisFileUpdateTool.execute({
          path: "p/log.md",
          append: "Cierre: $1,200,000 USD (supuesto: meta del trimestre)",
        }),
      ),
    );
    expect(ok.success).toBe(true);

    const batch = JSON.parse(
      await enterRunToolContext("t-up", () =>
        jarvisFilesBatchWriteTool.execute({
          files: [
            { path: "p/a.md", title: "A", content: "sin cifras" },
            { path: "p/b.md", title: "B", content: "ingresos de 45.5M" },
          ],
        }),
      ),
    );
    expect(batch.results).toEqual([
      { path: "p/a.md", status: "ok" },
      expect.objectContaining({
        path: "p/b.md",
        status: "rejected",
        error: expect.stringContaining("«45.5M»"),
      }),
    ]);
    expect(getFile("p/a.md")).not.toBeNull();
    expect(getFile("p/b.md")).toBeNull();
  });
});

describe("gsheets_write / gdocs_write", () => {
  it("sheet: numeric cells need evidence or `fuente`; the API is never called on rejection", async () => {
    const { gsheetsWriteTool } =
      await import("../../tools/builtin/google-docs.js");
    seedTask("t-sheet", "Escribe las ventas en la hoja");
    const rejected = JSON.parse(
      await enterRunToolContext("t-sheet", () =>
        gsheetsWriteTool.execute({
          spreadsheet_id: "sid",
          range: "Ventas!A:C",
          values: [["Q2", "1250000", "35%"]],
        }),
      ),
    );
    expect(rejected.error).toMatch(/gsheets_write.*2 cifras sin procedencia/);
    expect(rejected.error).toContain("parámetro `fuente`");
    expect(google.googleFetch).not.toHaveBeenCalled();

    google.googleFetch.mockResolvedValue({
      updates: { updatedRange: "Ventas!A2:C2", updatedRows: 1 },
    });
    // R3 C-3: a tool named in `fuente` must have RUN this turn.
    const notRun = JSON.parse(
      await enterRunToolContext("t-sheet", () =>
        gsheetsWriteTool.execute({
          spreadsheet_id: "sid",
          range: "Ventas!A:C",
          values: [["Q2", "1250000", "35%"]],
          fuente: "gsheets_read Ventas!A:F 2026-08-23",
        }),
      ),
    );
    expect(notRun.error).toContain("NO corriste en este turno");
    const ok = JSON.parse(
      await enterRunToolContext("t-sheet", () => {
        recordRunTool("gsheets_read");
        return gsheetsWriteTool.execute({
          spreadsheet_id: "sid",
          range: "Ventas!A:C",
          values: [["Q2", "1250000", "35%"]],
          fuente: "gsheets_read Ventas!A:F 2026-08-23",
        });
      }),
    );
    expect(ok.error).toBeUndefined();
    expect(traces("t-sheet")).toEqual([
      expect.objectContaining({ unsourced: 2, rejected: true }),
      expect.objectContaining({ unsourced: 2, rejected: true }),
      expect.objectContaining({
        unsourced: 0,
        rejected: false,
        fuente: "gsheets_read Ventas!A:F 2026-08-23",
      }),
    ]);
  });

  it("doc: a paragraph that names its source passes; one from memory is rejected", async () => {
    const { gdocsWriteTool } =
      await import("../../tools/builtin/google-docs.js");
    seedTask("t-doc", "x");
    const rejected = JSON.parse(
      await enterRunToolContext("t-doc", () =>
        gdocsWriteTool.execute({
          document_id: "d1",
          text: "El mercado vale $5.16B este año.",
        }),
      ),
    );
    expect(rejected.error).toMatch(/gdocs_write.*«\$5\.16B»/);
    expect(google.googleFetch).not.toHaveBeenCalled();
  });
});

describe("R4 audit pins", () => {
  it("C4-1: the rejection message's OWN examples, backticked or bold-prefixed, still need the tool to have run", () => {
    seedTask("t-r4", "x");
    const shapes = [
      "shell_exec wc -l ventas.csv",
      "`shell_exec wc -l ventas.csv`",
      "**Fuente:** `gsheets_read Ventas!A:F`",
      "salida de data_summarize ventas.csv",
      "la salida de shell_exec wc -l ventas.csv",
    ];
    enterRunToolContext("t-r4", () => {
      for (const f of shapes) expect(fuenteIsCheckable(f), f).toBe(false);
      recordRunTool("shell_exec");
      expect(fuenteIsCheckable("**Fuente:** `shell_exec wc -l ventas.csv`")).toBe(true);
      expect(fuenteIsCheckable("**Fuente:** `gsheets_read Ventas!A:F`")).toBe(false);
    });
    // URL / path shapes never need a tool; a bare data-source word is not provenance.
    expect(fuenteIsCheckable("https://www.inegi.org.mx/app/descarga/")).toBe(true);
    expect(fuenteIsCheckable("`/root/claude/x/ventas.csv`")).toBe(true);
    expect(fuenteIsCheckable("INEGI 2024")).toBe(false);
    expect(fuenteIsCheckable("denue")).toBe(false);
  });

  it("W-5: the persona prompt is NOT evidence for a chat task; a scheduled task's prompt IS", () => {
    seedTask("t-persona", "## Identidad — regla absoluta\nNO eres Claude. Cobertura 98.7% de hogares.");
    const chat = enterRunToolContext("t-persona", () =>
      checkArtifactProvenance({ tool: "jarvis_file_write", artifact: "kb:x", text: "Cobertura 98.7% de hogares." }),
    );
    expect(chat.ok).toBe(false);
    seedTask("t-ritual", "Genera el reporte: universo 100 mercados, equity $10,000.00.");
    const ritual = enterRunToolContext("t-ritual", () =>
      checkArtifactProvenance({ tool: "jarvis_file_write", artifact: "kb:y", text: "Universo: 100 mercados | Equity $10,000.00" }),
    );
    expect(ritual.ok).toBe(true);
  });

  it("W-7: a full-file rewrite counts the file's prior content as evidence (only NEW figures are claims)", async () => {
    const { jarvisFileWriteTool } = await import("../../tools/builtin/jarvis-files.js");
    seedTask("t-prior", "x");
    process.env[ENV] = "off";
    await enterRunToolContext("t-prior", () =>
      jarvisFileWriteTool.execute({ path: "p/readme.md", title: "R", content: "Usuarios: 1,741 registros · ingresos $12,500" }),
    );
    delete process.env[ENV];
    const same = JSON.parse(
      await enterRunToolContext("t-prior", () =>
        jarvisFileWriteTool.execute({ path: "p/readme.md", title: "R", content: "# README\nUsuarios: 1,741 registros · ingresos $12,500 · nueva sección" }),
      ),
    );
    expect(same.success).toBe(true);
    const changed = JSON.parse(
      await enterRunToolContext("t-prior", () =>
        jarvisFileWriteTool.execute({ path: "p/readme.md", title: "R", content: "Usuarios: 1,742 registros · ingresos $12,500" }),
      ),
    );
    expect(changed.error).toContain("«1,742»");
  });
});

describe("checkArtifactProvenance (unit)", () => {
  it("R1 W2: sheet dates/formulas/years/zips/phones/ids are not figures; bare counts are claims; 0.35 matches 35%", () => {
    seedTask("t-cells", "x");
    const v = enterRunToolContext("t-cells", () =>
      checkArtifactProvenance({
        tool: "gsheets_write",
        artifact: "sheet:x|A:D",
        cells: [
          ["2026-08-23", "=SUM(B2:B9)", "Norte", "94"],
          ["Ventas", 2025, "06600", "5512345678", "INV-0001", "1029384756"],
        ],
      }),
    );
    expect(v).toMatchObject({ ok: false, figures: 1, unsourced: ["94"] });
    recordToolEvidence("t-cells", "margin 35%");
    expect(
      enterRunToolContext("t-cells", () =>
        checkArtifactProvenance({ tool: "gsheets_write", artifact: "s", cells: [["Margen", 0.35]] }),
      ),
    ).toMatchObject({ ok: true, unsourced: [] });
  });

  it("R1 C5: a fuente: cell sources its OWN row only; `fuente: memoria` is not provenance (param or cell)", () => {
    seedTask("t-rows", "x");
    const rows = enterRunToolContext("t-rows", () => {
      recordRunTool("gsheets_read");
      return checkArtifactProvenance({
        tool: "gsheets_write",
        artifact: "s",
        cells: [
          ["Q1", "1,200,000", "fuente: gsheets_read Ventas!A:F"],
          ["Q2", "1,350,000", ""],
        ],
      });
    });
    expect(rows).toMatchObject({ ok: false, unsourced: ["1,350,000"] });
    const memoria = enterRunToolContext("t-rows", () =>
      checkArtifactProvenance({
        tool: "gsheets_write",
        artifact: "s",
        cells: [["Q2", "1,350,000"]],
        fuente: "memoria",
      }),
    );
    expect(memoria.ok).toBe(false);
    expect(memoria.error).toContain("«fuente: memoria» no es verificable");
    const propio = enterRunToolContext("t-rows", () =>
      checkArtifactProvenance({
        tool: "gsheets_write",
        artifact: "s",
        cells: [["Q2", "1,350,000"]],
        fuente: "mi análisis propio",
      }),
    );
    expect(propio.ok).toBe(false);
    const url = enterRunToolContext("t-rows", () =>
      checkArtifactProvenance({
        tool: "gsheets_write",
        artifact: "s",
        cells: [["Q2", "1,350,000"]],
        fuente: "https://inegi.org.mx/denue/export-2026-08",
      }),
    );
    expect(url.ok).toBe(true);
  });

  it("R1 C3: a figure the USER typed this turn is sourced (router records the message as evidence)", async () => {
    const { gsheetsWriteTool } = await import("../../tools/builtin/google-docs.js");
    seedTask("t-user", "## Identidad — regla absoluta (persona prompt, 24 KB, no user text)");
    recordToolEvidence("t-user", "Estoy viendo 975 M de impresiones en el sheet y no 776 M — corrígelo");
    google.googleFetch.mockResolvedValue({ updates: { updatedRange: "Hoja!A2:B2", updatedRows: 1 } });
    const out = JSON.parse(
      await enterRunToolContext("t-user", () =>
        gsheetsWriteTool.execute({ spreadsheet_id: "sid", range: "Hoja!A:B", values: [["Impresiones", "975M"]] }),
      ),
    );
    expect(out.error).toBeUndefined();
    expect(traces("t-user")[0]).toMatchObject({ figures: 1, unsourced: 0, rejected: false });
  });

  it("R1 C4: gdocs_replace is gated like gdocs_write", async () => {
    const { gdocsReplaceTool } = await import("../../tools/builtin/google-docs.js");
    seedTask("t-rep", "x");
    const rejected = JSON.parse(
      await enterRunToolContext("t-rep", () =>
        gdocsReplaceTool.execute({ document_id: "d1", text: "Mercado: $5.16B" }),
      ),
    );
    expect(rejected.error).toMatch(/gdocs_replace.*«\$5\.16B»/);
    expect(google.googleFetch).not.toHaveBeenCalled();
  });
});
