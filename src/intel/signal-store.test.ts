/**
 * Signal store tests — CRUD operations on signals and snapshots.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ensureIntelTables } from "../db/intel-schema.js";

const mockStmt = {
  run: vi.fn(),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
};

const mockDb = {
  prepare: vi.fn().mockReturnValue(mockStmt),
  transaction: vi.fn((fn: Function) => fn),
};

// insertSignals' dedup lives in the DB itself (UNIQUE index + ON CONFLICT), so
// its tests run against a real in-memory DB; the query-shape tests below keep
// the statement mock. getDatabase() serves whichever is active.
let activeDb: unknown = mockDb;

vi.mock("../db/index.js", () => ({
  getDatabase: () => activeDb,
  writeWithRetry: <T>(fn: () => T): T => fn(),
}));

import {
  insertSignals,
  upsertSnapshot,
  getSnapshot,
  getRecentSignals,
  getSignalCounts,
  pruneOldSignals,
  contentHash,
} from "./signal-store.js";
import type { Signal } from "./types.js";

describe("signal-store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockStmt.run.mockReturnValue({ changes: 1 });
    mockStmt.get.mockReturnValue(undefined);
    mockStmt.all.mockReturnValue([]);
    mockDb.prepare.mockReturnValue(mockStmt);
    mockDb.transaction.mockImplementation((fn: Function) => fn);
  });

  describe("insertSignals (real in-memory DB — dedup lives in the UNIQUE index)", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
      ensureIntelTables(db);
      activeDb = db;
    });

    afterEach(() => {
      activeDb = mockDb;
      db.close();
    });

    const signal = (over: Partial<Signal> = {}): Signal => ({
      source: "usgs",
      domain: "weather",
      signalType: "numeric",
      key: "quakes_5plus",
      valueNumeric: 3,
      ...over,
    });

    it("inserts signals and reports the inserted count", () => {
      const count = insertSignals([signal(), signal({ key: "quakes_6plus" })]);
      expect(count).toBe(2);
      const rows = db.prepare("SELECT key FROM signals ORDER BY key").all();
      expect(rows).toEqual([{ key: "quakes_5plus" }, { key: "quakes_6plus" }]);
    });

    it("returns 0 for empty input", () => {
      expect(insertSignals([])).toBe(0);
    });

    it("skips signals whose content_hash already exists", () => {
      expect(insertSignals([signal({ contentHash: "abc123" })])).toBe(1);
      // Same hash again — deduped by the UNIQUE index, not counted.
      expect(insertSignals([signal({ contentHash: "abc123" })])).toBe(0);
      const n = db.prepare("SELECT COUNT(*) AS n FROM signals").get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    });

    it("dedupes within a single batch too", () => {
      const count = insertSignals([
        signal({ contentHash: "same" }),
        signal({ key: "other", contentHash: "same" }),
      ]);
      expect(count).toBe(1);
    });

    it("allows multiple signals with NULL content_hash (NULLs never conflict)", () => {
      const count = insertSignals([signal(), signal()]);
      expect(count).toBe(2);
    });
  });

  describe("upsertSnapshot", () => {
    it("calls UPSERT with correct params", () => {
      upsertSnapshot("usgs", "quakes_5plus", 5, null, null);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO signal_snapshots"),
      );
      expect(mockStmt.run).toHaveBeenCalledWith(
        "usgs",
        "quakes_5plus",
        5,
        null,
        null,
      );
    });
  });

  describe("getSnapshot", () => {
    it("returns snapshot row when found", () => {
      const row = {
        source: "usgs",
        key: "quakes_5plus",
        last_value_numeric: 3,
        last_value_text: null,
        last_hash: null,
        snapshot_at: "2026-04-03",
        run_count: 5,
      };
      mockStmt.get.mockReturnValue(row);

      const result = getSnapshot("usgs", "quakes_5plus");
      expect(result).toEqual(row);
    });

    it("returns undefined when not found", () => {
      mockStmt.get.mockReturnValue(undefined);
      expect(getSnapshot("unknown", "key")).toBeUndefined();
    });
  });

  describe("getRecentSignals", () => {
    it("queries with hour filter", () => {
      getRecentSignals(12);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("collected_at >= datetime"),
      );
      expect(mockStmt.all).toHaveBeenCalledWith(12, 100);
    });

    it("applies source and domain filters", () => {
      getRecentSignals(24, "usgs", "weather", 50);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("source = ?"),
      );
      expect(mockStmt.all).toHaveBeenCalledWith(24, "usgs", "weather", 50);
    });
  });

  describe("getSignalCounts", () => {
    it("groups by source", () => {
      mockStmt.all.mockReturnValue([
        { source: "usgs", count: 42 },
        { source: "nws", count: 15 },
      ]);
      const counts = getSignalCounts(24);
      expect(counts).toHaveLength(2);
      expect(counts[0].source).toBe("usgs");
    });
  });

  describe("pruneOldSignals", () => {
    it("deletes old signals and returns count", () => {
      mockStmt.run.mockReturnValue({ changes: 150 });
      const deleted = pruneOldSignals(30);
      expect(deleted).toBe(150);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM signals"),
      );
    });
  });

  describe("contentHash", () => {
    it("returns consistent 16-char hex hash", () => {
      const h1 = contentHash("test input");
      const h2 = contentHash("test input");
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(16);
      expect(/^[a-f0-9]+$/.test(h1)).toBe(true);
    });

    it("returns different hashes for different inputs", () => {
      expect(contentHash("a")).not.toBe(contentHash("b"));
    });
  });
});
