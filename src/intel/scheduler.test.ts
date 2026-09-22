/**
 * Scheduler tests — verify start/stop lifecycle and health tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the adapter registry
vi.mock("./adapters/index.js", () => ({
  getAllAdapters: () => [
    {
      source: "test_source",
      domain: "test",
      defaultInterval: 60_000,
      collect: () => mockCollect(),
    },
  ],
}));
const SIGNALS = [
  {
    source: "test_source",
    domain: "test",
    signalType: "numeric",
    key: "test_metric",
    valueNumeric: 42,
  },
];
const mockCollect = vi.fn().mockResolvedValue(SIGNALS);

// Mock signal store and delta engine
const mockInsertSignals = vi.fn().mockReturnValue(1);
const mockPruneOldSignals = vi.fn().mockReturnValue(0);
const cronJobs: Array<{
  id: string;
  expr: string;
  fn: () => void;
  opts: unknown;
}> = [];
const mockCronStop = vi.fn();
vi.mock("../lib/cron.js", () => ({
  scheduleCron: (id: string, expr: string, fn: () => void, opts: unknown) => {
    cronJobs.push({ id, expr, fn, opts });
    return { stop: mockCronStop };
  },
}));

vi.mock("./signal-store.js", () => ({
  insertSignals: (...args: unknown[]) => mockInsertSignals(...args),
  pruneOldSignals: (...args: unknown[]) => mockPruneOldSignals(...args),
}));

const mockProcessSignals = vi.fn().mockReturnValue([]);
vi.mock("./delta-engine.js", () => ({
  processSignals: (...args: unknown[]) => mockProcessSignals(...args),
}));

const mockEvaluateDeltas = vi.fn().mockReturnValue([]);
const mockShouldSuppress = vi.fn().mockReturnValue(false);
const mockCreateAlert = vi.fn().mockReturnValue(1);
vi.mock("./alert-router.js", () => ({
  evaluateDeltas: (...args: unknown[]) => mockEvaluateDeltas(...args),
  shouldSuppress: (...args: unknown[]) => mockShouldSuppress(...args),
  createAlert: (...args: unknown[]) => mockCreateAlert(...args),
}));

const mockDeliverPendingAlerts = vi.fn().mockResolvedValue(0);
vi.mock("./alert-delivery.js", () => ({
  deliverPendingAlerts: (...args: unknown[]) =>
    mockDeliverPendingAlerts(...args),
}));

import {
  startIntelCollectors,
  stopIntelCollectors,
  getCollectorHealth,
  isRunning,
} from "./scheduler.js";

describe("intel scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopIntelCollectors();
    mockCollect.mockResolvedValue(SIGNALS);
    mockInsertSignals.mockReturnValue(1);
    mockPruneOldSignals.mockReturnValue(0);
    mockProcessSignals.mockReturnValue([]);
    mockEvaluateDeltas.mockReturnValue([]);
    mockShouldSuppress.mockReturnValue(false);
    mockCreateAlert.mockReturnValue(1);
    mockDeliverPendingAlerts.mockResolvedValue(0);
  });

  afterEach(() => {
    stopIntelCollectors();
    vi.restoreAllMocks();
  });

  it("a throwing pruner is contained (writeWithRetry rethrows; an uncaught throw here would exit the process)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPruneOldSignals.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    startIntelCollectors();
    const prune = cronJobs.filter((j) => j.id === "intel-signal-prune").at(-1)!;
    expect(() => prune.fn()).not.toThrow();
    expect(mockPruneOldSignals).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Signal pruning failed"),
    );
  });

  it("pruner is a wall-clock daily cron, stopped on shutdown (a boot-relative 24 h interval rarely fired)", () => {
    startIntelCollectors();
    const prune = cronJobs.filter((j) => j.id === "intel-signal-prune").at(-1)!;
    expect(prune.id).toBe("intel-signal-prune");
    expect(prune.expr).toBe("15 4 * * *");
    expect(prune.opts).toEqual({ timezone: "America/Mexico_City" });
    // No setInterval-based pruner remains: a day of fake time prunes nothing.
    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    expect(mockPruneOldSignals).not.toHaveBeenCalled();
    mockCronStop.mockClear();
    stopIntelCollectors();
    expect(mockCronStop).toHaveBeenCalledTimes(1);
    // A second start replaces the job instead of stacking a second pruner.
    startIntelCollectors();
    mockCronStop.mockClear();
    startIntelCollectors();
    expect(mockCronStop).toHaveBeenCalledTimes(1);
  });

  it("starts collectors and reports running", () => {
    startIntelCollectors();
    expect(isRunning()).toBe(true);
  });

  it("stops collectors and reports not running", () => {
    startIntelCollectors();
    stopIntelCollectors();
    expect(isRunning()).toBe(false);
  });

  it("tracks health for each collector", async () => {
    startIntelCollectors();
    // Allow the initial immediate collection to run
    await vi.advanceTimersByTimeAsync(10);

    const healths = getCollectorHealth();
    expect(healths).toHaveLength(1);
    expect(healths[0].source).toBe("test_source");
    expect(healths[0].lastAttempt).toBeTruthy();
  });

  // `intel_status` reads this record: a dead source must not look like a quiet one.
  it("records a throwing collector as a failure, not as a successful empty poll", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCollect.mockRejectedValue(new Error("HTTP 429 — slow down"));
    startIntelCollectors();
    await vi.advanceTimersByTimeAsync(10);

    const [h] = getCollectorHealth();
    expect(h.consecutiveFailures).toBe(1);
    expect(h.lastSuccess).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[intel] test_source failed (1x): HTTP 429 — slow down",
    );

    mockCollect.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getCollectorHealth()[0].consecutiveFailures).toBe(0);
    expect(getCollectorHealth()[0].lastSuccess).toBeTruthy();
  });

  it("does not duplicate collectors on double start", () => {
    startIntelCollectors();
    startIntelCollectors();
    const healths = getCollectorHealth();
    expect(healths).toHaveLength(1);
  });

  it("evaluates deltas and creates alerts when deltas are non-empty", async () => {
    const delta = {
      source: "test_source",
      key: "test_metric",
      previous: 10,
      current: 42,
      changeRatio: 3.2,
      severity: "critical" as const,
    };
    mockProcessSignals.mockReturnValue([delta]);
    mockEvaluateDeltas.mockReturnValue([
      {
        tier: "FLASH",
        domain: "test",
        title: "test alert",
        body: "test",
        signalIds: [],
        contentHash: "abc",
      },
    ]);

    startIntelCollectors();
    await vi.advanceTimersByTimeAsync(10);

    expect(mockEvaluateDeltas).toHaveBeenCalledWith([delta]);
    expect(mockCreateAlert).toHaveBeenCalled();
  });

  it("suppresses duplicate alerts", async () => {
    mockProcessSignals.mockReturnValue([
      {
        source: "test_source",
        key: "test_metric",
        previous: 10,
        current: 42,
        changeRatio: 3.2,
        severity: "critical",
      },
    ]);
    mockEvaluateDeltas.mockReturnValue([
      {
        tier: "FLASH",
        domain: "test",
        title: "test",
        body: "test",
        signalIds: [],
        contentHash: "abc",
      },
    ]);
    mockShouldSuppress.mockReturnValue(true);

    startIntelCollectors();
    await vi.advanceTimersByTimeAsync(10);

    expect(mockShouldSuppress).toHaveBeenCalled();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});
