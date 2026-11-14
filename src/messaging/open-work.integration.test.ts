/**
 * `OPEN_WORK_SQL` on the real schema (`initDatabase(":memory:")`), run with
 * the same four arguments `selectOpenWork` passes: window start, scan limit,
 * channel tag, row limit. Rows of neighbouring banks and tags, a fast-path
 * row, rows on each side of the 14-day edge (aged with the database's own
 * clock) and a tie on created_at broken by id. Row ids are inserted out of
 * time order, and tied rows sort the other way by content, so no other
 * column can stand in for the ordering. Fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { OPEN_WORK_ROW_LIMIT, OPEN_WORK_SCAN_LIMIT, OPEN_WORK_SQL } from "./open-work.js";

/** `at` is an SQL expression for created_at. */
function row(content: string, at: string, o: { bank?: string; tags?: string[] } = {}): void {
  getDatabase()
    .prepare(`INSERT INTO conversations (bank, tags, content, created_at) VALUES (?, ?, ?, ${at})`)
    .run(o.bank ?? "mc-jarvis", JSON.stringify(o.tags ?? ["telegram", "conversation"]), content);
}

function windowStart(): string {
  return (getDatabase().prepare("SELECT datetime('now', '-14 days') AS w").get() as { w: string }).w;
}

function select(start: string, scanLimit: number, tag: string, rowLimit: number): string[] {
  return (
    getDatabase().prepare(OPEN_WORK_SQL).all(start, scanLimit, tag, rowLimit) as Array<{
      content: string;
    }>
  ).map((r) => r.content);
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("OPEN_WORK_SQL — bank, tag, fast-path and window", () => {
  it("returns this bank's rows with this tag inside the window, newest first", () => {
    const start = windowStart();
    row("edge-in", `'${start}'`);
    row("in-newest", "datetime('now', '-1 hour')");
    row("bank-below", "datetime('now', '-2 hours')", { bank: "mc-jarvia" });
    row("bank-above", "datetime('now', '-2 hours')", { bank: "mc-jarvit" });
    row("tag-below", "datetime('now', '-3 hours')", { tags: ["telegraa", "conversation"] });
    row("tag-above", "datetime('now', '-3 hours')", { tags: ["telegran", "conversation"] });
    row("fast-path", "datetime('now', '-4 hours')", { tags: ["telegram", "fast-path"] });
    row("just-in", "datetime('now', '-14 days', '+5 minutes')");
    row("just-out", "datetime('now', '-14 days', '-5 minutes')");
    row("in-middle", "datetime('now', '-5 days')");
    expect(select(start, OPEN_WORK_SCAN_LIMIT, "telegram", OPEN_WORK_ROW_LIMIT)).toEqual([
      "in-newest",
      "in-middle",
      "just-in",
      "edge-in",
    ]);
  });
});

describe("OPEN_WORK_SQL — ordering and the two limits", () => {
  // Ids in insertion order: tie-low, t1, old, w1, tie-high. The tied rows
  // share created_at; their content sorts opposite to their ids.
  function seed(): void {
    row("tie-z-low-id", "datetime('now', '-30 minutes')");
    row("t1", "datetime('now', '-10 minutes')");
    row("old", "datetime('now', '-40 minutes')");
    row("w1", "datetime('now', '-20 minutes')", { tags: ["whatsapp", "conversation"] });
    row("tie-a-high-id", "datetime('now', '-30 minutes')");
  }

  it("scans only the newest rows of the bank (any tag), ties broken by id descending", () => {
    seed();
    // Newest three of the bank: t1, w1, tie-a-high-id; w1 is another channel.
    expect(select(windowStart(), 3, "telegram", OPEN_WORK_ROW_LIMIT)).toEqual([
      "t1",
      "tie-a-high-id",
    ]);
  });

  it("returns at most the row limit, newest first, ties broken by id descending", () => {
    seed();
    expect(select(windowStart(), OPEN_WORK_SCAN_LIMIT, "telegram", 3)).toEqual([
      "t1",
      "tie-a-high-id",
      "tie-z-low-id",
    ]);
    expect(select(windowStart(), OPEN_WORK_SCAN_LIMIT, "telegram", OPEN_WORK_ROW_LIMIT)).toEqual([
      "t1",
      "tie-a-high-id",
      "tie-z-low-id",
      "old",
    ]);
  });
});
