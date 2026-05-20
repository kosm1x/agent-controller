/**
 * N-turn trigger tests (V8.1 Phase 7). `runReflection` is mocked — no real
 * inference; the `tasks` / `trigger_runs` tables are a real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

const runReflectionMock = vi.fn();
vi.mock("../reflection/runner.js", () => ({
  runReflection: (...a: unknown[]) => runReflectionMock(...a),
}));

import type { Event } from "../lib/events/types.js";
import {
  REFLECTION_FREQ,
  getNTurnCounter,
  handleTaskCompleted,
  resetNTurnCounter,
} from "./n-turn.js";

function insertTask(taskId: string, spawnType: "root" | "subtask"): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, spawn_type, title, description, status)
       VALUES (?, ?, 'T', 'D', 'completed')`,
    )
    .run(taskId, spawnType);
}

function completedEvent(taskId: string): Event<"task.completed"> {
  return {
    data: { task_id: taskId, agent_id: "fast", result: null, duration_ms: 1 },
  } as Event<"task.completed">;
}

/** Drive N foreground (root) completions through the handler. */
function completeRootTasks(n: number): void {
  for (let i = 1; i <= n; i++) {
    insertTask(`t-${i}`, "root");
    handleTaskCompleted(completedEvent(`t-${i}`));
  }
}

beforeEach(() => {
  initDatabase(":memory:");
  resetNTurnCounter();
  runReflectionMock.mockReset();
  runReflectionMock.mockResolvedValue({
    ran: true,
    scope: {},
    cursorAdvancedTo: 1,
  });
});

afterEach(() => {
  closeDatabase();
});

describe("handleTaskCompleted — N-turn counter", () => {
  it("fires runReflection on the Nth foreground completion and resets", () => {
    completeRootTasks(REFLECTION_FREQ);
    expect(getNTurnCounter()).toBe(0); // reset on fire
    expect(runReflectionMock).toHaveBeenCalledTimes(1);
    expect(runReflectionMock).toHaveBeenCalledWith({
      cursorName: "general_events_discovery",
      trigger: "n-turn",
    });
  });

  it("does not fire while the count is below the frequency", () => {
    completeRootTasks(REFLECTION_FREQ - 1);
    expect(getNTurnCounter()).toBe(REFLECTION_FREQ - 1);
    expect(runReflectionMock).not.toHaveBeenCalled();
  });

  it("does not count subtasks — foreground (root) only", () => {
    insertTask("sub-1", "subtask");
    handleTaskCompleted(completedEvent("sub-1"));
    expect(getNTurnCounter()).toBe(0);
  });

  it("ignores a completion for an unknown task id", () => {
    handleTaskCompleted(completedEvent("does-not-exist"));
    expect(getNTurnCounter()).toBe(0);
  });

  it("records a fired trigger_runs row when it fires", () => {
    completeRootTasks(REFLECTION_FREQ);
    const row = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS c FROM trigger_runs
          WHERE trigger_kind='n_turn' AND outcome='fired'`,
      )
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("skips the reflection (and records 'skipped') when the 24h budget is exhausted", () => {
    const db = getDatabase();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO trigger_runs (trigger_kind, outcome) VALUES ('n_turn','fired')`,
      ).run();
    }
    completeRootTasks(REFLECTION_FREQ);
    expect(runReflectionMock).not.toHaveBeenCalled();
    const skipped = db
      .prepare(`SELECT COUNT(*) AS c FROM trigger_runs WHERE outcome='skipped'`)
      .get() as { c: number };
    expect(skipped.c).toBe(1);
  });
});
