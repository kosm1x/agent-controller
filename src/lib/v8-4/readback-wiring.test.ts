/**
 * Wiring guard (usability plan §1 principle 5): every write tool that claims a
 * read-back MUST declare the gate inside a run context. Run with a real
 * in-memory DB so the gate row is observable — and so disabling a handler's
 * `declareReadbackGate` call turns this RED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      await gsheetsWriteTool.execute({ spreadsheet_id: "S1", range: "Hoja!A:C", values: [["Margen bruto", "16 MDP", "40%"]], fuente: "https://docs.google.com/spreadsheets/d/S1" });
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

  it("ruling 2026-10-01: a schedule_task parked for confirmation writes nothing and declares no gate (never a failed read-back)", async () => {
    const { scheduleTaskTool } = await import("../../tools/builtin/schedule.js");
    const { ensureScheduledTasksTable, listSchedules } = await import("../../rituals/dynamic.js");
    const { ToolRegistry } = await import("../../tools/registry.js");
    const { createTaskExecutor } = await import("../../tools/task-executor.js");
    const { TaskExecutionContext } = await import("../../inference/execution-context.js");
    ensureScheduledTasksTable();
    const registry = new ToolRegistry();
    registry.register(scheduleTaskTool);
    registry.register({
      name: "gmail_send",
      requiresConfirmation: true,
      definition: { type: "function", function: { name: "gmail_send", description: "x", parameters: { type: "object", properties: {} } } },
      execute: async () => "{}",
    });
    const chat = new TaskExecutionContext("task-park", true, { routerRoot: true, canAskOperator: true, chatOrigin: true });
    const out = await enterRunToolContext("task-park", () =>
      createTaskExecutor(registry, chat)("schedule_task", {
        name: "Reporte", description: "x", cron: "0 9 * * *", tools: ["gmail_send"], delivery: "telegram",
      }),
    );
    expect(JSON.parse(out).error).toBe("CONFIRMATION_REQUIRED");
    expect(listGates("task-park")).toHaveLength(0);
    expect(listSchedules(false)).toHaveLength(0);
  });

  describe("disk tools under the KB root (item 11)", () => {
    let kb = "";
    let prevMirror: string | undefined;
    beforeEach(() => {
      prevMirror = process.env.JARVIS_KB_MIRROR_DIR;
      kb = mkdtempSync(join(tmpdir(), "mc-rb-wiring-kb-"));
      process.env.JARVIS_KB_MIRROR_DIR = kb;
      mkdirSync(join(kb, "projects/demo"), { recursive: true });
    });
    afterEach(() => {
      if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
      else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
      rmSync(kb, { recursive: true, force: true });
    });

    it("file_edit → kb: gate with the edited content's hash, and it verifies", async () => {
      const { fileEditTool } = await import("../../tools/builtin/code-editing.js");
      const { verifyKbFile } = await import("./readback-verifiers.js");
      writeFileSync(join(kb, "projects/demo/e.md"), "# E\nantes\n");
      await enterRunToolContext("task-fe", () =>
        fileEditTool.execute({ path: join(kb, "projects/demo/e.md"), old_string: "antes", new_string: "después" }),
      );
      const rows = listGates("task-fe");
      expect(rows).toHaveLength(1);
      expect(rows[0].gate_id).toBe(readbackGateId("kb:projects/demo/e.md"));
      expect(parseReadback(rows[0])).toEqual({
        tool: "file_edit",
        data: { path: "projects/demo/e.md", sha8: sha8("# E\ndespués\n") },
      });
      expect((await verifyKbFile(parseReadback(rows[0])!.data)).ok).toBe(true);
    });

    it("file_write → kb: gate with the written content's hash, and it verifies", async () => {
      const { fileWriteTool } = await import("../../tools/builtin/file.js");
      const { verifyKbFile } = await import("./readback-verifiers.js");
      await enterRunToolContext("task-fw", () =>
        fileWriteTool.execute({ path: join(kb, "projects/demo/w.md"), content: "# W\ncuerpo" }),
      );
      const rows = listGates("task-fw");
      expect(rows).toHaveLength(1);
      expect(rows[0].gate_id).toBe(readbackGateId("kb:projects/demo/w.md"));
      expect(parseReadback(rows[0])).toEqual({
        tool: "file_write",
        data: { path: "projects/demo/w.md", sha8: sha8("# W\ncuerpo") },
      });
      expect((await verifyKbFile(parseReadback(rows[0])!.data)).ok).toBe(true);
    });

    it("jarvis_file_write then file_edit on the SAME path → ONE gate holding the later hash (supersede by artifact)", async () => {
      const { jarvisFileWriteTool } = await import("../../tools/builtin/jarvis-files.js");
      const { fileEditTool } = await import("../../tools/builtin/code-editing.js");
      await enterRunToolContext("task-sup", async () => {
        await jarvisFileWriteTool.execute({ path: "projects/demo/x.md", title: "X", content: "# X\nprimera" });
        await fileEditTool.execute({ path: join(kb, "projects/demo/x.md"), old_string: "primera", new_string: "segunda" });
      });
      const rows = listGates("task-sup");
      expect(rows).toHaveLength(1);
      expect(parseReadback(rows[0])).toEqual({
        tool: "file_edit",
        data: { path: "projects/demo/x.md", sha8: sha8("# X\nsegunda") },
      });
    });
  });

  it("outside a run context no gate is declared (background tools, tests)", async () => {
    const { jarvisFileWriteTool } = await import("../../tools/builtin/jarvis-files.js");
    await jarvisFileWriteTool.execute({ path: "projects/demo/x.md", title: "X", content: "x" });
    expect(listGates("task-w")).toHaveLength(0);
  });
});

// Ruling 3c, audit round 7 (B-1b): a gate payload is stored at rest and its
// text is quoted in evidence — it holds the scrubbed text (placeholder), cut
// AFTER the scrub, never a stored credential value or a prefix of one.
describe("audit R7 B-1(b) — read-back payloads never hold a stored value", () => {
  // Synthetic, runtime-assembled; stored under a credential name.
  const PASS = "pw-" + "Q7z".repeat(6);
  async function storeSecret() {
    const { getDatabase } = await import("../../db/index.js");
    const { invalidateSecretRefs } = await import("../secret-refs.js");
    getDatabase()
      .prepare("INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)")
      .run("projects", "acme_ftp_password", PASS);
    invalidateSecretRefs();
  }

  it("jarvis_file_update: must_contain is scrubbed before the 160 cut, and the verifier still passes", async () => {
    await storeSecret();
    const { jarvisFileWriteTool, jarvisFileUpdateTool } = await import("../../tools/builtin/jarvis-files.js");
    const { verifyKbFile } = await import("./readback-verifiers.js");
    await enterRunToolContext("task-s0", () =>
      jarvisFileWriteTool.execute({ path: "projects/demo/env.md", title: "Env", content: "# Env" }),
    );
    const append = "x".repeat(160 - 5) + PASS + " fin";
    await enterRunToolContext("task-s", () =>
      jarvisFileUpdateTool.execute({ path: "projects/demo/env.md", append }),
    );
    const rows = listGates("task-s");
    expect(rows).toHaveLength(1);
    expect(rows[0].check_cmd).not.toContain(PASS.slice(0, 4));
    const data = parseReadback(rows[0])!.data as Record<string, unknown>;
    expect(data.must_contain as string).toBe("x".repeat(155) + "[ocul");
    const verdict = await verifyKbFile(data);
    expect(verdict.ok).toBe(true);
    // A failing check quotes only the scrubbed declared text.
    const bad = await verifyKbFile({ ...data, must_contain: PASS + " no está" });
    expect(bad.ok).toBe(false);
    expect(bad.evidence).not.toContain(PASS.slice(0, 4));
  });

  it("gdocs_write: snippet / written_text are scrubbed before their cuts", async () => {
    await storeSecret();
    google.googleFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(":batchUpdate")) return {};
      return { body: { content: [{ endIndex: 10 }] } };
    });
    const { gdocsWriteTool } = await import("../../tools/builtin/google-docs.js");
    await enterRunToolContext("task-doc-s", () =>
      gdocsWriteTool.execute({ document_id: "D2", text: "y".repeat(120 - 5) + PASS + " " + "z".repeat(900) }),
    );
    const rows = listGates("task-doc-s");
    expect(rows).toHaveLength(1);
    expect(rows[0].check_cmd).not.toContain(PASS.slice(0, 4));
  });

  it("gsheets_write: each first-row cell is scrubbed before its 60-char cut", async () => {
    await storeSecret();
    google.googleFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === "PUT") return { updatedRange: "Hoja!A1:B1", updatedRows: 1, updatedCells: 2 };
      return { values: [] };
    });
    const { gsheetsWriteTool } = await import("../../tools/builtin/google-docs.js");
    await enterRunToolContext("task-sheet-s", () =>
      gsheetsWriteTool.execute({ spreadsheet_id: "S9", range: "Hoja!A1:B1", values: [["x".repeat(55) + PASS, "y"]], append: false }),
    );
    const rows = listGates("task-sheet-s");
    expect(rows).toHaveLength(1);
    expect(rows[0].check_cmd).not.toContain(PASS.slice(0, 4));
    const first = parseReadback(rows[0])!.data.first_row as string[];
    expect(first[0]).toBe("x".repeat(55) + "[ocul");
  });

  it("declareReadbackGate scrubs whole stored values in any payload field", async () => {
    await storeSecret();
    const { declareReadbackGate } = await import("./readback.js");
    expect(
      declareReadbackGate("task-any", "jarvis_file_update", "kb:any.md", "crit", {
        path: "any.md",
        must_contain: "hola " + PASS,
        nested: { [PASS]: [PASS] },
      }),
    ).toBe(true);
    const rows = listGates("task-any");
    expect(rows).toHaveLength(1);
    expect(rows[0].check_cmd).not.toContain(PASS);
    expect(rows[0].check_cmd).toContain("[oculto");
  });

  it("confirmed-figure evidence scrubs the read text before its 120-char line cut", async () => {
    await storeSecret();
    const { verifyDocWrite } = await import("./readback-verifiers.js");
    google.googleFetch.mockResolvedValue({ title: "T", body: { content: [] } });
    // A gate declared with raw written_text (pre-R7 row): the contradicting
    // line is cut at 120 chars right through the stored value.
    const line = "Margen bruto 12 MDP " + "a".repeat(95) + PASS;
    const v = await verifyDocWrite({
      document_id: "D3",
      written_text: line,
      __confirmed: [{ raw: "16 MDP", label: "Margen bruto" }],
    });
    expect(v.ok).toBe(false);
    expect(v.evidence).toContain("Contradice");
    expect(v.evidence).not.toContain(PASS.slice(0, 4));
  });
});
