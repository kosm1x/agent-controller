/**
 * Reflection cursor tests (V8.1 Phase 4 B1) — bounded-diff cursor state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  REFLECTION_CURSORS,
  seedReflectionCursors,
  readCursor,
  advanceCursor,
} from "./cursors.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

const rowCount = (): number =>
  (
    getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM reflection_cursors")
      .get() as { n: number }
  ).n;

describe("reflection cursors", () => {
  it("exposes exactly the three named cursors (spec §7)", () => {
    expect([...REFLECTION_CURSORS].sort()).toEqual([
      "general_events_discovery",
      "morning_brief",
      "pattern_detector",
    ]);
  });

  describe("readCursor", () => {
    it("reads an unseeded cursor as lastEventId 0 / updatedAt null, no write", () => {
      const c = readCursor("morning_brief");
      expect(c).toEqual({
        cursorName: "morning_brief",
        lastEventId: 0,
        updatedAt: null,
      });
      expect(rowCount()).toBe(0); // pure read — did not materialize a row
    });
  });

  describe("seedReflectionCursors", () => {
    it("creates all three cursor rows at 0", () => {
      seedReflectionCursors();
      expect(rowCount()).toBe(3);
      for (const name of REFLECTION_CURSORS) {
        expect(readCursor(name).lastEventId).toBe(0);
      }
    });

    it("is idempotent and never rewinds an advanced cursor", () => {
      seedReflectionCursors();
      advanceCursor("morning_brief", 42);
      seedReflectionCursors(); // second call must not reset
      expect(rowCount()).toBe(3);
      expect(readCursor("morning_brief").lastEventId).toBe(42);
    });
  });

  describe("advanceCursor", () => {
    it("moves a cursor forward and stamps updated_at", () => {
      const c = advanceCursor("pattern_detector", 100);
      expect(c.lastEventId).toBe(100);
      expect(c.updatedAt).not.toBeNull();
      expect(readCursor("pattern_detector").lastEventId).toBe(100);
    });

    it("self-heals a missing row (advancing an unseeded cursor)", () => {
      expect(rowCount()).toBe(0);
      advanceCursor("morning_brief", 7);
      expect(readCursor("morning_brief").lastEventId).toBe(7);
    });

    it("is monotonic — a lower toEventId is a no-op", () => {
      advanceCursor("morning_brief", 50);
      const c = advanceCursor("morning_brief", 20);
      expect(c.lastEventId).toBe(50);
    });

    it("is monotonic — an equal toEventId is a no-op", () => {
      advanceCursor("morning_brief", 50);
      expect(advanceCursor("morning_brief", 50).lastEventId).toBe(50);
    });

    it("rejects a negative or non-integer toEventId", () => {
      expect(() => advanceCursor("morning_brief", -1)).toThrow();
      expect(() => advanceCursor("morning_brief", 3.5)).toThrow();
    });
  });
});
