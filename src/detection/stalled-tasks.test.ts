/**
 * Stalled-task detector tests (V8.1 Phase 5 B1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectStalledTasks } from "./stalled-tasks.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Insert a task with an explicit activity age and status/priority. */
function insertTask(opts: {
  status?: string;
  priority?: string;
  ageDays?: number;
  title?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, priority, updated_at)
       VALUES (?, ?, 'desc', ?, ?, datetime('now', ?))`,
    )
    .run(
      `t-${crypto.randomUUID()}`,
      opts.title ?? "task",
      opts.status ?? "running",
      opts.priority ?? "medium",
      `-${opts.ageDays ?? 0} days`,
    );
}

describe("detectStalledTasks", () => {
  it("flags non-terminal tasks untouched > 7 days", () => {
    insertTask({ status: "running", ageDays: 10, title: "old-running" });
    insertTask({ status: "blocked", ageDays: 20, title: "old-blocked" });
    const signals = detectStalledTasks();
    expect(signals.map((s) => s.title).sort()).toEqual([
      "old-blocked",
      "old-running",
    ]);
    expect(signals.every((s) => s.kind === "stalled_task")).toBe(true);
    expect(signals.every((s) => s.severity === "at_risk")).toBe(true);
  });

  it("ignores tasks with recent activity", () => {
    insertTask({ status: "running", ageDays: 2 });
    expect(detectStalledTasks()).toEqual([]);
  });

  it("ignores terminal-status tasks however old", () => {
    insertTask({ status: "completed", ageDays: 90 });
    insertTask({ status: "failed", ageDays: 90 });
    insertTask({ status: "cancelled", ageDays: 90 });
    expect(detectStalledTasks()).toEqual([]);
  });

  it("reports daysSinceActivity and orders by priority then age", () => {
    insertTask({ status: "running", priority: "low", ageDays: 30 });
    insertTask({ status: "running", priority: "critical", ageDays: 9 });
    const signals = detectStalledTasks();
    // critical sorts before low despite being younger.
    expect(signals[0]!.priority).toBe("critical");
    expect(signals[1]!.priority).toBe("low");
    expect(signals[1]!.daysSinceActivity).toBe(30);
  });

  it("honours a custom threshold", () => {
    insertTask({ status: "running", ageDays: 5 });
    expect(detectStalledTasks(7)).toEqual([]);
    expect(detectStalledTasks(3)).toHaveLength(1);
  });
});
