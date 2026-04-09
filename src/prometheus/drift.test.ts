/**
 * Drift detection tests (Hermes H2).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn().mockReturnValue({ changes: 0 }),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn(),
  }),
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import { checkAndRecordDrift, pruneBaselines } from "./drift.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue({
    run: vi.fn().mockReturnValue({ changes: 0 }),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn(),
  });
});

describe("checkAndRecordDrift", () => {
  it("returns no drift with insufficient samples", () => {
    const allFn = vi.fn().mockReturnValue([{ score: 0.8 }, { score: 0.7 }]);
    mockDb.prepare.mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      all: allFn,
    });

    const result = checkAndRecordDrift("test-type", 0.5);
    expect(result.drifting).toBe(false);
    expect(result.stdDev).toBe(0);
  });

  it("detects drift when score < avg - 1 stddev", () => {
    // 5 scores: all 0.9 → avg=0.9, stddev=0. Current 0.5 < 0.9 - 0 = drift
    const allFn = vi
      .fn()
      .mockReturnValue([
        { score: 0.9 },
        { score: 0.9 },
        { score: 0.9 },
        { score: 0.9 },
        { score: 0.9 },
      ]);
    mockDb.prepare.mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      all: allFn,
    });

    const result = checkAndRecordDrift("test-type", 0.5);
    expect(result.drifting).toBe(true);
    expect(result.rollingAvg).toBeCloseTo(0.9);
  });

  it("does not flag drift when score is within range", () => {
    const allFn = vi
      .fn()
      .mockReturnValue([
        { score: 0.8 },
        { score: 0.7 },
        { score: 0.9 },
        { score: 0.8 },
        { score: 0.85 },
      ]);
    mockDb.prepare.mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      all: allFn,
    });

    const result = checkAndRecordDrift("test-type", 0.75);
    expect(result.drifting).toBe(false);
  });
});

describe("pruneBaselines", () => {
  it("runs without error", () => {
    expect(() => pruneBaselines("test-type")).not.toThrow();
  });
});
