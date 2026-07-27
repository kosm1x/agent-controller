/**
 * updateTaskStatus persistence tests — real in-memory SQLite.
 *
 * Motivating incident (task e6f3dfa0, 2026-07-27): the `failed` branch
 * dropped `output`, so a graded-down heavy task's full deliverable survived
 * only in the conversations table. Failed tasks must keep what the runner
 * produced for post-mortems.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { updateTaskStatus } from "./dispatcher.js";

function insertTask(taskId: string, status = "running"): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES (?, ?, '', ?, 'heavy')`,
    )
    .run(taskId, "Test task", status);
}

function getTaskRow(taskId: string): {
  status: string;
  output: string | null;
  error: string | null;
} {
  return getDatabase()
    .prepare("SELECT status, output, error FROM tasks WHERE task_id = ?")
    .get(taskId) as {
    status: string;
    output: string | null;
    error: string | null;
  };
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("updateTaskStatus — failed branch", () => {
  it("persists the runner output alongside the error", () => {
    insertTask("t-fail-1");
    updateTaskStatus(
      "t-fail-1",
      "failed",
      { finalAnswer: "the report", score: 0.63 },
      "reflection below gate",
    );

    const row = getTaskRow("t-fail-1");
    expect(row.status).toBe("failed");
    expect(row.error).toBe("reflection below gate");
    expect(JSON.parse(row.output!)).toEqual({
      finalAnswer: "the report",
      score: 0.63,
    });
  });

  it("stores null output when the runner produced nothing (crash path)", () => {
    insertTask("t-fail-2");
    updateTaskStatus("t-fail-2", "failed", undefined, "boom");

    const row = getTaskRow("t-fail-2");
    expect(row.status).toBe("failed");
    expect(row.output).toBeNull();
  });

  it("does not flip a terminal task (C2 idempotency guard intact)", () => {
    insertTask("t-done", "completed");
    updateTaskStatus("t-done", "failed", { finalAnswer: "late" }, "late fail");

    const row = getTaskRow("t-done");
    expect(row.status).toBe("completed");
    expect(row.output).toBeNull();
  });
});
