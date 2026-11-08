/**
 * Schema migration v16 — idx_tasks_status_updated_at, plus the retention
 * candidate narrowing (docs/planning/next-sessions-queue.md item 4br).
 *
 * detectRecurringBlockers walked every failed row through
 * idx_tasks_status_started and sorted them in a temp b-tree on each morning
 * briefing; the retention candidate query's only date predicate was an
 * unindexable COALESCE. These tests run the REAL initDatabase (with the
 * production index set from ensureReactionsTable) and pin the query plan of
 * the statement each call site exports and runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { RETENTION_CANDIDATES_SQL } from "./retention.js";
import { RECURRING_BLOCKERS_FAILED_SQL } from "../detection/recurring-blockers.js";
import { ensureReactionsTable } from "../reactions/store.js";

let tmpDbPath: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(tmpDbPath + suffix)) unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
    tmpDbPath = null;
  }
});

const indexCols = (db: Database.Database, name: string): string[] =>
  (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

const plan = (db: Database.Database, sql: string, ...params: unknown[]): string =>
  (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((r) => r.detail)
    .join("\n");

const TERMINAL = ["completed", "completed_with_concerns", "failed", "cancelled"];
const CUTOFF = "2026-08-10 00:00:00";

describe("migration v16 — idx_tasks_status_updated_at (recurring blockers)", () => {
  it("fresh DB: head is v16 with the index on (status, updated_at)", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    expect(indexCols(db, "idx_tasks_status_updated_at")).toEqual([
      "status",
      "updated_at",
    ]);
  });

  it("recurring-blockers failed-task SQL ranges idx_tasks_status_updated_at with no temp b-tree", () => {
    initDatabase(":memory:");
    ensureReactionsTable(getDatabase()); // production index set (idx_tasks_status_started)
    const p = plan(getDatabase(), RECURRING_BLOCKERS_FAILED_SQL, "-14 days", 2000);
    expect(p).toContain("idx_tasks_status_updated_at");
    expect(p).toMatch(/^SEARCH tasks USING INDEX idx_tasks_status_updated_at \(status=\? AND updated_at>\?\)/);
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).not.toContain("idx_tasks_status_started");
  });

  it("retention candidate SQL ranges idx_tasks_created_at, not SCAN tasks or the status index", () => {
    initDatabase(":memory:");
    ensureReactionsTable(getDatabase()); // production index set (idx_tasks_status_started)
    const p = plan(getDatabase(), RETENTION_CANDIDATES_SQL, ...TERMINAL, CUTOFF, CUTOFF);
    expect(p).not.toMatch(/SCAN tasks(?! USING)/);
    expect(p).toMatch(/^SEARCH tasks USING INDEX idx_tasks_created_at \(created_at<\?\)/);
    expect(p).not.toContain("idx_tasks_status");
  });

  it("retention narrowing drops no candidate: created long ago, completed recently stays out; old rows stay in", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    const ins = db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, created_at, updated_at, completed_at)
       VALUES (?, 't', 'd', ?, ?, ?, ?)`,
    );
    ins.run("old-done", "completed", "2026-01-01 00:00:00", "2026-01-02 00:00:00", "2026-01-02 00:00:00");
    ins.run("old-made-new-done", "completed", "2026-01-01 00:00:00", "2026-11-01 00:00:00", "2026-11-01 00:00:00");
    ins.run("old-no-done", "failed", "2026-01-01 00:00:00", "2026-01-03 00:00:00", null);
    ins.run("new", "completed", "2026-11-01 00:00:00", "2026-11-01 00:00:00", "2026-11-01 00:00:00");
    ins.run("old-running", "running", "2026-01-01 00:00:00", "2026-01-01 00:00:00", null);
    const ids = (
      db.prepare(RETENTION_CANDIDATES_SQL).all(...TERMINAL, CUTOFF, CUTOFF) as Array<{
        task_id: string;
      }>
    )
      .map((r) => r.task_id)
      .sort();
    expect(ids).toEqual(["old-done", "old-no-done"]);
  });

  it("existing v15 DB without the index: v16 builds it; a re-run pinned to 15 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-tasks-su-idx-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP INDEX idx_tasks_status_updated_at;
      PRAGMA user_version = 15;
    `);
    ensureReactionsTable(raw);
    // The pre-v16 shape this migration fixes: status index + temp b-tree sort.
    expect(plan(raw, RECURRING_BLOCKERS_FAILED_SQL, "-14 days", 2000)).toContain(
      "USE TEMP B-TREE FOR ORDER BY",
    );
    raw.close();

    initDatabase(tmpDbPath);
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(16);
    expect(indexCols(getDatabase(), "idx_tasks_status_updated_at")).toEqual([
      "status",
      "updated_at",
    ]);
    closeDatabase();

    const pin = new Database(tmpDbPath);
    pin.exec("PRAGMA user_version = 15;");
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(16);
  });
});
