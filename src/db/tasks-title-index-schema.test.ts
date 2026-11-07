/**
 * Schema migration v12 — idx_tasks_title_status.
 *
 * The ritual scheduler's alreadyRanToday() (before every scheduled ritual) and
 * attemptsOn() (retry path) filter `title = ? AND status != 'cancelled'`; with
 * no index on title that was `SCAN tasks`, and cold at 05:00 UTC it blocked
 * the event loop 4.7-10.3 s. These tests run the REAL initDatabase and pin the
 * query plan of the statement each call site exports and runs, so dropping the
 * index or rewriting a predicate so it no longer uses it goes RED.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import {
  ALREADY_RAN_TODAY_SQL,
  ATTEMPTS_ON_SQL,
} from "../rituals/scheduler.js";

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

const TITLE = "Morning briefing — 2026-11-05";

describe("migration v12 — idx_tasks_title_status for the ritual scheduler", () => {
  it("fresh DB: head is v13 with the index on (title, status)", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(13);
    expect(indexCols(db, "idx_tasks_title_status")).toEqual(["title", "status"]);
  });

  it("alreadyRanToday() SQL is a covering index search on title, not SCAN tasks", () => {
    initDatabase(":memory:");
    const p = plan(getDatabase(), ALREADY_RAN_TODAY_SQL, TITLE);
    expect(p).toBe(
      "SEARCH tasks USING COVERING INDEX idx_tasks_title_status (title=?)",
    );
    expect(p).not.toContain("SCAN tasks");
  });

  it("attemptsOn() SQL searches idx_tasks_title_status on title, not SCAN tasks", () => {
    initDatabase(":memory:");
    const p = plan(getDatabase(), ATTEMPTS_ON_SQL, TITLE);
    expect(p).toBe("SEARCH tasks USING INDEX idx_tasks_title_status (title=?)");
    expect(p).not.toContain("SCAN tasks");
  });

  it("existing v11 DB (no index, rows present): v12 builds it; a re-run pinned to 11 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-tasks-title-idx-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP INDEX idx_tasks_title_status;
      PRAGMA user_version = 11;
    `);
    const ins = raw.prepare(
      `INSERT INTO tasks (task_id, title, description, status) VALUES (?, ?, 'd', ?)`,
    );
    ins.run("ran", TITLE, "completed");
    ins.run("cancelled", "Nightly close — 2026-11-05", "cancelled");
    expect(plan(raw, ALREADY_RAN_TODAY_SQL, TITLE)).toMatch(/SCAN tasks(?! USING)/);
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(13);
    expect(indexCols(db, "idx_tasks_title_status")).toEqual(["title", "status"]);
    expect(db.prepare(ALREADY_RAN_TODAY_SQL).get(TITLE)).toEqual({ 1: 1 });
    expect(
      db.prepare(ALREADY_RAN_TODAY_SQL).get("Nightly close — 2026-11-05"),
    ).toBeUndefined();
    expect(db.prepare(ATTEMPTS_ON_SQL).all(TITLE)).toEqual([
      { status: "completed", metadata: null },
    ]);

    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec(`PRAGMA user_version = 11;`);
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(13);
  });
});
