import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase, getDatabase } from "../db/index.js";
import { minePositiveSelections, mineTestCases } from "./case-miner.js";

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
