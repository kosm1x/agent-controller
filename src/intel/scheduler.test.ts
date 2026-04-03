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
      collect: vi.fn().mockResolvedValue([
        {
          source: "test_source",
          domain: "test",
          signalType: "numeric",
          key: "test_metric",
          valueNumeric: 42,
        },
      ]),
    },
  ],
}));

// Mock signal store and delta engine
const mockInsertSignals = vi.fn().mockReturnValue(1);
const mockPruneOldSignals = vi.fn().mockReturnValue(0);
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
