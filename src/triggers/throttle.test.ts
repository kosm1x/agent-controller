/**
 * trigger throttle + cadence-state tests (V8.1 Phase 7).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  MAX_REFLECTION_RUNS_PER_DAY,
  isThrottled,
  recordTriggerRun,
  reflectionBudgetAvailable,
  reflectionRunsInLast24h,
} from "./throttle.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Insert a `trigger_runs` row with an explicit age (a SQLite modifier). */
function insertRun(kind: string, outcome: string, ageSql: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO trigger_runs (trigger_kind, outcome, fired_at)
       VALUES (?, ?, datetime('now', ?))`,
    )
    .run(kind, outcome, ageSql);
}

describe("reflectionRunsInLast24h", () => {
  it("counts only fired n_turn / idle_detect rows inside the 24h window", () => {
    recordTriggerRun("n_turn", "fired");
    recordTriggerRun("idle_detect", "fired");
    recordTriggerRun("n_turn", "skipped"); // not fired — excluded
    recordTriggerRun("cron_morning", "fired"); // excluded kind
    insertRun("n_turn", "fired", "-25 hours"); // outside the window
    expect(reflectionRunsInLast24h()).toBe(2);
  });

  it("includes a row just inside the window and excludes one just outside", () => {
    insertRun("n_turn", "fired", "-23 hours"); // inside
    insertRun("idle_detect", "fired", "-1441 minutes"); // 24h01m — outside
    expect(reflectionRunsInLast24h()).toBe(1);
  });
});

describe("reflectionBudgetAvailable", () => {
  it("is true below the §14-Q4 ceiling and false once it is reached", () => {
    for (let i = 0; i < MAX_REFLECTION_RUNS_PER_DAY - 1; i++) {
      recordTriggerRun("n_turn", "fired");
    }
    expect(reflectionBudgetAvailable()).toBe(true);
    recordTriggerRun("idle_detect", "fired");
    expect(reflectionBudgetAvailable()).toBe(false);
  });
});

describe("isThrottled", () => {
  it("is false when nothing has fired", () => {
    expect(isThrottled("idle_detect", "-12 hours")).toBe(false);
  });

  it("is true within the window", () => {
    insertRun("idle_detect", "fired", "-1 hours");
    expect(isThrottled("idle_detect", "-12 hours")).toBe(true);
  });

  it("is false once the prior fire ages out of the window", () => {
    insertRun("idle_detect", "fired", "-13 hours");
    expect(isThrottled("idle_detect", "-12 hours")).toBe(false);
  });

  it("ignores skipped rows — only a real fire consumes the throttle", () => {
    insertRun("idle_detect", "skipped", "-1 hours");
    expect(isThrottled("idle_detect", "-12 hours")).toBe(false);
  });

  it("treats a fire just inside the window as throttling, just outside as clear", () => {
    insertRun("idle_detect", "fired", "-719 minutes"); // 11h59m — inside
    expect(isThrottled("idle_detect", "-12 hours")).toBe(true);
    closeDatabase();
    initDatabase(":memory:");
    insertRun("idle_detect", "fired", "-721 minutes"); // 12h01m — outside
    expect(isThrottled("idle_detect", "-12 hours")).toBe(false);
  });
});
