/**
 * updateTaskStatus persistence tests — real in-memory SQLite.
 *
 * Motivating incident (task e6f3dfa0, 2026-07-27): the `failed` branch
 * dropped `output`, so a graded-down heavy task's full deliverable survived
 * only in the conversations table. Failed tasks must keep what the runner
 * produced for post-mortems.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Built at runtime — no key-shaped literal in the (public) repo.
const SECRET = "sk-" + "a".repeat(24);

describe("updateTaskStatus — tasks.error is credential-redacted at write", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("failed: error redacted; output kept verbatim (swarm parents deliver child tasks.output)", () => {
    insertTask("t-red-1");
    const output = { finalAnswer: `export GITHUB_TOKEN=${SECRET}` };
    updateTaskStatus("t-red-1", "failed", output, `tool echoed ${SECRET}`);

    const row = getTaskRow("t-red-1");
    expect(row.error).toBe("tool echoed [REDACTED_KEY]");
    expect(JSON.parse(row.output!)).toEqual(output);
  });

  it("blocked / needs_context: error redacted", () => {
    insertTask("t-red-2");
    updateTaskStatus(
      "t-red-2",
      "blocked",
      undefined,
      `auth failed for ${SECRET}`,
    );
    expect(getTaskRow("t-red-2").error).toBe("auth failed for [REDACTED_KEY]");
  });

  it("completed: output stays verbatim", () => {
    insertTask("t-red-3");
    updateTaskStatus("t-red-3", "completed", {
      finalAnswer: `here: ${SECRET}`,
    });
    expect(getTaskRow("t-red-3").output).toContain(SECRET);
  });

  it("realistic ids in an error pass through byte-identical", () => {
    insertTask("t-red-4");
    const err =
      "task 3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b at cd3c8204f1e2d3c4b5a69784f1e2d3c4b5a6978a doc 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms chat -1001234567890 https://example.com/?q=a&page=2";
    updateTaskStatus("t-red-4", "failed", undefined, err);
    expect(getTaskRow("t-red-4").error).toBe(err);
  });

  it("a throwing redactor still writes the raw error", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    insertTask("t-red-5");
    const err = `boom ${SECRET}`;
    vi.spyOn(String.prototype, "replace").mockImplementation(() => {
      throw new Error("redactor bug");
    });
    updateTaskStatus("t-red-5", "failed", undefined, err);
    vi.mocked(String.prototype.replace).mockRestore();
    const row = getTaskRow("t-red-5");
    expect(row.status).toBe("failed");
    expect(row.error).toBe(err);
  });
});
