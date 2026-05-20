/**
 * Implicit-deadline detector tests (V8.1 Phase 5 B2).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectImplicitDeadlines, extractDates } from "./implicit-deadlines.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Fixed "today" for deterministic daysUntil maths. */
const NOW = Date.parse("2026-06-15T12:00:00Z");

describe("extractDates", () => {
  it("extracts ISO dates in the 2026-2029 range", () => {
    expect(extractDates("ship by 2026-07-01 ok")).toEqual(["2026-07-01"]);
  });

  it("ignores ISO dates outside 2026-2029", () => {
    expect(extractDates("done 2025-07-01 and 2030-01-01")).toEqual([]);
  });

  it("extracts Spanish 'DD de MES de YYYY'", () => {
    expect(extractDates("entregar el 15 de junio de 2026")).toEqual([
      "2026-06-15",
    ]);
  });

  it("extracts Spanish 'DD MES YYYY' without the 'de's", () => {
    expect(extractDates("limite 3 marzo 2027")).toEqual(["2027-03-03"]);
  });

  it("extracts English 'Month DD, YYYY' and 'DD Month YYYY'", () => {
    expect(extractDates("due January 15, 2026")).toEqual(["2026-01-15"]);
    expect(extractDates("due 15 January 2026")).toEqual(["2026-01-15"]);
  });

  it("rejects impossible calendar dates", () => {
    expect(extractDates("2026-02-30")).toEqual([]);
    expect(extractDates("31 February 2026")).toEqual([]);
  });

  it("deduplicates a date written two ways", () => {
    expect(extractDates("2026-06-15 and also 15 de junio de 2026")).toEqual([
      "2026-06-15",
    ]);
  });
});

/** Insert a task with given description text and status. */
function insertTask(description: string, status = "pending"): string {
  const id = `t-${crypto.randomUUID()}`;
  getDatabase()
    .prepare(
      "INSERT INTO tasks (task_id, title, description, status) VALUES (?, 'task', ?, ?)",
    )
    .run(id, description, status);
  return id;
}

describe("detectImplicitDeadlines", () => {
  it("flags a date inside the 7-day window on a non-terminal task", () => {
    const id = insertTask("must finish by 2026-06-18");
    const signals = detectImplicitDeadlines(NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.parsedDate).toBe("2026-06-18");
    expect(signals[0]!.daysUntil).toBe(3);
    expect(signals[0]!.sourceRef).toBe(id);
    expect(signals[0]!.sourceField).toBe("description");
  });

  it("flags a recently-overdue date with a negative daysUntil", () => {
    insertTask("was due 2026-06-10");
    const signals = detectImplicitDeadlines(NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.daysUntil).toBe(-5);
  });

  it("ignores a date well beyond the 7-day window", () => {
    insertTask("target 2026-08-01");
    expect(detectImplicitDeadlines(NOW)).toEqual([]);
  });

  it("ignores a date overdue by more than 60 days", () => {
    insertTask("was due 2026-03-01");
    expect(detectImplicitDeadlines(NOW)).toEqual([]);
  });

  it("ignores terminal-done tasks", () => {
    insertTask("due 2026-06-16", "completed");
    insertTask("due 2026-06-16", "cancelled");
    expect(detectImplicitDeadlines(NOW)).toEqual([]);
  });

  it("anchors 'today' to MX-local time, not UTC (W1 regression)", () => {
    // 2026-06-16 02:00 UTC = 2026-06-15 20:00 MX — MX 'today' is the 15th.
    const eveningMx = Date.parse("2026-06-16T02:00:00Z");
    insertTask("ship by 2026-06-15");
    const signals = detectImplicitDeadlines(eveningMx);
    expect(signals).toHaveLength(1);
    // UTC-midnight maths would wrongly report -1 (already "tomorrow" in UTC).
    expect(signals[0]!.daysUntil).toBe(0);
  });

  it("scans NorthStar objectives too", () => {
    getDatabase()
      .prepare(
        "INSERT INTO jarvis_files (id, path, title, content) VALUES (?, 'NorthStar/objectives/x.md', 'X', ?)",
      )
      .run(crypto.randomUUID(), "deliver by 2026-06-17");
    const signals = detectImplicitDeadlines(NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.sourceRef).toBe("NorthStar/objectives/x.md");
  });
});
