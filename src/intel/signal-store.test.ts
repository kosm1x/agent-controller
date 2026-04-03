/**
 * Signal store tests — CRUD operations on signals and snapshots.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStmt = {
  run: vi.fn(),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
};

const mockDb = {
  prepare: vi.fn().mockReturnValue(mockStmt),
  transaction: vi.fn((fn: Function) => fn),
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockStmt.run.mockReturnValue({ changes: 1 });
    mockStmt.get.mockReturnValue(undefined);
    mockStmt.all.mockReturnValue([]);
    mockDb.prepare.mockReturnValue(mockStmt);
    mockDb.transaction.mockImplementation((fn: Function) => fn);
  });

  describe("insertSignals", () => {
    it("inserts signals in a transaction", () => {
      const signals: Signal[] = [
        {
          source: "usgs",
          domain: "weather",
          signalType: "numeric",
          key: "quakes_5plus",
          valueNumeric: 3,
        },
      ];

      // Mock: no existing hash
      mockStmt.get.mockReturnValue(undefined);
      const count = insertSignals(signals);
      expect(count).toBe(1);
      expect(mockStmt.run).toHaveBeenCalled();
    });

    it("returns 0 for empty input", () => {
      expect(insertSignals([])).toBe(0);
    });

    it("skips signals with duplicate content_hash", () => {
      const signals: Signal[] = [
        {
          source: "usgs",
          domain: "weather",
          signalType: "event",
          key: "quake_abc",
          contentHash: "abc123",
        },
      ];

      // Mock: hash already exists
      mockStmt.get.mockReturnValue({ 1: 1 });
      const count = insertSignals(signals);
      expect(count).toBe(0);
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
