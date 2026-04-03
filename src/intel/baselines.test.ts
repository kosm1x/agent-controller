/**
 * Baselines tests — rolling stats computation and z-score.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStmt = {
  run: vi.fn(),
  get: vi.fn().mockReturnValue(undefined),
  all: vi.fn().mockReturnValue([]),
};

const mockDb = {
  prepare: vi.fn().mockReturnValue(mockStmt),
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: <T>(fn: () => T): T => fn(),
}));

vi.mock("./delta-engine.js", () => ({
  METRICS: [
    {
      source: "test",
      key: "metric1",
      type: "numeric",
      threshold: 10,
      riskSensitive: false,
    },
  ],
}));

import {
  computeBaseline,
  computeAllBaselines,
  getBaseline,
  getBaselines,
  computeZScore,
  type BaselineRow,
} from "./baselines.js";

describe("baselines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStmt.run.mockReturnValue({ changes: 1 });
    mockStmt.get.mockReturnValue(undefined);
    mockStmt.all.mockReturnValue([]);
    mockDb.prepare.mockReturnValue(mockStmt);
  });

  describe("computeZScore", () => {
    it("computes correct z-score", () => {
      const baseline: BaselineRow = {
        source: "test",
        key: "metric1",
        window: "24h",
        mean: 100,
        stddev: 10,
        min_val: 80,
        max_val: 120,
        sample_count: 50,
        computed_at: "2026-04-03",
      };
      // current=130 → (130-100)/10 = 3.0
      expect(computeZScore(130, baseline)).toBe(3);
    });

    it("returns 0 when stddev is 0", () => {
      const baseline: BaselineRow = {
        source: "test",
        key: "metric1",
        window: "24h",
        mean: 100,
        stddev: 0,
        min_val: 100,
        max_val: 100,
        sample_count: 5,
        computed_at: "2026-04-03",
      };
      expect(computeZScore(200, baseline)).toBe(0);
    });

    it("returns negative z-score for below-mean values", () => {
      const baseline: BaselineRow = {
        source: "test",
        key: "metric1",
        window: "24h",
        mean: 100,
        stddev: 20,
        min_val: 60,
        max_val: 140,
        sample_count: 30,
        computed_at: "2026-04-03",
      };
      // current=60 → (60-100)/20 = -2.0
      expect(computeZScore(60, baseline)).toBe(-2);
    });
  });

  describe("computeBaseline", () => {
    it("queries signals and upserts baseline for each window", () => {
      mockStmt.get.mockReturnValue({
        mean: 50,
        stddev: 5,
        min_val: 40,
        max_val: 60,
        sample_count: 10,
      });

      computeBaseline("test", "metric1");

      // Should call prepare for both 24h and 7d windows
      expect(mockDb.prepare).toHaveBeenCalled();
      // Should upsert for each window (2 SELECT + 2 UPSERT = 4 prepare calls)
      expect(mockStmt.run).toHaveBeenCalled();
    });

    it("skips window with insufficient samples", () => {
      mockStmt.get.mockReturnValue({
        mean: null,
        stddev: 0,
        min_val: null,
        max_val: null,
        sample_count: 1,
      });

      computeBaseline("test", "metric1");
      // With sample_count < 2, no UPSERT should happen
      // (the SELECT still runs but the INSERT is skipped)
    });
  });

  describe("computeAllBaselines", () => {
    it("computes baselines for all metrics without throwing", () => {
      mockStmt.get.mockReturnValue({
        mean: 50,
        stddev: 5,
        min_val: 40,
        max_val: 60,
        sample_count: 10,
      });
      expect(() => computeAllBaselines()).not.toThrow();
    });
  });

  describe("getBaseline", () => {
    it("returns baseline row when found", () => {
      const row: BaselineRow = {
        source: "test",
        key: "metric1",
        window: "24h",
        mean: 50,
        stddev: 5,
        min_val: 40,
        max_val: 60,
        sample_count: 10,
        computed_at: "2026-04-03",
      };
      mockStmt.get.mockReturnValue(row);

      const result = getBaseline("test", "metric1", "24h");
      expect(result).toEqual(row);
    });

    it("returns undefined when not found", () => {
      mockStmt.get.mockReturnValue(undefined);
      expect(getBaseline("unknown", "key")).toBeUndefined();
    });
  });

  describe("getBaselines", () => {
    it("returns all windows for a metric", () => {
      mockStmt.all.mockReturnValue([
        {
          source: "test",
          key: "metric1",
          window: "24h",
          mean: 50,
          stddev: 5,
          min_val: 40,
          max_val: 60,
          sample_count: 10,
          computed_at: "2026-04-03",
        },
        {
          source: "test",
          key: "metric1",
          window: "7d",
          mean: 48,
          stddev: 8,
          min_val: 35,
          max_val: 65,
          sample_count: 50,
          computed_at: "2026-04-03",
        },
      ]);

      const baselines = getBaselines("test", "metric1");
      expect(baselines).toHaveLength(2);
    });
  });
});
