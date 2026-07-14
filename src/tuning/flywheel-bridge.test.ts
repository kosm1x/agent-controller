/**
 * Excelente→flywheel auto-bridge tests — V8.5 Phase 4.7.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { bridgePraisedTaskToEvalCase } from "./flywheel-bridge.js";
import { minePositiveSelections } from "./case-miner.js";

const TASK = "11111111-2222-3333-4444-555555555555";

function seedTelemetry(opts: {
  taskId?: string;
  message?: string;
  toolsCalled?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO scope_telemetry (task_id, message, tools_called)
       VALUES (?, ?, ?)`,
    )
    .run(
      opts.taskId ?? TASK,
      opts.message ?? "Busca el precio actual de NVDA por favor",
      opts.toolsCalled ?? JSON.stringify(["web_search"]),
    );
}

function getCase(caseId: string) {
  return getDatabase()
    .prepare("SELECT * FROM mined_test_cases WHERE case_id = ?")
    .get(caseId) as
    | {
        case_id: string;
        category: string;
        input: string;
        expected: string;
        weight: number;
        source: string;
        active: number;
        mined_from: string;
      }
    | undefined;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("bridgePraisedTaskToEvalCase", () => {
  it("pins a focused praised run as a weight-1.0 retention-exempt flywheel case", () => {
    seedTelemetry({});
    const result = bridgePraisedTaskToEvalCase(TASK);
    expect(result.created).toBe(true);
    expect(result.caseId).toBe(`flywheel-auto-${TASK}`);

    const row = getCase(result.caseId!);
    expect(row).toBeDefined();
    expect(row!.category).toBe("tool_selection");
    expect(row!.weight).toBe(1.0);
    expect(row!.source).toBe("flywheel");
    expect(row!.active).toBe(1);
    expect(row!.mined_from).toBe(`flywheel:excelente:${TASK}`);
    expect(JSON.parse(row!.input)).toEqual({
      message: "Busca el precio actual de NVDA por favor",
    });
    expect(JSON.parse(row!.expected)).toEqual({ tools: ["web_search"] });
  });

  it("double praise on the same task is a no-op (already_pinned)", () => {
    seedTelemetry({});
    expect(bridgePraisedTaskToEvalCase(TASK).created).toBe(true);
    const second = bridgePraisedTaskToEvalCase(TASK);
    expect(second.created).toBe(false);
    expect(second.reason).toBe("already_pinned");
  });

  it("dedupes repeated tool calls in the pinned expectation", () => {
    seedTelemetry({
      toolsCalled: JSON.stringify(["web_search", "web_search", "shell_exec"]),
    });
    const result = bridgePraisedTaskToEvalCase(TASK);
    expect(result.created).toBe(true);
    expect(JSON.parse(getCase(result.caseId!)!.expected)).toEqual({
      tools: ["web_search", "shell_exec"],
    });
  });

  it("uses the LATEST telemetry row for the task", () => {
    seedTelemetry({ toolsCalled: JSON.stringify(["shell_exec"]) });
    seedTelemetry({
      message: "Genera el reporte semanal de señales del radar",
      toolsCalled: JSON.stringify(["jarvis_read"]),
    });
    const result = bridgePraisedTaskToEvalCase(TASK);
    expect(JSON.parse(getCase(result.caseId!)!.expected)).toEqual({
      tools: ["jarvis_read"],
    });
  });

  it("skips: no telemetry / malformed tools / no tools / unfocused run / short message", () => {
    expect(bridgePraisedTaskToEvalCase("ghost").reason).toBe("no_telemetry");

    seedTelemetry({ taskId: "t-malformed", toolsCalled: "{not json" });
    expect(bridgePraisedTaskToEvalCase("t-malformed").reason).toBe(
      "malformed_tools",
    );

    seedTelemetry({ taskId: "t-empty", toolsCalled: "[]" });
    expect(bridgePraisedTaskToEvalCase("t-empty").reason).toBe("no_tools");

    seedTelemetry({
      taskId: "t-wide",
      toolsCalled: JSON.stringify(["a", "b", "c", "d"]),
    });
    expect(bridgePraisedTaskToEvalCase("t-wide").reason).toBe("unfocused_run");

    seedTelemetry({ taskId: "t-short", message: "dame el reporte" });
    expect(bridgePraisedTaskToEvalCase("t-short").reason).toBe(
      "message_too_short",
    );
  });

  it("auto-bridged cases consume POSITIVE_CASE_CEILING room in the miner", () => {
    // Ceiling is 140. Insert 140 active auto-bridged cases → miner has zero
    // room and returns [] even with fresh mineable telemetry present.
    seedTelemetry({}); // mineable row (1 tool, ≥5 words)
    const db = getDatabase();
    bridgePraisedTaskToEvalCase(TASK); // creates table + 1 auto case
    const insert = db.prepare(
      `INSERT INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from)
       VALUES (?, 'tool_selection', '{}', '{}', 1.0, 'flywheel', ?)`,
    );
    for (let i = 0; i < 139; i++)
      insert.run(`flywheel-auto-fill-${i}`, `flywheel:excelente:fill-${i}`);

    expect(minePositiveSelections()).toEqual([]);
  });

  it("bridge refuses past the ceiling (R1 W1: retention-exempt growth must be bounded)", () => {
    const db = getDatabase();
    seedTelemetry({});
    bridgePraisedTaskToEvalCase(TASK); // ensures table, 1 case
    const insert = db.prepare(
      `INSERT INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from)
       VALUES (?, 'tool_selection', '{}', '{}', 1.0, 'flywheel', ?)`,
    );
    for (let i = 0; i < 139; i++)
      insert.run(`flywheel-auto-fill-${i}`, `flywheel:excelente:fill-${i}`);

    seedTelemetry({ taskId: "t-over" });
    const result = bridgePraisedTaskToEvalCase("t-over");
    expect(result.created).toBe(false);
    expect(result.reason).toBe("ceiling_reached");
  });

  it("manual CLI pins do NOT consume miner room or the bridge ceiling (R1 W2)", () => {
    seedTelemetry({});
    const db = getDatabase();
    bridgePraisedTaskToEvalCase(TASK);
    db.prepare("DELETE FROM mined_test_cases").run();
    // 140 manual pins — including one squatting the flywheel-auto-* case_id
    // shape (`--id auto-nvda`). Only the mined_from marker counts.
    const insert = db.prepare(
      `INSERT INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from)
       VALUES (?, 'tool_selection', '{}', '{}', 1.0, 'flywheel', 'flywheel:manual')`,
    );
    insert.run("flywheel-auto-nvda");
    for (let i = 0; i < 139; i++) insert.run(`flywheel-manual-${i}`);

    expect(minePositiveSelections().length).toBeGreaterThan(0);
    seedTelemetry({ taskId: "t-room" });
    expect(bridgePraisedTaskToEvalCase("t-room").created).toBe(true);
  });
});
