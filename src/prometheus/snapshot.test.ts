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
  pruneExpiredSnapshots,
  type PrometheusSnapshot,
} from "./snapshot.js";
import {
  PASSWORD_WITHHELD_PLACEHOLDER,
  passwordFingerprint,
} from "../lib/v8-4/password-gate.js";
import {
  _resetStoreWithhold,
  setStoreSeenCheck,
} from "../lib/v8-4/store-withhold.js";

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

describe("pruneExpiredSnapshots", () => {
  beforeEach(() => {
    // Each test starts from a clean table
    mockDb.exec("DELETE FROM prometheus_snapshots");
  });

  it("returns 0 when the table is empty", () => {
    expect(pruneExpiredSnapshots()).toBe(0);
  });

  it("deletes rows older than the TTL and leaves fresh rows alone", () => {
    saveSnapshot(makeSnapshot({ taskId: "fresh-task" }));
    saveSnapshot(makeSnapshot({ taskId: "stale-task" }));
    // Backdate the stale row to 2 hours ago (older than 1h TTL)
    mockDb
      .prepare(
        "UPDATE prometheus_snapshots SET created_at = datetime('now', '-2 hours') WHERE task_id = 'stale-task'",
      )
      .run();

    const deleted = pruneExpiredSnapshots();
    expect(deleted).toBe(1);

    const remaining = mockDb
      .prepare("SELECT task_id FROM prometheus_snapshots")
      .all() as Array<{ task_id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].task_id).toBe("fresh-task");
  });

  it("honours a custom TTL override (sub-second TTL deletes everything)", () => {
    saveSnapshot(makeSnapshot({ taskId: "task-a" }));
    saveSnapshot(makeSnapshot({ taskId: "task-b" }));
    // Backdate both 2 seconds so a 1-second-TTL sweep catches them
    mockDb
      .prepare(
        "UPDATE prometheus_snapshots SET created_at = datetime('now', '-2 seconds')",
      )
      .run();

    const deleted = pruneExpiredSnapshots(1000);
    expect(deleted).toBe(2);

    const remaining = mockDb
      .prepare("SELECT COUNT(*) as n FROM prometheus_snapshots")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("pins strict-< boundary: row 1 second under the TTL survives", () => {
    // Audit W4: the previous version of this test asserted
    // `deleted + remaining === 1`, which is a tautology (the row either
    // got deleted or it didn't, no third outcome). Real assertion: a row
    // backdated by `(TTL - 1s)` must NEVER be deleted by a default-TTL
    // prune. Otherwise a sweep that fires near the TTL boundary could
    // delete a snapshot a resume call is about to load.
    saveSnapshot(makeSnapshot({ taskId: "edge-task" }));
    // 1 hour TTL minus 1 second → 59:59 old → must survive
    mockDb
      .prepare(
        "UPDATE prometheus_snapshots SET created_at = datetime('now', '-59 minutes', '-59 seconds')",
      )
      .run();

    expect(pruneExpiredSnapshots()).toBe(0);
    const remaining = mockDb
      .prepare("SELECT COUNT(*) as n FROM prometheus_snapshots")
      .get() as { n: number };
    expect(remaining.n).toBe(1);
  });
});

describe("mailbox-password store rule on snapshots", () => {
  it("goal results and the description hold the placeholder; keys and numbers do not change", () => {
    const pw = "FakeTestPassWordXYZ2345";
    const fp = passwordFingerprint(pw);
    setStoreSeenCheck({ size: () => 1, has: (f) => f === fp });
    const base = makeSnapshot();
    try {
      saveSnapshot(
        makeSnapshot({
          taskDescription: `revisa ${pw}`,
          goalResults: {
            "g-1": { ...base.goalResults["g-1"]!, result: `contraseña ${pw}` },
          },
        }),
      );
    } finally {
      _resetStoreWithhold();
    }
    const raw = mockDb
      .prepare("SELECT * FROM prometheus_snapshots")
      .get() as Record<string, string>;
    expect(JSON.stringify(raw)).not.toContain(pw);
    const loaded = loadSnapshot("test-task-1")!;
    expect(loaded.taskDescription).toBe(`revisa ${PASSWORD_WITHHELD_PLACEHOLDER}`);
    expect(loaded.goalResults["g-1"]!.result).toBe(
      `contraseña ${PASSWORD_WITHHELD_PLACEHOLDER}`,
    );
    expect(loaded.goalResults["g-1"]!.durationMs).toBe(1000);
    expect(Object.keys(loaded.goalGraph.goals)).toEqual(["g-1", "g-2"]);
  });

  it("the goal graph holds the placeholder; its ids and links do not change", () => {
    const pw = "FakeTestPassWordXYZ2345";
    const fp = passwordFingerprint(pw);
    setStoreSeenCheck({ size: () => 1, has: (f) => f === fp });
    const base = makeSnapshot();
    try {
      saveSnapshot(
        makeSnapshot({
          goalGraph: {
            ...base.goalGraph,
            goals: {
              ...base.goalGraph.goals,
              "g-2": { ...base.goalGraph.goals["g-2"]!, description: `entra con ${pw}` },
            },
          },
        }),
      );
    } finally {
      _resetStoreWithhold();
    }
    const raw = mockDb
      .prepare("SELECT * FROM prometheus_snapshots")
      .get() as Record<string, string>;
    expect(JSON.stringify(raw)).not.toContain(pw);
    const loaded = loadSnapshot("test-task-1")!;
    expect(loaded.goalGraph.goals["g-2"]!.description).toBe(
      `entra con ${PASSWORD_WITHHELD_PLACEHOLDER}`,
    );
    expect(loaded.goalGraph.goals["g-2"]!.dependsOn).toEqual(["g-1"]);
  });
});
