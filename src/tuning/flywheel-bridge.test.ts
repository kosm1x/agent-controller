/**
 * Excelente→flywheel auto-bridge tests — V8.5 Phase 4.7.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { bridgePraisedTaskToEvalCase } from "./flywheel-bridge.js";
import {
  countActivePositiveCases,
  ensureMinedTestCasesTable,
  minePositiveSelections,
  POSITIVE_CASE_CEILING,
} from "./case-miner.js";

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
    expect(JSON.parse(row!.expected)).toEqual({
      tools: ["web_search"],
      first_tools: ["web_search"],
    });
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
      first_tools: ["web_search"],
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
      first_tools: ["jarvis_read"],
    });
  });

  it("drops harness tools (ToolSearch, mcp__*) from the pinned expectation; harness-only = no_tools (2026-10-04)", () => {
    seedTelemetry({
      toolsCalled: JSON.stringify(["ToolSearch", "web_search"]),
    });
    const result = bridgePraisedTaskToEvalCase(TASK);
    expect(JSON.parse(getCase(result.caseId!)!.expected)).toEqual({
      tools: ["web_search"],
      first_tools: ["web_search"],
    });
    seedTelemetry({
      taskId: "t-harness-only",
      toolsCalled: JSON.stringify(["mcp__playwright__browser_navigate"]),
    });
    expect(bridgePraisedTaskToEvalCase("t-harness-only").reason).toBe(
      "no_tools",
    );
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

describe("bridgePraisedTaskToEvalCase — displacement at a full ceiling (2026-10-04)", () => {
  // Synthetic rows only: case_id, source, mined_from, active, created_at are
  // what the ceiling and displacement predicates read.
  function addRow(opts: {
    caseId: string;
    source: "mined" | "flywheel";
    minedFrom: string;
    createdAt: string;
    active?: number;
  }): void {
    getDatabase()
      .prepare(
        `INSERT INTO mined_test_cases
           (case_id, category, input, expected, weight, source, mined_from, active, created_at)
         VALUES (?, 'tool_selection', '{}', '{}', 0.6, ?, ?, ?, ?)`,
      )
      .run(
        opts.caseId,
        opts.source,
        opts.minedFrom,
        opts.active ?? 1,
        opts.createdAt,
      );
  }
  const minute = (m: number) =>
    `2026-01-01 ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  // n miner positives, inserted NEWEST first: the highest id is the oldest
  // row, so ordering by id instead of created_at picks the wrong victim.
  function addMinerPositives(n: number, firstMinute = 0): void {
    for (let i = 0; i < n; i++)
      addRow({
        caseId: `mined-positive-p${i}`,
        source: "mined",
        minedFrom: "positive_selection:web_search",
        createdAt: minute(firstMinute + n - i),
      });
  }
  function addExcelentePins(n: number): void {
    for (let i = 0; i < n; i++)
      addRow({
        caseId: `flywheel-auto-fill-${i}`,
        source: "flywheel",
        minedFrom: `flywheel:excelente:fill-${i}`,
        createdAt: minute(i),
      });
  }
  const retired = () =>
    getDatabase()
      .prepare("SELECT case_id FROM mined_test_cases WHERE active = 0")
      .all()
      .map((r) => (r as { case_id: string }).case_id);

  beforeEach(() => {
    ensureMinedTestCasesTable(getDatabase());
    seedTelemetry({ taskId: "t-new" });
  });

  it("at a full ceiling of miner positives: pins, retires exactly the OLDEST one, count stays at the ceiling", () => {
    addMinerPositives(POSITIVE_CASE_CEILING); // p139 is the oldest (minute 1)
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);

    const result = bridgePraisedTaskToEvalCase("t-new");
    expect(result).toEqual({
      created: true,
      caseId: "flywheel-auto-t-new",
      displaced: "mined-positive-p139",
    });
    expect(retired()).toEqual(["mined-positive-p139"]);
    expect(getCase("flywheel-auto-t-new")!.active).toBe(1);
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);
  });

  it("created_at ties break on the lower id", () => {
    addRow({
      caseId: "mined-positive-tie-a",
      source: "mined",
      minedFrom: "positive_selection:web_search",
      createdAt: minute(0),
    });
    addRow({
      caseId: "mined-positive-tie-b",
      source: "mined",
      minedFrom: "positive_selection:web_search",
      createdAt: minute(0),
    });
    addMinerPositives(POSITIVE_CASE_CEILING - 2, 10);

    expect(bridgePraisedTaskToEvalCase("t-new").displaced).toBe(
      "mined-positive-tie-a",
    );
    expect(retired()).toEqual(["mined-positive-tie-a"]);
  });

  it("re-praise of an already pinned task at a full ceiling: already_pinned, nothing retired", () => {
    addMinerPositives(POSITIVE_CASE_CEILING - 1);
    expect(bridgePraisedTaskToEvalCase("t-new")).toEqual({
      created: true,
      caseId: "flywheel-auto-t-new",
    });
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);

    expect(bridgePraisedTaskToEvalCase("t-new")).toEqual({
      created: false,
      caseId: "flywheel-auto-t-new",
      reason: "already_pinned",
    });
    expect(retired()).toEqual([]);
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);
  });

  it("ceiling full of excelente pins only: ceiling_reached, insert rolled back, nothing retired", () => {
    addExcelentePins(POSITIVE_CASE_CEILING);
    // An already-retired miner positive is not a displacement candidate.
    addRow({
      caseId: "mined-positive-old-off",
      source: "mined",
      minedFrom: "positive_selection:web_search",
      createdAt: minute(0),
      active: 0,
    });

    expect(bridgePraisedTaskToEvalCase("t-new")).toEqual({
      created: false,
      reason: "ceiling_reached",
    });
    expect(getCase("flywheel-auto-t-new")).toBeUndefined();
    expect(retired()).toEqual(["mined-positive-old-off"]);
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);
  });

  it("below the ceiling: pins without displacing anything", () => {
    addMinerPositives(10);
    expect(bridgePraisedTaskToEvalCase("t-new")).toEqual({
      created: true,
      caseId: "flywheel-auto-t-new",
    });
    expect(retired()).toEqual([]);
    expect(countActivePositiveCases(getDatabase())).toBe(11);
  });

  it("never retires a pin or an inactive row, whatever its case_id: only active source='mined' miner positives", () => {
    // Older than the one genuine candidate, each excluded by one clause.
    addRow({
      caseId: "mined-positive-inactive",
      source: "mined",
      minedFrom: "positive_selection:web_search",
      createdAt: minute(0),
      active: 0,
    });
    addRow({
      caseId: "mined-positive-marker",
      source: "mined",
      minedFrom: "flywheel:excelente:squat",
      createdAt: minute(1),
    });
    addRow({
      caseId: "mined-positive-manual",
      source: "flywheel",
      minedFrom: "flywheel:manual",
      createdAt: minute(2),
    });
    addRow({
      caseId: "mined-positive-genuine",
      source: "mined",
      minedFrom: "positive_selection:web_search",
      createdAt: minute(500),
    });
    addExcelentePins(POSITIVE_CASE_CEILING - 3);
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);

    expect(bridgePraisedTaskToEvalCase("t-new").displaced).toBe(
      "mined-positive-genuine",
    );
    expect(retired().sort()).toEqual([
      "mined-positive-genuine",
      "mined-positive-inactive",
    ]);
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);
  });

  it("the miner adds nothing after a displacement (ceiling still full)", () => {
    addMinerPositives(POSITIVE_CASE_CEILING);
    bridgePraisedTaskToEvalCase("t-new");
    // Fresh mineable telemetry: the ceiling is still full, so no room.
    seedTelemetry({
      taskId: "t-fresh",
      message: "Revisa el clima de mañana en Monterrey",
    });
    expect(minePositiveSelections()).toEqual([]);
  });

  it("never retires an older active miner row of another kind (mined-feedback-*, mined-tier-*)", () => {
    // Older than every miner positive, source='mined', active — excluded by
    // the case_id prefix alone (they do not count against the ceiling).
    for (const caseId of ["mined-feedback-x", "mined-tier-x"])
      addRow({
        caseId,
        source: "mined",
        minedFrom: "negative_feedback:t-old",
        createdAt: minute(0),
      });
    addMinerPositives(POSITIVE_CASE_CEILING, 10); // p139 earliest positive

    expect(bridgePraisedTaskToEvalCase("t-new").displaced).toBe(
      "mined-positive-p139",
    );
    expect(retired()).toEqual(["mined-positive-p139"]);
    expect(countActivePositiveCases(getDatabase())).toBe(POSITIVE_CASE_CEILING);
  });

  it("a non-sentinel DB error propagates (never reported as ceiling_reached) and rolls the pin back", () => {
    addMinerPositives(POSITIVE_CASE_CEILING);
    const db = getDatabase();
    // Synthetic failure at the insert step.
    db.exec(`CREATE TRIGGER fail_pin BEFORE INSERT ON mined_test_cases
             WHEN NEW.case_id = 'flywheel-auto-t-new'
             BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END`);
    expect(() => bridgePraisedTaskToEvalCase("t-new")).toThrow(
      /synthetic insert failure/,
    );
    expect(getCase("flywheel-auto-t-new")).toBeUndefined();
    expect(retired()).toEqual([]);

    // Synthetic failure at the retire step: the insert must roll back too.
    db.exec(`DROP TRIGGER fail_pin;
             CREATE TRIGGER fail_retire BEFORE UPDATE ON mined_test_cases
             BEGIN SELECT RAISE(ABORT, 'synthetic retire failure'); END`);
    expect(() => bridgePraisedTaskToEvalCase("t-new")).toThrow(
      /synthetic retire failure/,
    );
    expect(getCase("flywheel-auto-t-new")).toBeUndefined();
    expect(retired()).toEqual([]);
    expect(countActivePositiveCases(db)).toBe(POSITIVE_CASE_CEILING);
  });
});
