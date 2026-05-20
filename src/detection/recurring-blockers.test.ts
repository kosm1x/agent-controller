/**
 * Recurring-blocker detector tests (V8.1 Phase 5 B3).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectRecurringBlockers } from "./recurring-blockers.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Insert a task with an error, status, and activity age. */
function insertFailed(opts: {
  error: string;
  status?: string;
  ageDays?: number;
}): string {
  const id = `t-${crypto.randomUUID()}`;
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, error, updated_at)
       VALUES (?, 'task', 'desc', ?, ?, datetime('now', ?))`,
    )
    .run(id, opts.status ?? "failed", opts.error, `-${opts.ageDays ?? 0} days`);
  return id;
}

const rbCount = (): number =>
  (
    getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM recurring_blockers")
      .get() as { n: number }
  ).n;

describe("detectRecurringBlockers", () => {
  it("surfaces a blocker recurring across 3+ distinct tasks", () => {
    for (let i = 0; i < 3; i++) insertFailed({ error: "ECONNREFUSED 8888" });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("recurring_blocker");
    expect(signals[0]!.taskCount).toBe(3);
    expect(signals[0]!.taskIds).toHaveLength(3);
    expect(rbCount()).toBe(1);
  });

  it("does not surface a blocker seen on only 2 tasks", () => {
    insertFailed({ error: "rate limit" });
    insertFailed({ error: "rate limit" });
    expect(detectRecurringBlockers()).toEqual([]);
    expect(rbCount()).toBe(0);
  });

  it("clusters case- and whitespace-variant error text together", () => {
    insertFailed({ error: "ECONNREFUSED  8888" });
    insertFailed({ error: "econnrefused 8888" });
    insertFailed({ error: "ECONNREFUSED\n8888" });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.taskCount).toBe(3);
  });

  it("does not merge distinct errors", () => {
    insertFailed({ error: "error A" });
    insertFailed({ error: "error B" });
    insertFailed({ error: "error C" });
    expect(detectRecurringBlockers()).toEqual([]);
  });

  it("ignores failed tasks outside the 14-day window", () => {
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "old error", ageDays: 30 });
    expect(detectRecurringBlockers()).toEqual([]);
  });

  it("ignores non-failed tasks", () => {
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "x", status: "completed" });
    expect(detectRecurringBlockers()).toEqual([]);
  });

  it("upsert is idempotent — re-running keeps one row per signature", () => {
    for (let i = 0; i < 3; i++) insertFailed({ error: "flaky" });
    detectRecurringBlockers();
    detectRecurringBlockers();
    expect(rbCount()).toBe(1);
    expect(
      (
        getDatabase()
          .prepare("SELECT task_count FROM recurring_blockers")
          .get() as { task_count: number }
      ).task_count,
    ).toBe(3);
  });

  it("honours a custom minTasks threshold", () => {
    insertFailed({ error: "twice" });
    insertFailed({ error: "twice" });
    expect(detectRecurringBlockers({ minTasks: 2 })).toHaveLength(1);
  });
});
