/**
 * Research provenance on the real schema through initDatabase(":memory:"):
 * every statement of provenance.ts runs against the real `task_provenance`
 * table, its `status` CHECK included. Rows read back by time order are seeded
 * with explicit, distinct `created_at` values in the reverse of their id
 * order, so the ORDER BY decides the result and not the insertion order.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "./index.js";
import {
  insertProvenance,
  getProvenanceByTask,
  getProvenanceByGoal,
  getUnanchoredUrls,
  countByStatus,
} from "./provenance.js";
import type { ProvenanceStatus } from "./provenance.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

function seed(
  taskId: string,
  goalId: string,
  status: ProvenanceStatus,
  url: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO task_provenance (task_id, goal_id, tool_name, url, status, created_at)
     VALUES (?, ?, 'web_read', ?, ?, ?)`,
  ).run(taskId, goalId, url, status, createdAt);
}

/** Two goals of task-a and one row of another task, newest inserted first. */
function seedTimeline(): void {
  seed("task-a", "g-1", "unverified", "https://a.example/3", "2001-01-01 00:00:03");
  seed("task-a", "g-2", "verified", "https://a.example/2", "2001-01-01 00:00:02");
  seed("task-a", "g-1", "unverified", "https://a.example/1", "2001-01-01 00:00:01");
  seed("task-b", "g-1", "inferred", "https://b.example/1", "2001-01-01 00:00:00");
}

const urls = (rows: Array<{ url: string | null }>): Array<string | null> =>
  rows.map((r) => r.url);

describe("insertProvenance", () => {
  it("writes every field of each record and returns the number written", () => {
    const n = insertProvenance([
      {
        task_id: "task-a",
        goal_id: "g-1",
        tool_name: "web_read",
        url: "https://a.example/page",
        query: null,
        status: "verified",
        content_hash: "hash-1",
        snippet: "a quoted line",
      },
      {
        task_id: "task-a",
        goal_id: "g-1",
        tool_name: "web_search",
        url: null,
        query: "synthetic query",
        status: "inferred",
        content_hash: null,
        snippet: null,
      },
    ]);

    expect(n).toBe(2);
    const rows = db
      .prepare(
        `SELECT task_id, goal_id, tool_name, url, query, status, content_hash, snippet, created_at
         FROM task_provenance ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      task_id: "task-a",
      goal_id: "g-1",
      tool_name: "web_read",
      url: "https://a.example/page",
      query: null,
      status: "verified",
      content_hash: "hash-1",
      snippet: "a quoted line",
    });
    expect(rows[1]).toMatchObject({
      tool_name: "web_search",
      url: null,
      query: "synthetic query",
      status: "inferred",
    });
    expect(rows[0].created_at).toEqual(expect.any(String));
  });

  it("refuses the whole batch when one status is outside the CHECK, so no partial batch is kept", () => {
    const good = {
      task_id: "task-a",
      goal_id: "g-1",
      tool_name: "web_read",
      url: "https://a.example/ok",
      query: null,
      status: "verified" as ProvenanceStatus,
      content_hash: null,
      snippet: null,
    };

    expect(() =>
      insertProvenance([
        good,
        { ...good, status: "guessed" as ProvenanceStatus },
      ]),
    ).toThrow(/CHECK constraint failed/);
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM task_provenance")
      .get() as { n: number };
    expect(n).toBe(0);
  });
});

describe("provenance reads", () => {
  it("getProvenanceByTask returns only that task's rows, oldest first", () => {
    seedTimeline();
    expect(urls(getProvenanceByTask("task-a"))).toEqual([
      "https://a.example/1",
      "https://a.example/2",
      "https://a.example/3",
    ]);
  });

  it("getProvenanceByGoal returns the goal's rows across tasks, oldest first", () => {
    seedTimeline();
    expect(urls(getProvenanceByGoal("g-1"))).toEqual([
      "https://b.example/1",
      "https://a.example/1",
      "https://a.example/3",
    ]);
  });

  it("getUnanchoredUrls returns only the task's unverified rows, oldest first", () => {
    seedTimeline();
    // An inferred row is not unanchored either: only 'unverified' counts.
    seed("task-a", "g-3", "inferred", "https://a.example/4", "2001-01-01 00:00:04");
    const rows = getUnanchoredUrls("task-a");
    expect(urls(rows)).toEqual(["https://a.example/1", "https://a.example/3"]);
    expect(rows.every((r) => r.status === "unverified")).toBe(true);
  });

  it("countByStatus counts the task's rows per status and reports absent statuses as zero", () => {
    seedTimeline();
    expect(countByStatus("task-a")).toEqual({
      verified: 1,
      inferred: 0,
      unverified: 2,
    });
    expect(countByStatus("task-none")).toEqual({
      verified: 0,
      inferred: 0,
      unverified: 0,
    });
  });
});
