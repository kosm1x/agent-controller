import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import {
  insertTestCase,
  getActiveTestCases,
  insertExperiment,
  updateExperimentFailureSource,
  getLastExperimentForTarget,
  updateExperimentResult,
  getRecentExperiments,
} from "./schema.js";
import type { Experiment, TestCase } from "./types.js";

/**
 * The tuning schema's case read and experiment statements on the real schema
 * (`initDatabase` creates the tuning tables and their added columns). Only
 * the SQL functions are imported, never a runner, so no model call is
 * reachable from this file.
 */

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

function seedCase(caseId: string, over: Partial<TestCase> = {}): void {
  insertTestCase({
    case_id: caseId,
    category: "classification",
    input: { message: `mensaje ${caseId}` },
    expected: { agent_type: "fast" },
    weight: 1,
    source: "manual",
    active: true,
    ...over,
  });
}

function seedMined(caseId: string, source: string, active: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO mined_test_cases (case_id, category, input, expected, source, active)
       VALUES (?, 'classification', ?, '{"agent_type":"heavy"}', ?, ?)`,
    )
    .run(caseId, JSON.stringify({ message: `minado ${caseId}` }), source, active);
}

function experiment(id: string, over: Partial<Experiment> = {}): Experiment {
  return {
    experiment_id: id,
    run_id: "run-1",
    surface: "scope_rule",
    target: "SCOPE_PATTERNS.coding",
    mutation_type: "rewrite",
    original_value: "original",
    mutated_value: "mutated",
    hypothesis: "a narrower pattern",
    baseline_score: 0.5,
    mutated_score: null,
    status: "pending",
    ...over,
  };
}

/** `created_at` defaults to the database clock at one-second resolution, so
 *  every ordering case stamps explicit, distinct UTC times. */
function stamp(id: string, at: string): void {
  getDatabase()
    .prepare("UPDATE tune_experiments SET created_at = ? WHERE experiment_id = ?")
    .run(at, id);
}

function row(id: string): Record<string, unknown> {
  return getDatabase()
    .prepare("SELECT * FROM tune_experiments WHERE experiment_id = ?")
    .get(id) as Record<string, unknown>;
}

describe("getActiveTestCases", () => {
  it("returns active seed cases then active mined cases, each ordered by case_id and tagged by population", () => {
    seedCase("seed-b");
    seedCase("seed-a");
    seedCase("seed-off", { active: false });
    seedMined("mined-1", "mined", 1);
    seedMined("flywheel-1", "flywheel", 1);
    seedMined("mined-off", "mined", 0);

    const cases = getActiveTestCases("classification");
    expect(cases.map((c) => [c.case_id, c.sourceGroup])).toEqual([
      ["seed-a", "seed"],
      ["seed-b", "seed"],
      ["flywheel-1", "flywheel"],
      ["mined-1", "mined"],
    ]);
    expect(cases[3].input).toEqual({ message: "minado mined-1" });
    expect(cases[3].expected).toEqual({ agent_type: "heavy" });
  });
});

describe("experiment rows", () => {
  it("insertExperiment writes every column to its own field", () => {
    insertExperiment(
      experiment("exp-1", {
        mutated_score: 0.4,
        status: "regressed",
        failure_source: "agent",
        confidence_avg: 0.7,
      }),
    );
    expect(row("exp-1")).toMatchObject({
      run_id: "run-1",
      surface: "scope_rule",
      target: "SCOPE_PATTERNS.coding",
      mutation_type: "rewrite",
      original_value: "original",
      mutated_value: "mutated",
      hypothesis: "a narrower pattern",
      baseline_score: 0.5,
      mutated_score: 0.4,
      status: "regressed",
      failure_source: "agent",
      confidence_avg: 0.7,
    });
  });

  it("updateExperimentFailureSource sets and clears the source of one experiment only", () => {
    insertExperiment(experiment("exp-1"));
    insertExperiment(experiment("exp-2"));

    updateExperimentFailureSource("exp-1", "env");
    expect(row("exp-1").failure_source).toBe("env");
    expect(row("exp-2").failure_source).toBeNull();

    updateExperimentFailureSource("exp-1", null);
    expect(row("exp-1").failure_source).toBeNull();
  });

  it("updateExperimentResult writes the score and status of one experiment only", () => {
    insertExperiment(experiment("exp-1"));
    insertExperiment(experiment("exp-2"));

    updateExperimentResult("exp-1", 0.9, "passed");
    expect(row("exp-1")).toMatchObject({ mutated_score: 0.9, status: "passed" });
    expect(row("exp-2")).toMatchObject({
      mutated_score: null,
      status: "pending",
    });
  });

  it("getLastExperimentForTarget returns the newest regressed or rejected experiment of that surface and target; errors and passes never count", () => {
    insertExperiment(experiment("old-regressed", { status: "regressed" }));
    insertExperiment(experiment("new-rejected", { status: "rejected" }));
    insertExperiment(experiment("newer-error", { status: "error" }));
    insertExperiment(experiment("newer-passed", { status: "passed" }));
    insertExperiment(
      experiment("other-target", {
        status: "regressed",
        target: "SCOPE_PATTERNS.google",
      }),
    );
    stamp("old-regressed", "2026-01-01 10:00:00");
    stamp("new-rejected", "2026-01-01 11:00:00");
    stamp("newer-error", "2026-01-01 12:00:00");
    stamp("newer-passed", "2026-01-01 13:00:00");
    stamp("other-target", "2026-01-01 14:00:00");

    expect(
      getLastExperimentForTarget("scope_rule", "SCOPE_PATTERNS.coding")
        ?.experiment_id,
    ).toBe("new-rejected");
    expect(
      getLastExperimentForTarget("classifier", "SCOPE_PATTERNS.coding"),
    ).toBeNull();
  });

  it("getRecentExperiments returns the newest experiments first, up to the limit", () => {
    insertExperiment(experiment("exp-a"));
    insertExperiment(experiment("exp-b"));
    insertExperiment(experiment("exp-c"));
    stamp("exp-a", "2026-01-01 10:00:00");
    stamp("exp-b", "2026-01-01 12:00:00");
    stamp("exp-c", "2026-01-01 11:00:00");

    expect(getRecentExperiments(2).map((e) => e.experiment_id)).toEqual([
      "exp-b",
      "exp-c",
    ]);
  });
});
