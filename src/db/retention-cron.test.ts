import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the sweeps so the tick's logging contract is exercised in isolation
// (same grain as runners/checkpoint-prune-cron.test.ts).
const mockRunTasksRetention = vi.fn();
const mockPruneTelemetry = vi.fn();
const mockPruneTraceEvents = vi.fn();

vi.mock("./retention.js", () => ({
  runTasksRetention: (...args: unknown[]) => mockRunTasksRetention(...args),
  pruneTelemetry: (...args: unknown[]) => mockPruneTelemetry(...args),
}));
vi.mock("../observability/task-trace.js", () => ({
  pruneTraceEvents: (...args: unknown[]) => mockPruneTraceEvents(...args),
}));

import { runRetentionTick } from "./retention-cron.js";
import type { RetentionReport } from "./retention.js";

const ZERO: RetentionReport = {
  cutoff: "2026-08-02 10:30:00",
  candidates: 0,
  skippedParents: 0,
  tasksDeleted: 0,
  runsDeleted: 0,
  outcomesDeleted: 0,
  archivePath: null,
  staleBlockedClosed: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRunTasksRetention.mockReturnValue(ZERO);
  mockPruneTelemetry.mockReturnValue({ scopeTelemetry: 0, recallAudit: 0 });
  mockPruneTraceEvents.mockReturnValue(0);
});

describe("runRetentionTick", () => {
  it("logs the sweep line with staleBlockedClosed when only stale blocked rows were closed (queue 4au)", () => {
    mockRunTasksRetention.mockReturnValue({ ...ZERO, staleBlockedClosed: 1 });
    const info = vi.fn();
    runRetentionTick({ info, warn: () => {} });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("retention sweep complete");
    expect(info.mock.calls[0][1]).toMatchObject({
      staleBlockedClosed: 1,
      tasksDeleted: 0,
    });
  });

  it("stays silent on an all-zero sweep", () => {
    const info = vi.fn();
    const warn = vi.fn();
    runRetentionTick({ info, warn });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
