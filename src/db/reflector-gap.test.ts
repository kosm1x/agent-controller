/**
 * Reflector gap log on the real schema through initDatabase(":memory:").
 * Both statements swallow their errors (telemetry must never block a run,
 * and a failed read means "unknown"), so a wrong column would surface only
 * as a missing row or a null snapshot: the cases read the rows back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "./index.js";
import { logReflectorGap, getLatestGoalSnapshot } from "./reflector-gap.js";
import type { ReflectorGapRecord } from "./reflector-gap.js";

function record(over: Partial<ReflectorGapRecord> = {}): ReflectorGapRecord {
  return {
    taskId: "task-a",
    llmScore: 0.8,
    heuristicScore: 0.5,
    llmAvailable: true,
    goalsTotal: 4,
    goalsCompleted: 3,
    goalsFailed: 1,
    ...over,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("logReflectorGap", () => {
  it("writes one row with the absolute score gap and the availability flag as 0/1", () => {
    logReflectorGap(record());
    logReflectorGap(
      record({ taskId: "task-b", llmScore: 0.2, heuristicScore: 0.6, llmAvailable: false }),
    );

    const rows = db
      .prepare(
        `SELECT task_id, llm_score, heuristic_score, abs_diff, llm_available,
                goals_total, goals_completed, goals_failed, created_at
         FROM reflector_gap_log ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      task_id: "task-a",
      llm_score: 0.8,
      heuristic_score: 0.5,
      llm_available: 1,
      goals_total: 4,
      goals_completed: 3,
      goals_failed: 1,
    });
    expect(rows[0].abs_diff).toBeCloseTo(0.3);
    expect(rows[0].created_at).toEqual(expect.any(String));
    expect(rows[1]).toMatchObject({ task_id: "task-b", llm_available: 0 });
    expect(rows[1].abs_diff).toBeCloseTo(0.4);
  });
});

describe("getLatestGoalSnapshot", () => {
  it("returns the goal counts of the task's most recent row", () => {
    logReflectorGap(record({ goalsTotal: 4, goalsFailed: 2 }));
    logReflectorGap(record({ goalsTotal: 5, goalsFailed: 0 }));
    // A later row of another task never answers for this one.
    logReflectorGap(record({ taskId: "task-b", goalsTotal: 9, goalsFailed: 9 }));

    expect(getLatestGoalSnapshot("task-a")).toEqual({
      goalsTotal: 5,
      goalsFailed: 0,
    });
  });

  it("returns null when the task has no row (unknown, not zero failures)", () => {
    logReflectorGap(record({ taskId: "task-b" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getLatestGoalSnapshot("task-a")).toBeNull();
    // An absent row is the normal null, not the logged failure path.
    expect(warn).not.toHaveBeenCalled();
  });
});
