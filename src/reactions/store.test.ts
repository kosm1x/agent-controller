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
  countReactionChainLength,
  countRecentClassificationFailures,
  updateReactionStatus,
  getLatestReaction,
} from "./store.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  // Create dependent tables BEFORE ensureReactionsTable (it adds indexes on these)
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      task_id TEXT UNIQUE,
      status TEXT DEFAULT 'queued',
      started_at TEXT
    )
  `);
  ensureReactionsTable(db);
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

  describe("countReactionChainLength", () => {
    it("returns 0 for a task with no retry history", () => {
      expect(countReactionChainLength(db, "fresh-task")).toBe(0);
    });

    it("counts a single retry chain step", () => {
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-A",
        spawnedTaskId: "task-B",
        action: "retry",
        attempt: 1,
      });
      // task-B was spawned from task-A → chain length from B is 1
      expect(countReactionChainLength(db, "task-B")).toBe(1);
      // task-A has no prior → chain length from A is 0
      expect(countReactionChainLength(db, "task-A")).toBe(0);
    });

    it("walks a multi-step retry chain backward", () => {
      // Chain: A -> B -> C -> D (3 retries, 4 tasks)
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-A",
        spawnedTaskId: "task-B",
        action: "retry",
        attempt: 1,
      });
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-B",
        spawnedTaskId: "task-C",
        action: "retry",
        attempt: 1,
      });
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-C",
        spawnedTaskId: "task-D",
        action: "retry",
        attempt: 1,
      });

      expect(countReactionChainLength(db, "task-D")).toBe(3);
      expect(countReactionChainLength(db, "task-C")).toBe(2);
      expect(countReactionChainLength(db, "task-B")).toBe(1);
      expect(countReactionChainLength(db, "task-A")).toBe(0);
    });

    it("is bounded against pathological cycles", () => {
      // Construct a self-loop: A spawned from A (should not happen in practice).
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "cycle-A",
        spawnedTaskId: "cycle-A",
        action: "retry",
        attempt: 1,
      });
      // Cycle guard should stop the walk without hanging or exceeding MAX_CHAIN_WALK.
      const len = countReactionChainLength(db, "cycle-A");
      expect(len).toBeLessThanOrEqual(20);
    });

    it("handles branching (picks the first parent found)", () => {
      // Two parents both spawning task-X — LIMIT 1 means we pick one and walk.
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-P1",
        spawnedTaskId: "task-X",
        action: "retry",
        attempt: 1,
      });
      recordReaction(db, {
        trigger: "task_failed",
        sourceTaskId: "task-P2",
        spawnedTaskId: "task-X",
        action: "retry",
        attempt: 1,
      });
      // Chain walks back from X to ONE of its parents (either P1 or P2)
      const len = countReactionChainLength(db, "task-X");
      expect(len).toBe(1);
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
