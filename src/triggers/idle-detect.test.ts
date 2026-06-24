/**
 * Idle-detect trigger tests (V8.1 Phase 7). `runReflection` and
 * `detectStalledProjects` are mocked — the `tasks` / `trigger_runs` tables are a
 * real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

const runReflectionMock = vi.fn();
vi.mock("../reflection/runner.js", () => ({
  runReflection: (...a: unknown[]) => runReflectionMock(...a),
}));

const detectStalledMock = vi.fn();
vi.mock("../detection/index.js", () => ({
  detectStalledProjects: () => detectStalledMock(),
}));

import { runIdleDetectCheck } from "./idle-detect.js";

/** Insert a root task — `updated_at` defaults to now (recent ⇒ not idle). */
function insertRecentRootTask(taskId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, spawn_type, title, description, status)
       VALUES (?, 'root', 'T', 'D', 'running')`,
    )
    .run(taskId);
}

beforeEach(() => {
  initDatabase(":memory:");
  runReflectionMock.mockReset();
  runReflectionMock.mockResolvedValue({ ran: true, scope: {} });
  detectStalledMock.mockReset();
  detectStalledMock.mockReturnValue([{ kind: "stalled_project" }]);
});

afterEach(() => {
  closeDatabase();
});

describe("runIdleDetectCheck", () => {
  it("fires a reflection when idle (no recent root task) and a task is stalled", async () => {
    const result = await runIdleDetectCheck();
    expect(result).toMatchObject({ fired: true, reason: "fired" });
    expect(runReflectionMock).toHaveBeenCalledWith({
      cursorName: "pattern_detector",
      trigger: "idle-detect",
    });
  });

  it("does not fire when a root task was touched within the idle window", async () => {
    insertRecentRootTask("fresh");
    const result = await runIdleDetectCheck();
    expect(result.reason).toBe("not-idle");
    expect(runReflectionMock).not.toHaveBeenCalled();
  });

  it("does not fire when no task is stalled", async () => {
    detectStalledMock.mockReturnValue([]);
    const result = await runIdleDetectCheck();
    expect(result.reason).toBe("no-stalled-project");
    expect(runReflectionMock).not.toHaveBeenCalled();
  });

  it("is throttled when idle-detect already fired inside the 12h window", async () => {
    getDatabase()
      .prepare(
        `INSERT INTO trigger_runs (trigger_kind, outcome) VALUES ('idle_detect','fired')`,
      )
      .run();
    const result = await runIdleDetectCheck();
    expect(result.reason).toBe("throttled");
    expect(runReflectionMock).not.toHaveBeenCalled();
  });

  it("does not fire when the 24h reflection budget is exhausted", async () => {
    const db = getDatabase();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO trigger_runs (trigger_kind, outcome, fired_at)
         VALUES ('n_turn','fired', datetime('now','-30 minutes'))`,
      ).run();
    }
    const result = await runIdleDetectCheck();
    expect(result.reason).toBe("budget-exhausted");
    expect(runReflectionMock).not.toHaveBeenCalled();
    // No row written — the 12h throttle is not consumed by a budget skip.
    const idleRows = db
      .prepare(
        `SELECT COUNT(*) AS c FROM trigger_runs WHERE trigger_kind='idle_detect'`,
      )
      .get() as { c: number };
    expect(idleRows.c).toBe(0);
  });

  it("records a fired trigger_runs row on a real fire", async () => {
    await runIdleDetectCheck();
    const row = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS c FROM trigger_runs
          WHERE trigger_kind='idle_detect' AND outcome='fired'`,
      )
      .get() as { c: number };
    expect(row.c).toBe(1);
  });
});
