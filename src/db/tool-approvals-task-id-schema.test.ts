/**
 * Schema migration v11 — tool_approvals.task_id (S6 NEXT).
 *
 * The task that showed a confirmation card is stored on its approval rows so
 * a restart keeps it: the boot re-arm / DB fallback hand it back, the router
 * attributes the confirmed call to it, and a confirm closes its `blocked`
 * first leg. These tests run the REAL initDatabase on a fresh DB (the boot
 * CREATE carries the column) and on a v10 DB without it (the migration adds
 * it, rows survive, a re-run is a no-op). v11 also closes, once, the
 * `blocked` scope-request first legs older than 7 days.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  SCHEMA_V11_STALE_BLOCKED_SQL,
} from "./index.js";

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

const cols = (db: Database.Database): Array<{ name: string; type: string; notnull: number }> =>
  db.prepare("PRAGMA table_info(tool_approvals)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;

describe("migration v11 — tool_approvals.task_id", () => {
  it("fresh DB: head is v11 and tool_approvals has a nullable TEXT task_id", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    expect(cols(db).find((c) => c.name === "task_id")).toMatchObject({
      type: "TEXT",
      notnull: 0,
    });
  });

  it("existing v10 DB without the column: v11 adds it, old rows read NULL; a re-run pinned to 10 is a no-op", () => {
    tmpDbPath = join(tmpdir(), `mc-approvals-taskid-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`ALTER TABLE tool_approvals DROP COLUMN task_id; PRAGMA user_version = 10;`);
    raw
      .prepare(
        `INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json) VALUES ('t', 'gmail_send', 'h', '{}')`,
      )
      .run();
    expect(cols(raw).some((c) => c.name === "task_id")).toBe(false);
    raw.close();

    initDatabase(tmpDbPath);
    let db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    expect(cols(db).some((c) => c.name === "task_id")).toBe(true);
    expect(db.prepare("SELECT tool, task_id FROM tool_approvals").all()).toEqual([
      { tool: "gmail_send", task_id: null },
    ]);

    closeDatabase();
    const pin = new Database(tmpDbPath);
    pin.exec(`PRAGMA user_version = 10;`);
    pin.close();
    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    expect(cols(db).filter((c) => c.name === "task_id")).toHaveLength(1);
  });

  it("pins the v11 backfill statement: blocked only, untouched for more than 7 days", () => {
    expect(SCHEMA_V11_STALE_BLOCKED_SQL).toBe(
      "UPDATE tasks SET status = 'cancelled', error = 'stale blocked row, closed by schema v11', updated_at = datetime('now'), completed_at = datetime('now') WHERE status = 'blocked' AND (julianday('now') - julianday(updated_at)) > 7",
    );
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toContain("db.prepare(SCHEMA_V11_STALE_BLOCKED_SQL).run()");
  });

  it("fresh DB: the backfill runs clean on an empty tasks table", () => {
    expect(() => initDatabase(":memory:")).not.toThrow();
    const db = getDatabase();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  });

  it("v10 → v11 backfill: a blocked row 8 days old is cancelled with the v11 note; newer or non-blocked rows stay", () => {
    tmpDbPath = join(tmpdir(), `mc-approvals-backfill-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`PRAGMA user_version = 10;`);
    const ins = raw.prepare(
      `INSERT INTO tasks (task_id, title, description, status, updated_at) VALUES (?, 't', 'd', ?, datetime('now', ?))`,
    );
    ins.run("blocked-8d", "blocked", "-8 days");
    ins.run("blocked-1d", "blocked", "-1 days");
    ins.run("running-8d", "running", "-8 days");
    ins.run("needs-context-8d", "needs_context", "-8 days");
    ins.run("completed-8d", "completed", "-8 days");
    raw.close();

    initDatabase(tmpDbPath);
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    type Row = { task_id: string; status: string; error: string | null; completed_at: string | null };
    const rows = db
      .prepare("SELECT task_id, status, error, completed_at FROM tasks ORDER BY task_id")
      .all() as Row[];
    const by = Object.fromEntries(rows.map((r) => [r.task_id, r]));
    expect(by["blocked-8d"]).toMatchObject({
      status: "cancelled",
      error: "stale blocked row, closed by schema v11",
    });
    expect(by["blocked-8d"].completed_at).not.toBeNull();
    expect(by["blocked-1d"]).toEqual({ task_id: "blocked-1d", status: "blocked", error: null, completed_at: null });
    expect(by["running-8d"].status).toBe("running");
    expect(by["needs-context-8d"].status).toBe("needs_context");
    expect(by["completed-8d"]).toMatchObject({ status: "completed", error: null });
  });
});
