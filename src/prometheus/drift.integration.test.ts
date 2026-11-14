/**
 * Drift baselines on the real schema through initDatabase(":memory:"): the
 * rolling window and the prune both order `reflection_baselines` by
 * `created_at`, so every statement of the module runs against the real table
 * here. Seeded rows carry explicit, distinct timestamps (the column default
 * has one-second resolution, so default-stamped rows would tie).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "../db/index.js";
import { checkAndRecordDrift, pruneBaselines } from "./drift.js";

/** Distinct UTC text timestamps, one second apart, in the column's format. */
const ts = (i: number): string =>
  new Date(Date.UTC(2001, 0, 1, 0, 0, i))
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

let db: Database.Database;

function seed(taskType: string, score: number, createdAt: string): void {
  db.prepare(
    "INSERT INTO reflection_baselines (task_type, score, created_at) VALUES (?, ?, ?)",
  ).run(taskType, score, createdAt);
}

const scoresOf = (taskType: string): number[] =>
  (
    db
      .prepare(
        "SELECT score FROM reflection_baselines WHERE task_type = ? ORDER BY id",
      )
      .all(taskType) as Array<{ score: number }>
  ).map((r) => r.score);

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("checkAndRecordDrift", () => {
  it("compares against the 20 newest scores of its own type, then records the new score", () => {
    // Five old low scores fall outside the window of the 20 newest.
    for (let i = 0; i < 5; i++) seed("research", 0.1, ts(i));
    for (let i = 5; i < 25; i++) seed("research", 0.9, ts(i));
    // Another type's newer rows never enter this type's window.
    for (let i = 25; i < 30; i++) seed("coding", 0, ts(i));

    const result = checkAndRecordDrift("research", 0.5);

    expect(result.rollingAvg).toBeCloseTo(0.9);
    expect(result.stdDev).toBeCloseTo(0);
    expect(result.drifting).toBe(true);
    const research = scoresOf("research");
    expect(research).toHaveLength(26);
    expect(research[25]).toBe(0.5);
    expect(scoresOf("coding")).toHaveLength(5);
  });

  it("reads the window before inserting, so the new score never counts toward its own baseline", () => {
    // Four prior rows: below the 5-sample minimum only if the new row is excluded.
    for (let i = 0; i < 4; i++) seed("research", 0.9, ts(i));

    const result = checkAndRecordDrift("research", 0.1);

    expect(result).toEqual({
      taskType: "research",
      currentScore: 0.1,
      rollingAvg: 0.1,
      stdDev: 0,
      drifting: false,
    });
    expect(scoresOf("research")).toEqual([0.9, 0.9, 0.9, 0.9, 0.1]);
  });
});

describe("pruneBaselines", () => {
  it("keeps the 60 newest rows of the type by created_at and deletes the rest", () => {
    // Inserted newest first, so id order is the reverse of time order: the
    // prune must choose by created_at, not by insertion.
    for (let i = 62; i >= 0; i--) seed("research", i, ts(i));
    seed("coding", 1, ts(0));
    seed("coding", 2, ts(1));

    pruneBaselines("research");

    const kept = (
      db
        .prepare(
          "SELECT created_at FROM reflection_baselines WHERE task_type = 'research' ORDER BY created_at",
        )
        .all() as Array<{ created_at: string }>
    ).map((r) => r.created_at);
    expect(kept).toHaveLength(60);
    expect(kept[0]).toBe(ts(3));
    expect(kept[59]).toBe(ts(62));
    // Other types are pruned on their own call only.
    expect(scoresOf("coding")).toEqual([1, 2]);
  });

  it("deletes nothing while the type holds 60 rows or fewer", () => {
    for (let i = 0; i < 60; i++) seed("research", i, ts(i));

    pruneBaselines("research");

    expect(scoresOf("research")).toHaveLength(60);
  });
});
