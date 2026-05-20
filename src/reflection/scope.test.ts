/**
 * Reflection scope tests (V8.1 Phase 4 B2) — the bounded diff.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { advanceCursor } from "./cursors.js";
import { buildReflectionScope } from "./scope.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Insert a task; returns its `id`. `updatedAt`/`status` overridable. */
function insertTask(opts: {
  status?: string;
  updatedAt?: string;
  title?: string;
}): number {
  const r = getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, updated_at)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(
      `t-${crypto.randomUUID()}`,
      opts.title ?? "task",
      "desc",
      opts.status ?? "completed",
      opts.updatedAt ?? null,
    );
  return r.lastInsertRowid as number;
}

describe("buildReflectionScope", () => {
  describe("n-turn", () => {
    it("returns the last 5 tasks after the cursor, ordered ascending", () => {
      const ids: number[] = [];
      for (let i = 0; i < 8; i++) ids.push(insertTask({}));
      const scope = buildReflectionScope("morning_brief", "n-turn");
      expect(scope.deltaEvents.map((e) => e.eventId)).toEqual(ids.slice(3));
      expect(scope.lastProcessedEventId).toBe(ids[7]);
      expect(scope.priorStateSnapshot.asOfEventId).toBe(0);
    });

    it("only includes tasks after the cursor floor", () => {
      const ids: number[] = [];
      for (let i = 0; i < 8; i++) ids.push(insertTask({}));
      advanceCursor("morning_brief", ids[5]!);
      const scope = buildReflectionScope("morning_brief", "n-turn");
      // floor = ids[5], so only ids[6], ids[7] qualify.
      expect(scope.deltaEvents.map((e) => e.eventId)).toEqual(ids.slice(6));
      expect(scope.priorStateSnapshot.asOfEventId).toBe(ids[5]);
    });
  });

  describe("cron-morning", () => {
    it("returns all tasks since the cursor when under the cap", () => {
      for (let i = 0; i < 10; i++) insertTask({});
      const scope = buildReflectionScope("morning_brief", "cron-morning");
      expect(scope.deltaEvents).toHaveLength(10);
      expect(scope.lastProcessedEventId).toBe(10);
    });

    it("caps the delta at 200 rows, keeping the most recent", () => {
      const db = getDatabase();
      const insertMany = db.transaction((n: number) => {
        for (let i = 0; i < n; i++) insertTask({});
      });
      insertMany(205);
      const scope = buildReflectionScope("morning_brief", "cron-morning");
      expect(scope.deltaEvents).toHaveLength(200);
      // Newest kept (id 205), oldest dropped (id 5 → first 5 fall off).
      expect(scope.deltaEvents.at(-1)!.eventId).toBe(205);
      expect(scope.deltaEvents[0]!.eventId).toBe(6);
      expect(scope.lastProcessedEventId).toBe(205);
    });
  });

  describe("idle-detect", () => {
    it("returns only stalled tasks (running + untouched > 7d)", () => {
      const stale1 = insertTask({
        status: "running",
        updatedAt: "2020-01-01 00:00:00",
      });
      const stale2 = insertTask({
        status: "running",
        updatedAt: "2020-02-01 00:00:00",
      });
      insertTask({ status: "running" }); // fresh running — not stalled
      insertTask({ status: "completed", updatedAt: "2020-01-01 00:00:00" }); // old but not running
      const scope = buildReflectionScope("pattern_detector", "idle-detect");
      expect(scope.deltaEvents.map((e) => e.eventId).sort()).toEqual(
        [stale1, stale2].sort(),
      );
    });
  });

  describe("empty delta", () => {
    it("returns lastProcessedEventId = cursor floor when no new tasks", () => {
      const id = insertTask({});
      advanceCursor("morning_brief", id);
      const scope = buildReflectionScope("morning_brief", "n-turn");
      expect(scope.deltaEvents).toEqual([]);
      // Cursor must not move on an empty pass.
      expect(scope.lastProcessedEventId).toBe(id);
    });

    it("never reports lastProcessedEventId below the cursor floor", () => {
      const id = insertTask({});
      advanceCursor("morning_brief", id + 100); // floor ahead of any task
      const scope = buildReflectionScope("morning_brief", "cron-morning");
      expect(scope.deltaEvents).toEqual([]);
      expect(scope.lastProcessedEventId).toBe(id + 100);
    });
  });
});
