import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mineTrajectory,
  enumerateCandidates,
  getMinedCase,
} from "./trajectory-miner.js";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import {
  ensureTuningTables,
  insertTestCase,
  insertExperiment,
  insertEvalResult,
} from "./schema.js";
import type { TestCase } from "./types.js";

const RUN_ID = "test-run-traj";

function seedCase(caseId: string): TestCase {
  const tc: TestCase = {
    case_id: caseId,
    category: "scope_accuracy",
    input: { message: "test message" },
    expected: { scope_groups: ["coding"] },
    weight: 1.0,
    source: "manual",
    active: true,
  };
  insertTestCase(tc);
  return tc;
}

function seedExperiment(expId: string, status: "regressed" | "passed"): void {
  insertExperiment({
    experiment_id: expId,
    run_id: RUN_ID,
    surface: "tool_description",
    target: "web_search",
    mutation_type: "rewrite",
    original_value: "orig",
    mutated_value: "mut",
    hypothesis: "h",
    baseline_score: 50,
    mutated_score: 40,
    status,
  });
}

beforeEach(() => {
  initDatabase(":memory:");
  ensureTuningTables();
  delete process.env.TUNING_TRAJECTORY_MINE;
});

afterEach(() => {
  closeDatabase();
});

describe("mineTrajectory", () => {
  it("is a no-op when flag is off", () => {
    process.env.TUNING_TRAJECTORY_MINE = "false";
    seedCase("c1");
    seedExperiment("e1", "regressed");
    insertEvalResult("e1", "c1", 0.1, {}, 0);
    const r = mineTrajectory({ runId: RUN_ID });
    expect(r.candidateCount).toBe(0);
    expect(r.promotedCount).toBe(0);
  });

  it("does not promote cases that failed fewer than MIN_FAILING_EXPERIMENTS times", () => {
    process.env.TUNING_TRAJECTORY_MINE = "true";
    seedCase("c1");
    seedExperiment("e1", "regressed");
    seedExperiment("e2", "regressed");
    insertEvalResult("e1", "c1", 0.1, {}, 0);
    insertEvalResult("e2", "c1", 0.2, {}, 0);
    const r = mineTrajectory({ runId: RUN_ID });
    expect(r.candidateCount).toBe(0);
  });

  it("promotes a case that stably fails across 3+ experiments", () => {
    process.env.TUNING_TRAJECTORY_MINE = "true";
    seedCase("c1");
    for (let i = 0; i < 3; i++) {
      seedExperiment(`e${i}`, "regressed");
      insertEvalResult(`e${i}`, "c1", 0.1, {}, 0);
    }
    const r = mineTrajectory({ runId: RUN_ID });
    expect(r.candidateCount).toBe(1);
    expect(r.promotedCount).toBe(1);
    expect(getMinedCase("c1-traj")).not.toBeNull();
  });

  it("skips cases whose failing score is above the threshold", () => {
    process.env.TUNING_TRAJECTORY_MINE = "true";
    seedCase("c1");
    for (let i = 0; i < 3; i++) {
      seedExperiment(`e${i}`, "regressed");
      insertEvalResult(`e${i}`, "c1", 0.8, {}, 0); // still passing
    }
    const r = mineTrajectory({ runId: RUN_ID });
    expect(r.candidateCount).toBe(0);
  });

  it("dry-run counts candidates without inserting", () => {
    process.env.TUNING_TRAJECTORY_MINE = "true";
    seedCase("c1");
    for (let i = 0; i < 3; i++) {
      seedExperiment(`e${i}`, "regressed");
      insertEvalResult(`e${i}`, "c1", 0.1, {}, 0);
    }
    const r = mineTrajectory({ runId: RUN_ID, dryRun: true });
    expect(r.candidateCount).toBe(1);
    expect(r.promotedCount).toBe(0);
    expect(getMinedCase("c1-traj")).toBeNull();
  });

  // R1 M5: deactivated source cases must not be re-promoted
  it("skips cases deactivated in tune_test_cases", () => {
    process.env.TUNING_TRAJECTORY_MINE = "true";
    const tc = seedCase("c1");
    // Deactivate the source case
    const db = getDatabase();
    db.prepare(`UPDATE tune_test_cases SET active = 0 WHERE case_id = ?`).run(
      tc.case_id,
    );
    for (let i = 0; i < 3; i++) {
      seedExperiment(`e${i}`, "regressed");
      insertEvalResult(`e${i}`, "c1", 0.1, {}, 0);
    }
    const r = mineTrajectory({ runId: RUN_ID });
    expect(r.candidateCount).toBe(0);
  });

  it("enumerateCandidates lists failing cases without persisting", () => {
    process.env.TUNING_TRAJECTORY_MINE = "true";
    seedCase("c1");
    for (let i = 0; i < 3; i++) {
      seedExperiment(`e${i}`, "regressed");
      insertEvalResult(`e${i}`, "c1", 0.1, {}, 0);
    }
    const cands = enumerateCandidates(RUN_ID);
    expect(cands).toHaveLength(1);
    expect(cands[0].caseId).toBe("c1");
    expect(cands[0].failCount).toBeGreaterThanOrEqual(3);
    // Verify nothing was written
    const db = getDatabase();
    const cnt = db
      .prepare(`SELECT COUNT(*) AS n FROM mined_test_cases`)
      .get() as { n: number };
    expect(cnt.n).toBe(0);
  });
});
