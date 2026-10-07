/**
 * Schema migration v7 — `task_outcomes.concern_detail` (2026-10-04).
 *
 * Runs the REAL initDatabase on a fresh DB and on a DB pinned at v6 without
 * the column (the live state before deploy), then drives the real chain
 * noteConcernDetail → trackTaskOutcome → recordOutcome into a real row.
 * task-outcomes.test.ts mocks ./index.js, so it cannot see the column.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { noteConcernDetail } from "./task-outcomes.js";
import {
  clearAllFeedbackWindows,
  trackTaskOutcome,
} from "../intelligence/outcome-tracker.js";

// Fire-and-forget pattern scan: async DB reads after the test closes the DB.
vi.mock("../intelligence/skill-discovery.js", () => ({
  detectRecurringPatterns: vi.fn(),
}));

let tmpDbPath: string | null = null;

beforeEach(() => {
  tmpDbPath = null;
});
afterEach(() => {
  clearAllFeedbackWindows();
  closeDatabase();
  vi.restoreAllMocks();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(tmpDbPath + suffix)) unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
});

function outcomeCols(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info(task_outcomes)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

describe("migration v7 — task_outcomes.concern_detail", () => {
  it("fresh DB: head is v8 (v7 included) and the column sits next to concern_reason", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    const cols = outcomeCols(db);
    expect(cols).toContain("concern_reason");
    expect(cols).toContain("concern_detail");
  });

  it("existing v6 DB without the column: v7 adds it, old rows read NULL", () => {
    tmpDbPath = join(
      tmpdir(),
      `mc-concern-detail-${process.pid}-${Date.now()}.db`,
    );
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(
      `ALTER TABLE task_outcomes DROP COLUMN concern_detail; PRAGMA user_version = 6;`,
    );
    raw
      .prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on) VALUES ('old', 'fast', 'fast')`,
      )
      .run();
    expect(outcomeCols(raw)).not.toContain("concern_detail");
    raw.close();

    initDatabase(tmpDbPath);
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(outcomeCols(db)).toContain("concern_detail");
    const row = db
      .prepare(`SELECT concern_detail FROM task_outcomes WHERE task_id = 'old'`)
      .get() as { concern_detail: string | null };
    expect(row.concern_detail).toBeNull();
  });

  it("a DB pinned below v7 that already has the column re-boots cleanly", () => {
    tmpDbPath = join(
      tmpdir(),
      `mc-concern-detail-rerun-${process.pid}-${Date.now()}.db`,
    );
    initDatabase(tmpDbPath);
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`PRAGMA user_version = 6;`);
    raw.close();

    expect(() => initDatabase(tmpDbPath!)).not.toThrow();
    expect(getDatabase().pragma("user_version", { simple: true })).toBe(8);
  });
});

describe("concern_detail end to end (note → trackTaskOutcome → row)", () => {
  function insertTask(db: Database.Database, taskId: string, status: string) {
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type, classification)
       VALUES (?, 'Chat: t', 'd', ?, 'fast', ?)`,
    ).run(taskId, status, JSON.stringify({ agentType: "fast" }));
  }
  function detailOf(db: Database.Database, taskId: string) {
    return db
      .prepare(
        `SELECT concern_reason, concern_detail FROM task_outcomes WHERE task_id = ?`,
      )
      .get(taskId) as {
      concern_reason: string | null;
      concern_detail: string | null;
    };
  }

  it("DONE_WITH_CONCERNS: the noted explanation lands in the row (redacted)", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    insertTask(db, "t-dwc", "completed_with_concerns");
    // Built at runtime — no key-shaped literal in the (public) repo.
    const key = "AIza" + "b".repeat(35);
    noteConcernDetail("t-dwc", `no pude verificar el saldo; ${key}`);

    trackTaskOutcome("t-dwc", 1200, true, "telegram");

    const row = detailOf(db, "t-dwc");
    expect(row.concern_detail).toMatch(
      /^no pude verificar el saldo; \[REDACTED/,
    );
    expect(row.concern_detail).not.toContain(key);
  });

  it("clean DONE: concern_detail is NULL", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    insertTask(db, "t-done", "completed");
    noteConcernDetail("t-done", null);

    trackTaskOutcome("t-done", 800, true, "telegram");

    expect(detailOf(db, "t-done").concern_detail).toBeNull();
  });
});
