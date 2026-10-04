import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase, getDatabase } from "../db/index.js";
import {
  isHarnessTool,
  minePositiveSelections,
  mineTestCases,
  selectionExpectation,
} from "./case-miner.js";

/**
 * V8.5 Phase 4.3 — positive-selection mining + flywheel retention.
 * Real in-memory DB (schema.sql provides scope_telemetry) per the
 * integration-over-mocks convention.
 */

function insertTelemetry(row: {
  message: string;
  tools_called: string[];
  tools_failed?: string[];
  feedback_signal?: string;
  created_at?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO scope_telemetry
         (task_id, message, active_groups, tools_in_scope, tools_called,
          tools_repaired, tools_failed, feedback_signal, created_at)
       VALUES (?, ?, '[]', '[]', ?, '[]', ?, ?, ?)`,
    )
    .run(
      `t-${Math.random().toString(36).slice(2)}`,
      row.message,
      JSON.stringify(row.tools_called),
      JSON.stringify(row.tools_failed ?? []),
      row.feedback_signal ?? "none",
      row.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
    );
}

beforeAll(() => {
  initDatabase(":memory:");

  // Clean, focused run — SHOULD mine
  insertTelemetry({
    message: "Busca los archivos del proyecto TMN y resume su estado actual",
    tools_called: ["jarvis_files_search", "jarvis_read"],
  });
  // Too many distinct tools — ambiguous ground truth, skip
  insertTelemetry({
    message: "Haz un análisis completo del proyecto con todas tus fuentes",
    tools_called: ["a", "b", "c", "d", "e"],
  });
  // Too-short message (flash noise), skip
  insertTelemetry({
    message: "dame el reporte",
    tools_called: ["jarvis_read"],
  });
  // Negative feedback — wrong tools by definition, skip
  insertTelemetry({
    message: "Actualiza el calendario con la junta del jueves por favor",
    tools_called: ["web_search"],
    feedback_signal: "negative",
  });
  // Failed tools — not a clean run, skip
  insertTelemetry({
    message: "Publica el artículo nuevo en el sitio de WordPress hoy",
    tools_called: ["wp_publish"],
    tools_failed: ["wp_publish"],
  });
  // Duplicate of the first message — dedup by hash
  insertTelemetry({
    message: "Busca los archivos del proyecto TMN y resume su estado actual",
    tools_called: ["jarvis_files_search", "jarvis_read"],
  });
});

describe("minePositiveSelections", () => {
  it("mines only clean, focused, prose-length runs and dedups by message", () => {
    const cases = minePositiveSelections(30, 120);
    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c.category).toBe("tool_selection");
    expect(c.case_id).toMatch(/^mined-positive-/);
    expect(c.expected).toEqual({
      tools: ["jarvis_files_search", "jarvis_read"],
      first_tools: ["jarvis_files_search"],
    });
    expect(c.weight).toBe(0.6);
    expect(c.input.message).toContain("proyecto TMN");
  });
});

describe("mineTestCases — persistence + flywheel retention", () => {
  it("persists weight and source; flywheel cases survive the 90d prune", () => {
    const db = getDatabase();
    mineTestCases(); // creates mined_test_cases, inserts the positive case

    const positive = db
      .prepare(
        `SELECT weight, source FROM mined_test_cases
         WHERE case_id LIKE 'mined-positive-%'`,
      )
      .get() as { weight: number; source: string };
    expect(positive.weight).toBe(0.6);
    expect(positive.source).toBe("mined");

    // Audit I5: EXISTING miners must keep landing at 0.8/'mined' — the
    // negative-feedback fixture row flows through mineNegativeFeedback.
    const negative = db
      .prepare(
        `SELECT weight, source FROM mined_test_cases
         WHERE case_id LIKE 'mined-feedback-neg-%'`,
      )
      .get() as { weight: number; source: string } | undefined;
    expect(negative).toBeDefined();
    expect(negative!.weight).toBe(0.8);
    expect(negative!.source).toBe("mined");

    // Age a mined case and a flywheel case past 90 days, re-run the prune.
    db.prepare(
      `INSERT INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from, created_at)
       VALUES ('old-mined', 'tool_selection', '{}', '{}', 0.8, 'mined', 'x',
               datetime('now', '-120 days'))`,
    ).run();
    db.prepare(
      `INSERT INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from, created_at)
       VALUES ('flywheel-old-pin', 'tool_selection', '{}', '{}', 1.0, 'flywheel', 'x',
               datetime('now', '-120 days'))`,
    ).run();

    mineTestCases(); // prune runs at the end

    const survivors = db
      .prepare(
        `SELECT case_id FROM mined_test_cases
         WHERE case_id IN ('old-mined', 'flywheel-old-pin')`,
      )
      .all() as Array<{ case_id: string }>;
    expect(survivors.map((s) => s.case_id)).toEqual(["flywheel-old-pin"]);
  });

  it("stops mining at the active-positive ceiling (audit W2 — gate cost bound)", () => {
    const db = getDatabase();
    // Fill to the ceiling with synthetic active positive cases.
    const ins = db.prepare(
      `INSERT OR IGNORE INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from)
       VALUES (?, 'tool_selection', '{}', '{}', 0.6, 'mined', 'x')`,
    );
    for (let i = 0; i < 140; i++) ins.run(`mined-positive-synth-${i}`);

    // Fresh mineable telemetry exists (the clean fixture row), but the
    // ceiling leaves no room.
    expect(minePositiveSelections(30, 120)).toHaveLength(0);
  });
});

describe("harness tools are never expected tools (2026-10-04)", () => {
  it("isHarnessTool: the SDK's ToolSearch and any mcp__<server>__ tool; registry names are not", () => {
    expect(isHarnessTool("ToolSearch")).toBe(true);
    expect(isHarnessTool("mcp__sequential-thinking__sequentialthinking")).toBe(
      true,
    );
    expect(isHarnessTool("mcp__playwright__browser_navigate")).toBe(true);
    expect(isHarnessTool("web_search")).toBe(false);
    expect(isHarnessTool("toolsearch")).toBe(false);
  });

  it("selectionExpectation: distinct, harness dropped, call order kept, first_tools = first real call", () => {
    expect(
      selectionExpectation([
        "ToolSearch",
        "gmail_send",
        "mcp__sequential-thinking__sequentialthinking",
        "jarvis_file_write",
        "gmail_send",
      ]),
    ).toEqual({
      tools: ["gmail_send", "jarvis_file_write"],
      first_tools: ["gmail_send"],
    });
    expect(selectionExpectation(["ToolSearch"])).toEqual({
      tools: [],
      first_tools: [],
    });
  });

  it("the miner records no harness tool, and a harness-only run mines nothing", () => {
    // The ceiling test above filled the active-positive room; free it.
    getDatabase()
      .prepare(
        `DELETE FROM mined_test_cases WHERE case_id LIKE 'mined-positive-synth-%'`,
      )
      .run();
    insertTelemetry({
      message: "Envía el resumen semanal por correo al equipo de operaciones",
      tools_called: [
        "ToolSearch",
        "mcp__sequential-thinking__sequentialthinking",
        "gmail_send",
      ],
    });
    insertTelemetry({
      message: "Piensa paso a paso cómo ordenar las tareas de esta semana",
      tools_called: ["mcp__sequential-thinking__sequentialthinking"],
    });
    const cases = minePositiveSelections(30, 120);
    const all = cases.flatMap((c) => (c.expected.tools as string[]) ?? []);
    expect(all.some(isHarnessTool)).toBe(false);
    const mail = cases.find((c) => c.input.message.includes("correo"));
    expect(mail?.expected).toEqual({
      tools: ["gmail_send"],
      first_tools: ["gmail_send"],
    });
    expect(cases.some((c) => c.input.message.includes("paso a paso"))).toBe(
      false,
    );
  });
});
