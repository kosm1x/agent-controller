/**
 * listTasks / getRunToolCalls on the real schema. dispatcher.test.ts stubs the
 * database, so a wrong column, filter or order in these two readers (the API
 * task list and the swarm retry taint check) passes there. Only the two
 * readers are called: nothing here submits, runs or cancels a task.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { getRunToolCalls, listTasks } from "./dispatcher.js";

function insertTask(
  taskId: string,
  createdAt: string,
  cols: { status?: string; agentType?: string; parent?: string } = {},
): void {
  // The payload columns are filled so the projection test can see they are left out.
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, parent_task_id, spawn_type, title, description, status, agent_type, input, output, metadata, created_at)
       VALUES (?, ?, ?, ?, 'payload', ?, ?, '{"in":1}', '"out"', '{"meta":1}', ?)`,
    )
    .run(
      taskId,
      cols.parent ?? null,
      cols.parent ? "subtask" : "root",
      `title ${taskId}`,
      cols.status ?? "pending",
      cols.agentType ?? null,
      createdAt,
    );
}

function insertRun(
  runId: string,
  taskId: string,
  createdAt: string,
  toolCalls: string | null,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, tool_calls, created_at)
       VALUES (?, ?, 'fast', '{}', ?, ?)`,
    )
    .run(runId, taskId, toolCalls, createdAt);
}

const ids = (rows: Array<{ task_id: string }>) => rows.map((r) => r.task_id);

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("listTasks on the real schema", () => {
  beforeEach(() => {
    insertTask("t-root", "2026-01-01 10:00:00", {
      status: "running",
      agentType: "swarm",
    });
    insertTask("t-child-1", "2026-01-01 10:01:00", {
      status: "completed",
      agentType: "fast",
      parent: "t-root",
    });
    insertTask("t-child-2", "2026-01-01 10:02:00", {
      status: "failed",
      agentType: "fast",
      parent: "t-root",
    });
    insertTask("t-other", "2026-01-01 10:03:00", {
      status: "completed",
      agentType: "heavy",
    });
  });

  it("lists newest first with the list columns only, never the payload columns", () => {
    const rows = listTasks({});
    expect(ids(rows)).toEqual(["t-other", "t-child-2", "t-child-1", "t-root"]);
    expect(rows[0]).toEqual({
      id: expect.any(Number),
      task_id: "t-other",
      parent_task_id: null,
      spawn_type: "root",
      title: "title t-other",
      priority: "medium",
      status: "completed",
      agent_type: "heavy",
      classification: null,
      assigned_to: null,
      error: null,
      progress: 0,
      created_at: "2026-01-01 10:03:00",
      updated_at: expect.any(String),
      started_at: null,
      completed_at: null,
      retry_count: 0,
    });
  });

  it("filters by status, agent type and parent, and combines filters with AND", () => {
    expect(ids(listTasks({ status: "completed" }))).toEqual([
      "t-other",
      "t-child-1",
    ]);
    expect(ids(listTasks({ agentType: "fast" }))).toEqual([
      "t-child-2",
      "t-child-1",
    ]);
    expect(ids(listTasks({ parentTaskId: "t-root" }))).toEqual([
      "t-child-2",
      "t-child-1",
    ]);
    expect(
      ids(listTasks({ parentTaskId: "t-root", status: "completed" })),
    ).toEqual(["t-child-1"]);
    expect(listTasks({ status: "cancelled" })).toEqual([]);
  });

  it("pages with limit and offset in the same newest-first order", () => {
    expect(ids(listTasks({ limit: 2 }))).toEqual(["t-other", "t-child-2"]);
    expect(ids(listTasks({ limit: 2, offset: 2 }))).toEqual([
      "t-child-1",
      "t-root",
    ]);
  });
});

describe("getRunToolCalls on the real schema", () => {
  it("reads the tool names of the task's most recent run only", () => {
    insertTask("t-1", "2026-01-01 10:00:00");
    insertTask("t-2", "2026-01-01 10:00:00");
    insertRun("r-old", "t-1", "2026-01-01 10:01:00", '["file_read"]');
    insertRun("r-new", "t-1", "2026-01-01 10:05:00", '["web_search","file_write"]');
    insertRun("r-other", "t-2", "2026-01-01 10:09:00", '["shell_exec"]');
    expect(getRunToolCalls("t-1")).toEqual(["web_search", "file_write"]);
    expect(getRunToolCalls("t-2")).toEqual(["shell_exec"]);
  });

  it("returns [] without a run, for a NULL column or a non-array value, and keeps only string names", () => {
    for (const id of ["t-none", "t-null", "t-obj", "t-bad", "t-mixed"]) {
      insertTask(id, "2026-01-01 10:00:00");
    }
    insertRun("r-null", "t-null", "2026-01-01 10:01:00", null);
    insertRun("r-obj", "t-obj", "2026-01-01 10:01:00", '{"tool":"x"}');
    insertRun("r-bad", "t-bad", "2026-01-01 10:01:00", "not json");
    insertRun("r-mixed", "t-mixed", "2026-01-01 10:01:00", '["a",2,null,"b"]');
    expect(getRunToolCalls("t-none")).toEqual([]);
    expect(getRunToolCalls("t-null")).toEqual([]);
    expect(getRunToolCalls("t-obj")).toEqual([]);
    expect(getRunToolCalls("t-bad")).toEqual([]);
    expect(getRunToolCalls("t-mixed")).toEqual(["a", "b"]);
  });
});
