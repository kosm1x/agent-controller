import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock getDatabase + writeWithRetry with in-memory SQLite
const mockDb = new Database(":memory:");
mockDb.exec(`CREATE TABLE prometheus_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,
  goal_graph       TEXT NOT NULL,
  goal_results     TEXT NOT NULL,
  execution_state  TEXT NOT NULL,
  task_description TEXT NOT NULL,
  tool_names       TEXT,
  config           TEXT,
  exit_reason      TEXT NOT NULL,
  created_at       TEXT DEFAULT (datetime('now'))
)`);
mockDb.exec(
  "CREATE INDEX IF NOT EXISTS idx_prom_snap_task ON prometheus_snapshots(task_id, created_at DESC)",
);

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import {
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  type PrometheusSnapshot,
} from "./snapshot.js";

function makeSnapshot(
  overrides: Partial<PrometheusSnapshot> = {},
): PrometheusSnapshot {
  return {
    taskId: "test-task-1",
    goalGraph: {
      goals: {
        "g-1": {
          id: "g-1",
          description: "Test goal",
          status: "completed",
          completionCriteria: ["done"],
          parentId: null,
          dependsOn: [],
          children: [],
          metadata: {},
          createdAt: "2026-04-11T00:00:00Z",
          updatedAt: "2026-04-11T00:01:00Z",
        },
        "g-2": {
          id: "g-2",
          description: "Pending goal",
          status: "pending",
          completionCriteria: ["do it"],
          parentId: null,
          dependsOn: ["g-1"],
          children: [],
          metadata: {},
          createdAt: "2026-04-11T00:00:00Z",
          updatedAt: "2026-04-11T00:00:00Z",
        },
      },
    },
    goalResults: {
      "g-1": {
        goalId: "g-1",
        ok: true,
        result: "Done",
        durationMs: 1000,
        toolCalls: 2,
        toolNames: ["shell", "file_read"],
        toolFailures: 0,
        tokenUsage: { promptTokens: 500, completionTokens: 200 },
      },
    },
    executionState: {
      budgetConsumed: 5,
      replanCount: 0,
      tokenUsage: { promptTokens: 1000, completionTokens: 400 },
      traceEvents: [{ type: "phase_start", timestamp: Date.now() }],
    },
    taskDescription: "Test task description",
    toolNames: ["shell", "file_read"],
    config: null,
    exitReason: "timeout",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockDb.exec("DELETE FROM prometheus_snapshots");
});

describe("PrometheusSnapshot", () => {
  it("round-trips save + load", () => {
    const snap = makeSnapshot();
    saveSnapshot(snap);

    const loaded = loadSnapshot("test-task-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("test-task-1");
    expect(loaded!.goalGraph.goals["g-1"].status).toBe("completed");
    expect(loaded!.goalGraph.goals["g-2"].status).toBe("pending");
    expect(loaded!.goalResults["g-1"].ok).toBe(true);
    expect(loaded!.executionState.budgetConsumed).toBe(5);
    expect(loaded!.toolNames).toEqual(["shell", "file_read"]);
    expect(loaded!.exitReason).toBe("timeout");
  });

  it("returns null when no snapshot exists", () => {
    expect(loadSnapshot("nonexistent")).toBeNull();
  });

  it("returns null for expired snapshots", () => {
    const snap = makeSnapshot();
    saveSnapshot(snap);

    // Manually backdate the created_at to 2 hours ago
    mockDb
      .prepare(
        "UPDATE prometheus_snapshots SET created_at = datetime('now', '-2 hours')",
      )
      .run();

    expect(loadSnapshot("test-task-1")).toBeNull();
  });

  it("clears snapshots", () => {
    saveSnapshot(makeSnapshot());
    expect(loadSnapshot("test-task-1")).not.toBeNull();

    clearSnapshot("test-task-1");
    expect(loadSnapshot("test-task-1")).toBeNull();
  });

  it("returns most recent snapshot when multiple exist", () => {
    saveSnapshot(makeSnapshot({ exitReason: "timeout" }));
    // Backdate the first one so the second is clearly newer
    mockDb
      .prepare(
        "UPDATE prometheus_snapshots SET created_at = datetime('now', '-1 hour') WHERE exit_reason = 'timeout'",
      )
      .run();
    saveSnapshot(makeSnapshot({ exitReason: "budget_exhausted" }));

    const loaded = loadSnapshot("test-task-1");
    expect(loaded!.exitReason).toBe("budget_exhausted");
  });

  it("preserves goal statuses through serialization", () => {
    const snap = makeSnapshot();
    snap.goalGraph.goals["g-1"].status = "completed";
    snap.goalGraph.goals["g-2"].status = "failed";
    saveSnapshot(snap);

    const loaded = loadSnapshot("test-task-1");
    expect(loaded!.goalGraph.goals["g-1"].status).toBe("completed");
    expect(loaded!.goalGraph.goals["g-2"].status).toBe("failed");
  });
});
