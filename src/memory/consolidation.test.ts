/**
 * CCP7: Memory consolidation cycle tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock getDatabase to return an in-memory SQLite instance
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue({ cnt: 0 }),
    run: vi.fn().mockReturnValue({ changes: 0 }),
  }),
  exec: vi.fn(),
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import { runConsolidation } from "./consolidation.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default mock returns
  mockDb.prepare.mockReturnValue({
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue({ cnt: 0 }),
    run: vi.fn().mockReturnValue({ changes: 0 }),
  });
});

describe("runConsolidation", () => {
  it("completes with empty database", async () => {
    const report = await runConsolidation();
    expect(report.duplicatesRemoved).toBe(0);
    expect(report.pruned).toBe(0);
    expect(report.remaining).toBe(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns orient counts from database", async () => {
    const allFn = vi.fn();
    const getFn = vi.fn().mockReturnValue({ cnt: 42 });
    const runFn = vi.fn().mockReturnValue({ changes: 0 });
    mockDb.prepare.mockReturnValue({ all: allFn, get: getFn, run: runFn });

    // First call: orient (GROUP BY bank)
    allFn.mockReturnValueOnce([
      { bank: "mc-operational", cnt: 30 },
      { bank: "mc-jarvis", cnt: 12 },
    ]);
    // Second call: consolidate duplicates (no groups)
    allFn.mockReturnValueOnce([]);

    const report = await runConsolidation();
    expect(report.orient).toEqual({
      "mc-operational": 30,
      "mc-jarvis": 12,
    });
  });

  it("reports stale candidate count", async () => {
    const allFn = vi.fn().mockReturnValue([]);
    const getFn = vi.fn();
    const runFn = vi.fn().mockReturnValue({ changes: 0 });
    mockDb.prepare.mockReturnValue({ all: allFn, get: getFn, run: runFn });

    // orient
    allFn.mockReturnValueOnce([{ bank: "mc-operational", cnt: 5 }]);
    // consolidate (no dups)
    allFn.mockReturnValueOnce([]);
    // stale count
    getFn.mockReturnValueOnce({ cnt: 3 });
    // remaining
    getFn.mockReturnValueOnce({ cnt: 2 });

    const report = await runConsolidation();
    expect(report.staleCandidates).toBe(3);
    expect(report.remaining).toBe(2);
  });

  it("calls VACUUM when entries were removed", async () => {
    const allFn = vi.fn().mockReturnValue([]);
    const getFn = vi.fn().mockReturnValue({ cnt: 0 });
    const runFn = vi.fn();
    mockDb.prepare.mockReturnValue({ all: allFn, get: getFn, run: runFn });

    // orient
    allFn.mockReturnValueOnce([]);
    // consolidate (no dups)
    allFn.mockReturnValueOnce([]);
    // prune: simulate 2 deletions
    runFn
      .mockReturnValueOnce({ changes: 2 })
      .mockReturnValueOnce({ changes: 0 });

    await runConsolidation();
    expect(mockDb.exec).toHaveBeenCalledWith("VACUUM");
  });

  it("does not VACUUM when nothing removed", async () => {
    const allFn = vi.fn().mockReturnValue([]);
    const getFn = vi.fn().mockReturnValue({ cnt: 0 });
    const runFn = vi.fn().mockReturnValue({ changes: 0 });
    mockDb.prepare.mockReturnValue({ all: allFn, get: getFn, run: runFn });

    // orient
    allFn.mockReturnValueOnce([]);
    // consolidate
    allFn.mockReturnValueOnce([]);

    await runConsolidation();
    expect(mockDb.exec).not.toHaveBeenCalled();
  });
});
