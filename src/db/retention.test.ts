/**
 * tasks/runs retention sweep — safety invariants (2026-07-05, Phase 4.4).
 * Real :memory: DB: the invariants live in SQL + the fixpoint exclusion,
 * which mocks can't exercise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: Database.Database;

vi.mock("./index.js", () => ({
  getDatabase: () => db,
  writeWithRetry: <T>(fn: () => T): T => fn(),
}));

import {
  runTasksRetention,
  pruneTelemetry,
  STALE_BLOCKED_CLOSE_SQL,
} from "./retention.js";

const NOW = new Date("2026-07-05T12:00:00Z");
const OLD = "2026-01-01 00:00:00"; // far past the 90d cutoff
const RECENT = "2026-07-01 00:00:00"; // inside the window

function insertTask(
  id: string,
  status: string,
  at: string,
  parent: string | null = null,
): void {
  db.prepare(
    `INSERT INTO tasks (task_id, parent_task_id, status, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, parent, status, at, at, at);
}

let dataDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  // Mirror the LIVE FK topology (R1 audit): tasks has a self-FK on
  // parent_task_id, runs + a2a_contexts reference tasks, and the real DB runs
  // with foreign_keys=ON — the batch-ordering invariant only exists under
  // these constraints, so the tests must carry them.
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL,
      parent_task_id TEXT REFERENCES tasks(task_id),
      status TEXT,
      title TEXT DEFAULT 't',
      error TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      output TEXT
    );
    CREATE TABLE a2a_contexts (
      context_id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(task_id),
      created_at TEXT
    );
    CREATE TABLE task_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL
    );
  `);
  dataDir = mkdtempSync(join(tmpdir(), "retention-test-"));
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.TASKS_RETENTION_DAYS;
});

describe("runTasksRetention", () => {
  it("archives then deletes old terminal tasks with their runs and outcomes", () => {
    insertTask("old-done", "completed", OLD);
    db.prepare("INSERT INTO runs (task_id, output) VALUES (?, ?)").run(
      "old-done",
      "big blob",
    );
    db.prepare("INSERT INTO task_outcomes (task_id) VALUES (?)").run(
      "old-done",
    );

    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(1);
    expect(r.runsDeleted).toBe(1);
    expect(r.outcomesDeleted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });

    // Archive exists and contains both rows
    expect(r.archivePath).not.toBeNull();
    expect(existsSync(r.archivePath!)).toBe(true);
    const lines = gunzipSync(readFileSync(r.archivePath!))
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => l.table === "tasks")).toBe(true);
    expect(lines.some((l) => l.table === "runs")).toBe(true);
  });

  it("NEVER touches in-flight tasks regardless of age", () => {
    for (const status of ["running", "pending", "queued", "needs_context"]) {
      insertTask(`old-${status}`, status, OLD);
    }
    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 4 });
    expect(r.archivePath).toBeNull(); // nothing to archive
  });

  it("keeps recent terminal tasks (inside the window)", () => {
    insertTask("recent-done", "completed", RECENT);
    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(0);
  });

  it("ages by the LATEST lifecycle timestamp — old created_at but recent completion survives", () => {
    db.prepare(
      `INSERT INTO tasks (task_id, status, created_at, updated_at, completed_at)
       VALUES ('long-runner', 'completed', ?, ?, ?)`,
    ).run(OLD, RECENT, RECENT);
    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(0);
  });

  it("skips a parent whose child survives (no orphaned children) — transitively", () => {
    insertTask("grandparent", "completed", OLD);
    insertTask("parent", "completed", OLD, "grandparent");
    insertTask("child-recent", "completed", RECENT, "parent");
    insertTask("unrelated-old", "failed", OLD);

    const r = runTasksRetention(dataDir, NOW);
    // parent kept (recent child), grandparent kept (surviving child = parent)
    expect(r.skippedParents).toBe(2);
    expect(r.tasksDeleted).toBe(1); // only unrelated-old
    const remaining = db
      .prepare("SELECT task_id FROM tasks ORDER BY task_id")
      .all()
      .map((x) => (x as { task_id: string }).task_id);
    expect(remaining).toEqual(["child-recent", "grandparent", "parent"]);
  });

  it("deletes a whole old subtree together", () => {
    insertTask("p", "completed", OLD);
    insertTask("c1", "failed", OLD, "p");
    insertTask("c2", "cancelled", OLD, "p");
    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(3);
    expect(r.skippedParents).toBe(0);
  });

  it("enforces the 14-day floor on TASKS_RETENTION_DAYS misconfig", () => {
    process.env.TASKS_RETENTION_DAYS = "0"; // typo'd config
    insertTask("done-30d-ago", "completed", "2026-06-05 00:00:00");
    const r = runTasksRetention(dataDir, NOW);
    // Floor kicks in → effective window stays 90d → 30d-old row survives
    expect(r.tasksDeleted).toBe(0);
  });

  it("returns a zero report on an empty database", () => {
    const r = runTasksRetention(dataDir, NOW);
    expect(r).toMatchObject({
      candidates: 0,
      tasksDeleted: 0,
      runsDeleted: 0,
      archivePath: null,
    });
  });

  it("deletes a >BATCH_SIZE subtree without tripping the self-FK across batches (R1 fix)", () => {
    // Parent + 600 children: with naive candidate ordering the parent can land
    // in an earlier delete batch than some children → FK error under
    // foreign_keys=ON. The leaf-first depth sort must make this pass.
    insertTask("mega-parent", "completed", OLD);
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, parent_task_id, status, created_at, updated_at, completed_at)
       VALUES (?, 'mega-parent', 'completed', ?, ?, ?)`,
    );
    for (let i = 0; i < 600; i++) insert.run(`child-${i}`, OLD, OLD, OLD);

    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(601);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
  });

  it("deletes a2a_contexts rows referencing deleted tasks (FK holder)", () => {
    insertTask("ctx-task", "completed", OLD);
    db.prepare(
      "INSERT INTO a2a_contexts (context_id, task_id, created_at) VALUES ('c1', 'ctx-task', ?)",
    ).run(OLD);
    const r = runTasksRetention(dataDir, NOW);
    expect(r.tasksDeleted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM a2a_contexts").get()).toEqual({
      n: 0,
    });
  });

  it("rotates archives older than a year", () => {
    // Seed a stale archive, then trigger a sweep that deletes something.
    const stale = join(dataDir, "archive");
    mkdirSync(stale, { recursive: true });
    const staleFile = join(
      stale,
      "tasks-retention-2024-01-01-00-00-00.jsonl.gz",
    );
    writeFileSync(staleFile, "old");
    const old = new Date("2024-01-01T00:00:00Z");
    utimesSync(staleFile, old, old);

    insertTask("old-done-2", "completed", OLD);
    runTasksRetention(dataDir, NOW);
    expect(existsSync(staleFile)).toBe(false);
  });
});

describe("stale blocked close (queue 4au)", () => {
  const D8 = "2026-06-27 12:00:00"; // 8 d before NOW
  const D6 = "2026-06-29 12:00:00"; // 6 d before NOW
  const NOW_SQL = "2026-07-05 12:00:00";
  const row = (id: string) =>
    db
      .prepare(
        "SELECT status, error, updated_at, completed_at FROM tasks WHERE task_id = ?",
      )
      .get(id) as {
      status: string;
      error: string | null;
      updated_at: string;
      completed_at: string | null;
    };

  it("closes a blocked row idle 8 d as cancelled with the note, completed_at set, never pruned in the same run", () => {
    db.prepare(
      "INSERT INTO tasks (task_id, status, created_at, updated_at) VALUES ('b8', 'blocked', ?, ?)",
    ).run(D8, D8);
    const r = runTasksRetention(dataDir, NOW);
    expect(r.staleBlockedClosed).toBe(1);
    expect(r.tasksDeleted).toBe(0);
    expect(row("b8")).toEqual({
      status: "cancelled",
      error: "stale blocked row, closed by retention",
      updated_at: NOW_SQL,
      completed_at: NOW_SQL,
    });
  });

  it("leaves a blocked row idle 6 d untouched", () => {
    insertTask("b6", "blocked", D6);
    const r = runTasksRetention(dataDir, NOW);
    expect(r.staleBlockedClosed).toBe(0);
    expect(row("b6")).toEqual({
      status: "blocked",
      error: null,
      updated_at: D6,
      completed_at: D6,
    });
  });

  it("never touches needs_context, running, queued, pending or a terminal row idle 8 d", () => {
    const statuses = [
      "needs_context",
      "running",
      "queued",
      "pending",
      "completed",
      "completed_with_concerns",
      "failed",
      "cancelled",
    ];
    for (const st of statuses) insertTask(`x-${st}`, st, D8);
    const r = runTasksRetention(dataDir, NOW);
    expect(r.staleBlockedClosed).toBe(0);
    for (const st of statuses) {
      expect(row(`x-${st}`)).toEqual({
        status: st,
        error: null,
        updated_at: D8,
        completed_at: D8,
      });
    }
  });

  it("boundary: updated_at exactly at the 7 d cutoff is untouched, one second older is closed", () => {
    insertTask("at-cutoff", "blocked", "2026-06-28 12:00:00"); // NOW - 7 d exactly
    insertTask("past-cutoff", "blocked", "2026-06-28 11:59:59"); // 1 s older
    const r = runTasksRetention(dataDir, NOW);
    expect(r.staleBlockedClosed).toBe(1);
    expect(row("at-cutoff").status).toBe("blocked");
    expect(row("past-cutoff").status).toBe("cancelled");
  });

  it("a failing close warns, reports 0 and still runs the prune pass", () => {
    insertTask("b8", "blocked", D8);
    insertTask("old-done", "completed", OLD);
    const realPrepare = db.prepare.bind(db);
    const prep = vi
      .spyOn(db, "prepare")
      .mockImplementation(((sql: string) => {
        if (sql === STALE_BLOCKED_CLOSE_SQL) throw new Error("SQLITE_BUSY: database is locked");
        return realPrepare(sql);
      }) as typeof db.prepare);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = runTasksRetention(dataDir, NOW);
      expect(r.staleBlockedClosed).toBe(0);
      expect(r.tasksDeleted).toBe(1);
      expect(row("b8").status).toBe("blocked");
      expect(warn).toHaveBeenCalledWith(
        "[retention] stale blocked close failed:",
        "SQLITE_BUSY: database is locked",
      );
    } finally {
      prep.mockRestore();
      warn.mockRestore();
    }
  });

  it("is idempotent: a second run closes 0", () => {
    insertTask("b8", "blocked", D8);
    expect(runTasksRetention(dataDir, NOW).staleBlockedClosed).toBe(1);
    expect(runTasksRetention(dataDir, NOW).staleBlockedClosed).toBe(0);
    expect(row("b8").status).toBe("cancelled");
  });

  it("a row closed by this rule is pruned by the terminal pass once past the 90 d window", () => {
    insertTask("b8", "blocked", D8);
    expect(runTasksRetention(dataDir, NOW).staleBlockedClosed).toBe(1);
    const at89 = new Date(NOW.getTime() + 89 * 86_400_000);
    expect(runTasksRetention(dataDir, at89).tasksDeleted).toBe(0);
    const at91 = new Date(NOW.getTime() + 91 * 86_400_000);
    const r = runTasksRetention(dataDir, at91);
    expect(r.staleBlockedClosed).toBe(0);
    expect(r.tasksDeleted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
  });

  it("pins the statement and its call site: prepared inside runTasksRetention, before the prune pass", () => {
    expect(STALE_BLOCKED_CLOSE_SQL).toBe(
      "UPDATE tasks SET status = 'cancelled', error = 'stale blocked row, closed by retention', updated_at = ?, completed_at = ? WHERE status = 'blocked' AND updated_at < ?",
    );
    const src = readFileSync(new URL("./retention.ts", import.meta.url), "utf8");
    const fn = src.indexOf("export function runTasksRetention(");
    const call = src.indexOf(".prepare(STALE_BLOCKED_CLOSE_SQL)");
    const prune = src.indexOf("SELECT task_id, parent_task_id FROM tasks");
    expect(fn).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(fn);
    expect(prune).toBeGreaterThan(call);
    expect(src).toContain("const STALE_BLOCKED_DAYS = 7;");
  });
});

describe("pruneTelemetry (design audit D5)", () => {
  it("drops scope_telemetry older than 90 d and recall_audit older than 180 d (all-time mc-ctl readers keep their baseline), nothing else", () => {
    db.exec(`
      CREATE TABLE scope_telemetry (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE recall_audit (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
    `);
    const D120 = "2026-03-07 00:00:00"; // 120 d before NOW: past 90, inside 180
    for (const t of [OLD, D120, RECENT]) {
      db.prepare("INSERT INTO scope_telemetry (created_at) VALUES (?)").run(t);
      db.prepare("INSERT INTO recall_audit (created_at) VALUES (?)").run(t);
    }
    const r = pruneTelemetry(NOW);
    expect(r).toEqual({ scopeTelemetry: 2, recallAudit: 1 });
    expect(db.prepare("SELECT created_at FROM scope_telemetry").all()).toEqual([{ created_at: RECENT }]);
    expect(db.prepare("SELECT created_at FROM recall_audit ORDER BY created_at").all()).toEqual([
      { created_at: D120 },
      { created_at: RECENT },
    ]);
  });
});
