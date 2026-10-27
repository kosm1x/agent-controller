/**
 * Schema migration v9 — S6 WS2 project attribution columns
 * (docs/planning/s6-project-contract-spec-2026-10-11.md §4).
 *
 * Runs the REAL initDatabase on a fresh DB and on a DB in the v8 shape (the
 * live state before deploy: no columns, no index, scheduled_tasks already
 * created by the dynamic scheduler), then re-boots it to prove the entry is
 * idempotent.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { ensureScheduledTasksTable } from "../rituals/dynamic.js";

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

const cols = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

const indexCols = (db: Database.Database, name: string): string[] =>
  (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe("migration v9 — tasks.project_slug/project_source + scheduled_tasks.project_slug", () => {
  it("fresh DB: head is v10 (v9 included) with both task columns, the index, and scheduled_tasks.project_slug", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    expect(cols(db, "tasks")).toEqual(
      expect.arrayContaining(["project_slug", "project_source"]),
    );
    expect(indexCols(db, "idx_tasks_project_slug_created")).toEqual([
      "project_slug",
      "created_at",
    ]);
    // Created lazily (outside the migration runner): its CREATE carries the column.
    ensureScheduledTasksTable();
    expect(cols(db, "scheduled_tasks")).toContain("project_slug");
  });

  it("existing v8 DB (no columns, no index, scheduled_tasks present): v9 adds them, old rows read NULL; a second boot is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-proj-attr-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    ensureScheduledTasksTable();
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP INDEX idx_tasks_project_slug_created;
      ALTER TABLE tasks DROP COLUMN project_slug;
      ALTER TABLE tasks DROP COLUMN project_source;
      ALTER TABLE scheduled_tasks DROP COLUMN project_slug;
      PRAGMA user_version = 8;
    `);
    raw
      .prepare(`INSERT INTO tasks (task_id, title, description) VALUES ('old', 't', 'd')`)
      .run();
    raw
      .prepare(
        `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr) VALUES ('s-old', 'n', 'd', '0 9 * * 1')`,
      )
      .run();
    expect(cols(raw, "tasks")).not.toContain("project_slug");
    expect(cols(raw, "scheduled_tasks")).not.toContain("project_slug");
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    expect(cols(db, "tasks")).toEqual(
      expect.arrayContaining(["project_slug", "project_source"]),
    );
    expect(cols(db, "scheduled_tasks")).toContain("project_slug");
    expect(indexCols(db, "idx_tasks_project_slug_created")).toEqual([
      "project_slug",
      "created_at",
    ]);
    expect(
      db.prepare(`SELECT project_slug, project_source FROM tasks WHERE task_id = 'old'`).get(),
    ).toEqual({ project_slug: null, project_source: null });
    expect(
      db.prepare(`SELECT project_slug FROM scheduled_tasks WHERE schedule_id = 's-old'`).get(),
    ).toEqual({ project_slug: null });

    // Idempotent: a second boot, and a re-run of v9 on a DB pinned back to 8
    // that already has everything, both boot cleanly.
    closeDatabase();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec(`PRAGMA user_version = 8;`);
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    expect(cols(db, "tasks").filter((c) => c === "project_slug")).toHaveLength(1);
  });

  it("v8 DB without scheduled_tasks yet: v9 still applies; the lazy CREATE then carries the column", () => {
    tmpDbPath = join(tmpdir(), `mc-proj-attr-nosched-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP INDEX idx_tasks_project_slug_created;
      ALTER TABLE tasks DROP COLUMN project_slug;
      ALTER TABLE tasks DROP COLUMN project_source;
      DROP TABLE IF EXISTS scheduled_tasks;
      PRAGMA user_version = 8;
    `);
    raw.close();

    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    ensureScheduledTasksTable();
    expect(cols(db, "scheduled_tasks")).toContain("project_slug");
  });
});
