/**
 * Tests for reaction store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  ensureReactionsTable,
  recordReaction,
  getReactionsBySourceTask,
  countReactionsForTask,
  countRecentClassificationFailures,
  updateReactionStatus,
  getLatestReaction,
} from "./store.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  ensureReactionsTable(db);
  // Create task_outcomes table for countRecentClassificationFailures
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_outcomes (
      id INTEGER PRIMARY KEY,
      task_id TEXT,
      classified_as TEXT,
      ran_on TEXT,
      tools_used TEXT,
      duration_ms INTEGER,
      success INTEGER,
      feedback_signal TEXT DEFAULT 'neutral',
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

describe("reaction store", () => {
  describe("ensureReactionsTable", () => {
    it("creates the table idempotently", () => {
      // Second call should not throw
      ensureReactionsTable(db);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='reactions'",
        )
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  describe("recordReaction", () => {
    it("inserts a reaction and returns a UUID", () => {
      const id = recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-1",
        spawnedTaskId: "task-2",
        action: "retry",
        attempt: 1,
        metadata: { error: "timeout" },
      });

      expect(id).toBeTruthy();
      expect(id.length).toBe(36); // UUID format

      const rows = getReactionsBySourceTask(db, "task-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].trigger_type).toBe("task_failed");
      expect(rows[0].action).toBe("retry");
      expect(rows[0].spawned_task_id).toBe("task-2");
      expect(rows[0].status).toBe("executing");
    });
  });

  describe("countReactionsForTask", () => {
    it("counts reactions for a specific source task", () => {
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-1",
        action: "retry",
        attempt: 1,
      });
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-1",
        action: "retry_adjusted",
        attempt: 2,
      });
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-other",
        action: "retry",
        attempt: 1,
      });

      expect(countReactionsForTask(db, "task-1")).toBe(2);
      expect(countReactionsForTask(db, "task-other")).toBe(1);
      expect(countReactionsForTask(db, "task-none")).toBe(0);
    });
  });

  describe("countRecentClassificationFailures", () => {
    it("counts failures in the last 24h for a classification", () => {
      // Insert recent failures
      db.prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags)
         VALUES (?, ?, ?, '[]', 100, 0, '[]')`,
      ).run("t1", "fast", "fast");
      db.prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags)
         VALUES (?, ?, ?, '[]', 100, 0, '[]')`,
      ).run("t2", "fast", "fast");
      // Insert a success (should not count)
      db.prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags)
         VALUES (?, ?, ?, '[]', 100, 1, '[]')`,
      ).run("t3", "fast", "fast");

      expect(countRecentClassificationFailures(db, "fast")).toBe(2);
      expect(countRecentClassificationFailures(db, "heavy")).toBe(0);
    });
  });

  describe("updateReactionStatus", () => {
    it("updates status to completed with timestamp", () => {
      const id = recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-1",
        action: "retry",
        attempt: 1,
      });

      updateReactionStatus(db, id, "completed");

      const rows = getReactionsBySourceTask(db, "task-1");
      expect(rows[0].status).toBe("completed");
    });

    it("updates status to suppressed without timestamp", () => {
      const id = recordReaction(db, {
        trigger: "repeated_failure",
        sourceTaskId: "task-1",
        action: "suppress",
        attempt: 3,
      });

      updateReactionStatus(db, id, "suppressed");

      const rows = getReactionsBySourceTask(db, "task-1");
      expect(rows[0].status).toBe("suppressed");
    });
  });

  describe("getLatestReaction", () => {
    it("returns the most recent reaction for a task", () => {
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-1",
        action: "retry",
        attempt: 1,
      });
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-1",
        action: "retry_adjusted",
        attempt: 2,
      });

      const latest = getLatestReaction(db, "task-1");
      expect(latest).not.toBeNull();
      expect(latest!.action).toBe("retry_adjusted");
      expect(latest!.attempt).toBe(2);
    });

    it("returns null when no reactions exist", () => {
      expect(getLatestReaction(db, "task-none")).toBeNull();
    });
  });
});
