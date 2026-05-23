import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock both prune functions so we exercise the cron wrapper in isolation.
// Pattern mirrors the in-test mocks used by other runner-side wrappers
// (registerCohortRollupCron uses :memory: + the real path; we want to
// assert the wrapper's logging/error-swallowing contract specifically, so
// stubbed prunes are the right grain here).
const mockPruneSnapshots = vi.fn();
const mockPruneCheckpoints = vi.fn();

vi.mock("../prometheus/snapshot.js", () => ({
  pruneExpiredSnapshots: (...args: unknown[]) => mockPruneSnapshots(...args),
}));
vi.mock("./checkpoint.js", () => ({
  pruneExpiredCheckpoints: (...args: unknown[]) =>
    mockPruneCheckpoints(...args),
}));

import {
  registerCheckpointPruneCron,
  runCheckpointPrune,
  stopCheckpointPruneCron,
} from "./checkpoint-prune-cron.js";

const SILENT = { info: () => {}, warn: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  mockPruneSnapshots.mockReturnValue(0);
  mockPruneCheckpoints.mockReturnValue(0);
});

afterEach(() => {
  stopCheckpointPruneCron();
  vi.restoreAllMocks();
});

describe("runCheckpointPrune", () => {
  it("returns counts from both prune functions", () => {
    mockPruneSnapshots.mockReturnValue(3);
    mockPruneCheckpoints.mockReturnValue(2);
    const result = runCheckpointPrune(SILENT);
    expect(result).toEqual({ snapshots: 3, checkpoints: 2 });
    expect(mockPruneSnapshots).toHaveBeenCalledTimes(1);
    expect(mockPruneCheckpoints).toHaveBeenCalledTimes(1);
  });

  it("stays silent on a clean 0/0 sweep (no log spam on healthy systems)", () => {
    const info = vi.fn();
    runCheckpointPrune({ info, warn: () => {} });
    expect(info).not.toHaveBeenCalled();
  });

  it("logs when either count is non-zero", () => {
    mockPruneSnapshots.mockReturnValue(0);
    mockPruneCheckpoints.mockReturnValue(1);
    const info = vi.fn();
    runCheckpointPrune({ info, warn: () => {} });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("prune complete");
    expect(info.mock.calls[0][1]).toEqual({ snapshots: 0, checkpoints: 1 });
  });

  it("does NOT bubble exceptions from the underlying prune functions", () => {
    // Both internal prune fns are best-effort and never throw, but the
    // wrapper should not regress that contract. A throw in either prune
    // must not crash the node-cron scheduler.
    mockPruneSnapshots.mockImplementation(() => {
      throw new Error("simulated DB lock");
    });
    expect(() => runCheckpointPrune(SILENT)).not.toThrow();
  });
});

describe("registerCheckpointPruneCron", () => {
  it("is idempotent — calling twice stops the prior job first", () => {
    // First registration returns true; second also returns true (the
    // wrapper does NOT short-circuit on already-registered, it replaces
    // the job). Just assert no throw and both invocations return true.
    expect(registerCheckpointPruneCron(SILENT)).toBe(true);
    expect(registerCheckpointPruneCron(SILENT)).toBe(true);
  });

  it("stopCheckpointPruneCron is safe to call when nothing is registered", () => {
    expect(() => stopCheckpointPruneCron()).not.toThrow();
  });
});
