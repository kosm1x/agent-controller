/**
 * Thread hydration query plan (docs/planning/next-sessions-queue.md item 4bn).
 *
 * hydrateThreadIfNeeded had no time window and applied LIMIT 15 after the tag
 * filter, so a channel with fewer than 15 rows walked the whole bank history.
 * THREAD_HYDRATION_SQL bounds the inner select like OPEN_WORK_SQL. This runs
 * the REAL initDatabase and pins the plan of the exported statement: the
 * window must be an idx_conversations_bank_created range and the order must
 * come from the index, so dropping the index, the window predicate or the
 * index-ordered ORDER BY goes RED.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { THREAD_HYDRATION_SQL } from "../messaging/router.js";

afterEach(() => {
  closeDatabase();
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

describe("thread hydration — bounded scan on idx_conversations_bank_created (queue 4bn)", () => {
  it("the index exists on (bank, created_at)", () => {
    initDatabase(":memory:");
    expect(indexCols(getDatabase(), "idx_conversations_bank_created")).toEqual([
      "bank",
      "created_at",
    ]);
  });

  it("THREAD_HYDRATION_SQL is an index range on bank + created_at, with no full scan and no sort", () => {
    initDatabase(":memory:");
    const p = plan(
      getDatabase(),
      THREAD_HYDRATION_SQL,
      "thread-verified",
      "2026-10-25 00:00:00",
      3000,
      "telegram",
      15,
    );
    expect(p).toContain(
      "SEARCH conversations USING INDEX idx_conversations_bank_created (bank=? AND created_at>?)",
    );
    expect(p).not.toContain("SCAN conversations");
    expect(p).not.toContain("TEMP B-TREE");
  });
});
