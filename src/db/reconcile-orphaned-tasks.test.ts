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
  // Minimal tasks table shape — only the columns the reconcile touches.
  db.exec(`
    CREATE TABLE tasks (
      task_id      TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      error        TEXT,
      completed_at TEXT,
      updated_at   TEXT
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
});
