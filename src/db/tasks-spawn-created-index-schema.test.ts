/**
 * Schema migration v19 — idx_tasks_spawn_created_cover (the precedents lookup).
 *
 * findPrecedents' candidate statement searched idx_tasks_spawn_updated on
 * spawn_type alone, read each root row's record for status and created_at,
 * and sorted the rows in a temp b-tree. These tests run the REAL
 * initDatabase (with the production index set from ensureReactionsTable) and
 * pin the query plan of the statement the lookup exports and runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { PRECEDENT_CANDIDATES_SQL } from "../memory/precedents.js";
import { IDLE_SQL } from "../triggers/idle-detect.js";
import { ensureReactionsTable } from "../reactions/store.js";

let tmpDbPath: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(tmpDbPath + suffix, { force: true });
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

const COVER_COLS = ["spawn_type", "created_at", "status", "title", "task_id"];
const SINCE = "2026-08-10 00:00:00";

describe("migration v19 — idx_tasks_spawn_created_cover (precedents lookup)", () => {
  it("fresh DB: head is v19 with the index on (spawn_type, created_at, status, title, task_id)", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(indexCols(db, "idx_tasks_spawn_created_cover")).toEqual(COVER_COLS);
  });

  it("precedents candidate SQL searches the covering index on (spawn_type, created_at) with no temp b-tree", () => {
    initDatabase(":memory:");
    ensureReactionsTable(getDatabase()); // production index set (idx_tasks_status_started)
    const p = plan(getDatabase(), PRECEDENT_CANDIDATES_SQL, SINCE, "", 4000);
    expect(p).toMatch(
      /^SEARCH tasks USING COVERING INDEX idx_tasks_spawn_created_cover \(spawn_type=\? AND created_at>\?\)$/,
    );
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).not.toContain("idx_tasks_spawn_updated");
  });

  it("precedents candidate SQL returns the window's terminal root Chat rows newest first", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    const ins = db.prepare(
      `INSERT INTO tasks (task_id, spawn_type, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, 'd', ?, ?, ?)`,
    );
    // Inserted out of date order, updated_at running against created_at.
    ins.run("mid", "root", "Chat: b", "failed", "2026-09-02 00:00:00", "2026-09-20 00:00:00");
    ins.run("newest", "root", "Chat: a", "completed", "2026-09-03 00:00:00", "2026-09-10 00:00:00");
    ins.run("oldest", "root", "Chat: c", "cancelled", "2026-09-01 00:00:00", "2026-09-30 00:00:00");
    ins.run("self", "root", "Chat: d", "completed", "2026-09-04 00:00:00", "2026-09-04 00:00:00");
    ins.run("sub", "subtask", "Chat: e", "completed", "2026-09-05 00:00:00", "2026-09-05 00:00:00");
    ins.run("ritual", "root", "Ritual: f", "completed", "2026-09-06 00:00:00", "2026-09-06 00:00:00");
    ins.run("running", "root", "Chat: g", "running", "2026-09-07 00:00:00", "2026-09-07 00:00:00");
    ins.run("old", "root", "Chat: h", "completed", "2026-08-01 00:00:00", "2026-08-01 00:00:00");
    const ids = (
      db.prepare(PRECEDENT_CANDIDATES_SQL).all(SINCE, "self", 4000) as Array<{ task_id: string }>
    ).map((r) => r.task_id);
    expect(ids).toEqual(["newest", "mid", "oldest"]);
  });

  it("idle-detect isIdle() SQL keeps its covering range on idx_tasks_spawn_updated", () => {
    initDatabase(":memory:");
    ensureReactionsTable(getDatabase()); // production index set (idx_tasks_status_started)
    const p = plan(getDatabase(), IDLE_SQL, "-4 hours");
    expect(p).toMatch(
      /^SEARCH tasks USING COVERING INDEX idx_tasks_spawn_updated \(spawn_type=\? AND updated_at>\?\)$/,
    );
  });

  it("existing v18 DB without the index: v19 builds it; a re-run pinned to 18 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-tasks-spawn-cover-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP INDEX idx_tasks_spawn_created_cover;
      PRAGMA user_version = 18;
    `);
    ensureReactionsTable(raw);
    // The pre-v19 shape this migration fixes: spawn_type-only search + temp b-tree sort.
    expect(plan(raw, PRECEDENT_CANDIDATES_SQL, SINCE, "", 4000)).toBe(
      "SEARCH tasks USING INDEX idx_tasks_spawn_updated (spawn_type=?)\nUSE TEMP B-TREE FOR ORDER BY",
    );
    raw.close();

    initDatabase(tmpDbPath);
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(19);
    expect(indexCols(getDatabase(), "idx_tasks_spawn_created_cover")).toEqual(COVER_COLS);
    closeDatabase();

    const pin = new Database(tmpDbPath);
    pin.exec("PRAGMA user_version = 18;");
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(19);
    expect(indexCols(getDatabase(), "idx_tasks_spawn_created_cover")).toEqual(COVER_COLS);
  });
});
