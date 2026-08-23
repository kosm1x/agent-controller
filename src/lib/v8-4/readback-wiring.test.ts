/**
 * Wiring guard (usability plan §1 principle 5): every write tool that claims a
 * read-back MUST declare the gate inside a run context. Run with a real
 * in-memory DB so the gate row is observable — and so disabling a handler's
 * `declareReadbackGate` call turns this RED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "../../db/index.js";
import { enterRunToolContext } from "../../tools/rule-of-two.js";
import { listGates } from "./gates.js";
import { _resetReadbacks, parseReadback, readbackGateId, sha8 } from "./readback.js";
import { registerReadbackVerifiers } from "./readback-verifiers.js";

vi.mock("../../db/jarvis-sync.js", () => ({ syncToDrive: vi.fn(), syncFileToDrive: vi.fn() }));
vi.mock("../../db/jarvis-reindex.js", async (orig) => ({ ...(await orig<object>()), }));
const google = vi.hoisted(() => ({ googleFetch: vi.fn() }));
vi.mock("../../google/client.js", () => ({ googleFetch: google.googleFetch }));
vi.mock("../../rituals/dynamic.js", async (orig) => ({
  ...(await orig<object>()),
  executeScheduleNow: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  initDatabase(":memory:");
  _resetReadbacks();
  registerReadbackVerifiers();
});
afterEach(() => {
  closeDatabase();
  _resetReadbacks();
});

describe("write tools declare read-back gates inside a run", () => {
  it("jarvis_file_write → artifact-keyed gate with the content hash", async () => {
    const { jarvisFileWriteTool } = await import("../../tools/builtin/jarvis-files.js");
    const out = await enterRunToolContext("task-w", () =>
      jarvisFileWriteTool.execute({ path: "projects/demo/notes.md", title: "Notas", content: "# Notas\n\nhola" }),
    );
    expect(JSON.parse(out as string)).toMatchObject({ success: true });
    const rows = listGates("task-w");
    expect(rows).toHaveLength(1);
    expect(rows[0].gate_id).toBe(readbackGateId("kb:projects/demo/notes.md"));
    expect(parseReadback(rows[0])).toEqual({
      tool: "jarvis_file_write",
      data: { path: "projects/demo/notes.md", sha8: sha8("# Notas\n\nhola") },
    });
  });

  it("jarvis_file_update → gate proving the appended text + freshness (not a post-update hash)", async () => {
    const { jarvisFileWriteTool, jarvisFileUpdateTool } = await import("../../tools/builtin/jarvis-files.js");
    await enterRunToolContext("task-u0", () =>
      jarvisFileWriteTool.execute({ path: "projects/demo/log.md", title: "Log", content: "a" }),
    );
    await enterRunToolContext("task-u", () =>
      jarvisFileUpdateTool.execute({ path: "projects/demo/log.md", append: "b" }),
    );
    const rows = listGates("task-u");
    expect(rows).toHaveLength(1);
    const data = parseReadback(rows[0])?.data as Record<string, unknown>;
    expect(data.path).toBe("projects/demo/log.md");
    expect(data.must_contain).toBe("b");
    expect(data.declared_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(data.sha8).toBeUndefined();
  });

  it("jarvis_file_write then jarvis_file_update on the SAME path → ONE gate, pointing at the update (R1 audit C1)", async () => {
    const { jarvisFileWriteTool, jarvisFileUpdateTool } = await import("../../tools/builtin/jarvis-files.js");
    await enterRunToolContext("task-same", async () => {
      await jarvisFileWriteTool.execute({ path: "projects/demo/doc.md", title: "Doc", content: "primera versión" });
      await jarvisFileUpdateTool.execute({ path: "projects/demo/doc.md", append: "segunda sección" });
    });
    const rows = listGates("task-same");
    expect(rows).toHaveLength(1);
    expect(parseReadback(rows[0])?.tool).toBe("jarvis_file_update");
    expect(parseReadback(rows[0])?.data).toMatchObject({ must_contain: "segunda sección" });
  });

  it("jarvis_files_batch_write → one gate per file (R2 audit W3)", async () => {
    const { jarvisFilesBatchWriteTool } = await import("../../tools/builtin/jarvis-files.js");
    await enterRunToolContext("task-batch", () =>
      jarvisFilesBatchWriteTool.execute({
        files: [
          { path: "projects/demo/a.md", title: "A", content: "aa" },
          { path: "projects/demo/b.md", title: "B", content: "bb" },
        ],
      }),
    );
    const rows = listGates("task-batch");
    expect(rows.map((r) => parseReadback(r)!.data.path).sort()).toEqual(["projects/demo/a.md", "projects/demo/b.md"]);
    expect(rows.every((r) => parseReadback(r)!.tool === "jarvis_files_batch_write")).toBe(true);
  });

  it("gsheets_write: two appends to the same tab are TWO proofs (R2 audit W1)", async () => {
    let n = 0;
    google.googleFetch.mockImplementation(async (url: string) => {
      if (url.includes(":append")) { n++; return { updates: { updatedRange: `Hoja!A${4 + n}:C${4 + n}`, updatedRows: 1, updatedCells: 3 } }; }
      return { values: [] };
    });
    const { gsheetsWriteTool } = await import("../../tools/builtin/google-docs.js");
    await enterRunToolContext("task-sheet2", async () => {
      await gsheetsWriteTool.execute({ spreadsheet_id: "S1", range: "Hoja!A:C", values: [["r1", "x", "y"]] });
      await gsheetsWriteTool.execute({ spreadsheet_id: "S1", range: "Hoja!A:C", values: [["r2", "x", "y"]] });
    });
    expect(listGates("task-sheet2")).toHaveLength(2);
  });

  it("gsheets_write (append + overwrite) → one gate per sheet/range with the capped first row (R1 audit W7)", async () => {
    google.googleFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url.includes(":append")) return { updates: { updatedRange: "Hoja!A5:C5", updatedRows: 1, updatedCells: 3 } };
      if (opts?.method === "PUT") return { updatedRange: "Hoja!K30:L30", updatedRows: 1, updatedCells: 2 };
      return { values: [] }; // dedup read
    });
    const { gsheetsWriteTool } = await import("../../tools/builtin/google-docs.js");
    await enterRunToolContext("task-sheet", async () => {
      await gsheetsWriteTool.execute({ spreadsheet_id: "S1", range: "Hoja!A:C", values: [["Margen bruto", "16 MDP", "40%"]] });
      await gsheetsWriteTool.execute({ spreadsheet_id: "S1", range: "Hoja!K30:L30", values: [["x".repeat(100), "y"]], append: false });
    });
    const rows = listGates("task-sheet");
    expect(rows).toHaveLength(2);
    const payloads = rows.map((r) => parseReadback(r)!.data);
    expect(payloads).toContainEqual({ spreadsheet_id: "S1", range: "Hoja!A5:C5", first_row: ["Margen bruto", "16 MDP", "40%"] });
    const over = payloads.find((p) => p.range === "Hoja!K30:L30")!;
    expect((over.first_row as string[])[0]).toHaveLength(60);
  });

  it("gdocs_write → gate with the document id and the first 120 chars (R1 audit W7)", async () => {
    google.googleFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(":batchUpdate")) return {};
      return { body: { content: [{ endIndex: 10 }] } };
    });
    const { gdocsWriteTool } = await import("../../tools/builtin/google-docs.js");
    await enterRunToolContext("task-doc", () =>
      gdocsWriteTool.execute({ document_id: "D1", text: "Resumen W34 para principiantes. " + "z".repeat(200) }),
    );
    const rows = listGates("task-doc");
    expect(rows).toHaveLength(1);
    const data = parseReadback(rows[0])!.data;
    expect(data.document_id).toBe("D1");
    expect((data.snippet as string).length).toBe(120);
  });

  it("schedule_task → gate; delete_schedule in the same task withdraws it (R1 audit C1/W7)", async () => {
    const { scheduleTaskTool, deleteScheduleTool } = await import("../../tools/builtin/schedule.js");
    const { ensureScheduledTasksTable } = await import("../../rituals/dynamic.js");
    ensureScheduledTasksTable();
    let created = "";
    let raw = "";
    await enterRunToolContext("task-sched", async () => {
      raw = (await scheduleTaskTool.execute({ name: "Prueba", description: "x", cron: "0 9 * * *", tools: [], delivery: "telegram" })) as string;
      const out = JSON.parse(raw);
      created = out.schedule_id ?? out.scheduleId ?? "";
    });
    expect(created, raw).not.toBe("");
    const rows = listGates("task-sched");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("pending");
    await enterRunToolContext("task-sched", () => deleteScheduleTool.execute({ schedule_id: created, confirmed: true }));
    expect(listGates("task-sched")[0].state).toBe("abandoned");
  });

  it("outside a run context no gate is declared (background tools, tests)", async () => {
    const { jarvisFileWriteTool } = await import("../../tools/builtin/jarvis-files.js");
    await jarvisFileWriteTool.execute({ path: "projects/demo/x.md", title: "X", content: "x" });
    expect(listGates("task-w")).toHaveLength(0);
  });
});
