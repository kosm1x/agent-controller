/**
 * Schema migration v10 — idx_tasks_spawn_updated + idx_tasks_created_at
 * (docs/planning/next-sessions-queue.md item 4aq).
 *
 * idle-detect's isIdle() ran `SCAN tasks` on every *\/30 tick; cold after the
 * 04:00 UTC dump that blocked the event loop 8-12 s. The canary and the MCP
 * status tool's created_at predicates were the same SCAN. These tests run the
 * REAL initDatabase and pin the query plan of the statement each call site
 * exports and runs, so dropping an index or rewriting a predicate so it no
 * longer uses one goes RED.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { IDLE_SQL } from "../triggers/idle-detect.js";
import { CANARY_TASK_STATS_SQL } from "../rituals/canary.js";
import { LAST_24H_TASKS_SQL } from "../api/mcp-server/tools.js";

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

describe("migration v10 — tasks indexes for idle-detect / canary / MCP status", () => {
  it("fresh DB: head is v11 with both v10 indexes on the expected columns", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    expect(indexCols(db, "idx_tasks_spawn_updated")).toEqual([
      "spawn_type",
      "updated_at",
    ]);
    expect(indexCols(db, "idx_tasks_created_at")).toEqual(["created_at"]);
  });

  it("idle-detect isIdle() SQL is a covering index range, not SCAN tasks", () => {
    initDatabase(":memory:");
    const p = plan(getDatabase(), IDLE_SQL, "-4 hours");
    expect(p).toContain("idx_tasks_spawn_updated");
    expect(p).toContain("COVERING INDEX");
    expect(p).toMatch(/^SEARCH tasks USING /);
    expect(p).not.toContain("SCAN tasks");
  });

  it("canary task-stats SQL uses idx_tasks_created_at, not SCAN tasks", () => {
    initDatabase(":memory:");
    const p = plan(getDatabase(), CANARY_TASK_STATS_SQL, "2026-10-26 00:00:00");
    expect(p).toContain("idx_tasks_created_at");
    expect(p).toMatch(/^SEARCH tasks USING /);
    expect(p).not.toContain("SCAN tasks");
  });

  it("MCP status last-24h COUNT uses idx_tasks_created_at, not SCAN tasks", () => {
    initDatabase(":memory:");
    const p = plan(getDatabase(), LAST_24H_TASKS_SQL);
    expect(p).toContain("idx_tasks_created_at");
    expect(p).toMatch(/^SEARCH tasks USING /);
    expect(p).not.toContain("SCAN tasks");
  });

  it("existing v9 DB (no indexes, rows present): v10 builds them; a re-run pinned to 9 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-tasks-idx-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP INDEX idx_tasks_spawn_updated;
      DROP INDEX idx_tasks_created_at;
      PRAGMA user_version = 9;
    `);
    raw
      .prepare(`INSERT INTO tasks (task_id, title, description) VALUES ('old', 't', 'd')`)
      .run();
    expect(plan(raw, IDLE_SQL, "-4 hours")).toMatch(/SCAN tasks(?! USING)/);
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    expect(indexCols(db, "idx_tasks_spawn_updated")).toEqual([
      "spawn_type",
      "updated_at",
    ]);
    expect(indexCols(db, "idx_tasks_created_at")).toEqual(["created_at"]);
    expect(db.prepare(IDLE_SQL).get("-4 hours")).toEqual({ 1: 1 });

    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec(`PRAGMA user_version = 9;`);
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
  });
});
