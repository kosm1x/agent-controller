import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import {
  recordToolRepairs,
  linkFeedbackToScope,
  getRecentTelemetry,
  getTelemetryWithRepairs,
  getTelemetryWithNegativeFeedback,
} from "./scope-telemetry.js";

/**
 * Scope telemetry's repair and feedback writes and its three readers on the
 * real schema; the sibling unit test mocks the database module statically,
 * so it cannot host them. Rows are seeded by direct INSERT and none of these
 * functions runs the module's lazy table-ensure step, so its module-level
 * "ensured" flag plays no part across the fresh database of each case. Row
 * ages are offsets from the database's own clock, the clock the readers use.
 */

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

function seed(
  taskId: string,
  age: string,
  over: { repaired?: string; feedback?: string } = {},
): void {
  getDatabase()
    .prepare(
      `INSERT INTO scope_telemetry (task_id, message, tools_repaired, feedback_signal, created_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    )
    .run(
      taskId,
      `mensaje ${taskId}`,
      over.repaired ?? "[]",
      over.feedback ?? "none",
      age,
    );
}

function column(
  taskId: string,
  name: "tools_repaired" | "feedback_signal",
): unknown[] {
  return (
    getDatabase()
      .prepare(
        `SELECT ${name} AS v FROM scope_telemetry WHERE task_id = ? ORDER BY id`,
      )
      .all(taskId) as Array<{ v: unknown }>
  ).map((r) => r.v);
}

const REPAIRS = [{ original: "web_serch", repaired: "web_search" }];

describe("writers", () => {
  it("recordToolRepairs writes the repairs onto every row of that task only", () => {
    seed("task-a", "-1 minutes");
    seed("task-a", "-2 minutes");
    seed("task-b", "-3 minutes");

    recordToolRepairs("task-a", REPAIRS);
    expect(column("task-a", "tools_repaired")).toEqual([
      JSON.stringify(REPAIRS),
      JSON.stringify(REPAIRS),
    ]);
    expect(column("task-b", "tools_repaired")).toEqual(["[]"]);
  });

  it("linkFeedbackToScope sets the signal on that task's rows only", () => {
    seed("task-a", "-1 minutes");
    seed("task-b", "-2 minutes");

    linkFeedbackToScope("task-a", "negative");
    expect(column("task-a", "feedback_signal")).toEqual(["negative"]);
    expect(column("task-b", "feedback_signal")).toEqual(["none"]);
  });
});

describe("readers", () => {
  it("getRecentTelemetry returns the rows inside the window, newest first", () => {
    seed("t-old", "-30 hours");
    seed("t-mid", "-2 hours");
    seed("t-new", "-1 hours");

    expect(getRecentTelemetry(24).map((r) => r.task_id)).toEqual([
      "t-new",
      "t-mid",
    ]);
  });

  it("getTelemetryWithRepairs returns only rows with repairs inside the window, newest first", () => {
    const repaired = JSON.stringify(REPAIRS);
    seed("t-plain", "-1 hours");
    seed("t-rep-old", "-30 hours", { repaired });
    seed("t-rep-mid", "-3 hours", { repaired });
    seed("t-rep-new", "-2 hours", { repaired });

    const rows = getTelemetryWithRepairs(24);
    expect(rows.map((r) => r.task_id)).toEqual(["t-rep-new", "t-rep-mid"]);
    expect(rows.map((r) => r.tools_repaired)).toEqual([repaired, repaired]);
  });

  it("getTelemetryWithNegativeFeedback returns only negative rows inside the window, newest first", () => {
    seed("t-none", "-1 days");
    seed("t-pos", "-1 days", { feedback: "positive" });
    seed("t-neg-old", "-8 days", { feedback: "negative" });
    seed("t-neg-mid", "-3 days", { feedback: "negative" });
    seed("t-neg-new", "-2 days", { feedback: "negative" });

    const rows = getTelemetryWithNegativeFeedback(7);
    expect(rows.map((r) => r.task_id)).toEqual(["t-neg-new", "t-neg-mid"]);
    expect(rows.map((r) => r.feedback_signal)).toEqual([
      "negative",
      "negative",
    ]);
  });
});
