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
vi.mock("./signal-store.js", () => ({
  insertSignals: vi.fn().mockReturnValue(1),
}));

vi.mock("./delta-engine.js", () => ({
  processSignals: vi.fn().mockReturnValue([]),
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
    stopIntelCollectors(); // ensure clean state
  });

  afterEach(() => {
    stopIntelCollectors();
    vi.useRealTimers();
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
});
