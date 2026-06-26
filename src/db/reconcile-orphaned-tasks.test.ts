/**
 * Dim-4 R3 + round-2 C-RES-6 regression tests — startup reconcile of
 * orphaned tasks.
 *
 * Verifies reconcileOrphanedTasks() marks running/pending/queued rows as
 * failed with a forensic error string, leaves terminal statuses untouched,
 * and returns the list of reconciled task IDs so the caller can fire
 * task.failed events for the normal reaction + notification pipeline.
 */

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { reconcileOrphanedTasks } from "./index.js";

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  // Minimal tasks + runs table shapes — only the columns the reconcile touches.
  db.exec(`
    CREATE TABLE tasks (
      task_id      TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      error        TEXT,
      completed_at TEXT,
      updated_at   TEXT
    );
    CREATE TABLE runs (
      run_id       TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      completed_at TEXT
    );
  `);
  return db;
}

describe("reconcileOrphanedTasks (Dim-4 R3 fix + round-2 C-RES-6)", () => {
  it("marks running/pending/queued rows as failed and returns the IDs", () => {
    const db = makeDb();
    const insert = db.prepare(
      "INSERT INTO tasks (task_id, status) VALUES (?, ?)",
    );
    insert.run("r1", "running");
    insert.run("p1", "pending");
    insert.run("q1", "queued");
    insert.run("c1", "completed"); // must not be touched
    insert.run("f1", "failed"); // must not be touched
    insert.run("b1", "blocked"); // must not be touched (budget-gated)

    const reconciled = reconcileOrphanedTasks(db);
    // Round-2 C-RES-6: returns the IDs, not a count. Caller uses these
    // to fire task.failed events so reactions + user notifications run.
    expect([...reconciled].sort()).toEqual(["p1", "q1", "r1"]);

    const rows = db
      .prepare("SELECT task_id, status, error FROM tasks ORDER BY task_id")
      .all() as Array<{
      task_id: string;
      status: string;
      error: string | null;
    }>;

    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r]));

    expect(byId.r1.status).toBe("failed");
    expect(byId.r1.error).toContain("Orphaned across non-graceful restart");
    expect(byId.r1.error).toContain("running");

    expect(byId.p1.status).toBe("failed");
    expect(byId.p1.error).toContain("pending");

    expect(byId.q1.status).toBe("failed");
    expect(byId.q1.error).toContain("queued");

    expect(byId.c1.status).toBe("completed");
    expect(byId.c1.error).toBeNull();

    expect(byId.f1.status).toBe("failed");
    // Must not overwrite error on rows we didn't touch — pre-existing
    // failure stays readable.
    expect(byId.f1.error).toBeNull();

    expect(byId.b1.status).toBe("blocked");
  });

  it("is idempotent — second call on already-reconciled DB is a no-op", () => {
    const db = makeDb();
    db.prepare("INSERT INTO tasks (task_id, status) VALUES (?, ?)").run(
      "r1",
      "running",
    );

    expect(reconcileOrphanedTasks(db)).toEqual(["r1"]);
    expect(reconcileOrphanedTasks(db)).toEqual([]);
  });

  it("returns empty array when no orphans are present", () => {
    const db = makeDb();
    db.prepare("INSERT INTO tasks (task_id, status) VALUES (?, ?)").run(
      "c1",
      "completed",
    );
    expect(reconcileOrphanedTasks(db)).toEqual([]);
  });

  // Run-row cascade — the leak that accumulated ~66 zombie 'running' run rows
  // from 2026-03 through 2026-06. Every non-graceful death left the run row at
  // 'running' because no path swept runs; the boot task-sweep cleaned the task
  // but not its run.
  it("cascades orphaned run rows to failed, including runs whose parent task is ALREADY terminal", () => {
    const db = makeDb();
    const insTask = db.prepare(
      "INSERT INTO tasks (task_id, status) VALUES (?, ?)",
    );
    const insRun = db.prepare(
      "INSERT INTO runs (run_id, task_id, status, error) VALUES (?, ?, ?, ?)",
    );

    // A: task still 'running' at boot → task + its run both orphaned.
    insTask.run("tA", "running");
    insRun.run("runA", "tA", "running", null);
    // B: task ALREADY 'failed' (cleaned in a prior boot) but run left 'running'
    //    — the dominant row class. Drained only because the run sweep is
    //    unconditional (no orphaned task drives it).
    insTask.run("tB", "failed");
    insRun.run("runB", "tB", "running", null);
    // C: a completed run must not be touched.
    insTask.run("tC", "completed");
    insRun.run("runC", "tC", "completed", null);
    // D: a run that already failed with a real captured error — preserve it.
    insTask.run("tD", "failed");
    insRun.run("runD", "tD", "failed", "real OOM error");

    reconcileOrphanedTasks(db);

    const runs = Object.fromEntries(
      (
        db
          .prepare("SELECT run_id, status, error, completed_at FROM runs")
          .all() as Array<{
          run_id: string;
          status: string;
          error: string | null;
          completed_at: string | null;
        }>
      ).map((r) => [r.run_id, r]),
    );

    expect(runs.runA.status).toBe("failed");
    expect(runs.runA.completed_at).not.toBeNull();
    expect(runs.runA.error).toContain("Orphaned across non-graceful restart");

    expect(runs.runB.status).toBe("failed");
    expect(runs.runB.completed_at).not.toBeNull();

    expect(runs.runC.status).toBe("completed");

    expect(runs.runD.status).toBe("failed");
    expect(runs.runD.error).toBe("real OOM error"); // preserved, not overwritten
  });

  it("drains an orphaned run even when there are zero orphaned tasks (unconditional run sweep)", () => {
    const db = makeDb();
    db.prepare("INSERT INTO tasks (task_id, status) VALUES (?, ?)").run(
      "tB",
      "failed",
    );
    db.prepare(
      "INSERT INTO runs (run_id, task_id, status) VALUES (?, ?, ?)",
    ).run("runB", "tB", "running");

    // No running/pending/queued tasks → the returned task-id list is empty…
    expect(reconcileOrphanedTasks(db)).toEqual([]);
    // …but the orphaned run is still drained.
    const run = db
      .prepare("SELECT status FROM runs WHERE run_id='runB'")
      .get() as { status: string };
    expect(run.status).toBe("failed");
  });
});
