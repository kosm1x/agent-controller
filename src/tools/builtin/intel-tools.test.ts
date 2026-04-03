/**
 * Intel tool tests — arg parsing, NaN safety, output formatting.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock signal store
vi.mock("../../intel/signal-store.js", () => ({
  getRecentSignals: vi.fn().mockReturnValue([]),
  getSignalCounts: vi.fn().mockReturnValue([]),
  getSnapshot: vi.fn().mockReturnValue(undefined),
}));

// Mock alert router
vi.mock("../../intel/alert-router.js", () => ({
  getRecentAlerts: vi.fn().mockReturnValue([]),
}));

// Mock scheduler
vi.mock("../../intel/scheduler.js", () => ({
  getCollectorHealth: vi.fn().mockReturnValue([]),
  isRunning: vi.fn().mockReturnValue(true),
}));

// Mock baselines
vi.mock("../../intel/baselines.js", () => ({
  getBaselines: vi.fn().mockReturnValue([]),
  computeZScore: vi.fn().mockReturnValue(0),
}));

import { intelQueryTool } from "./intel-query.js";
import { intelStatusTool } from "./intel-status.js";
import { intelAlertHistoryTool } from "./intel-alert-history.js";
import { intelBaselineTool } from "./intel-baseline.js";

describe("intel tools", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("intel_query", () => {
    it("handles undefined args gracefully (defaults)", async () => {
      const result = await intelQueryTool.execute({});
      expect(result).toContain("No signals found");
    });

    it("handles NaN-producing string args", async () => {
      const result = await intelQueryTool.execute({
        hours: "banana",
        limit: "xyz",
      });
      // Should fall back to defaults, not crash
      expect(result).toContain("No signals found");
    });

    it("clamps hours and limit to valid ranges", async () => {
      const result = await intelQueryTool.execute({
        hours: 99999,
        limit: -5,
      });
      expect(result).toContain("No signals found");
    });
  });

  describe("intel_status", () => {
    it("returns status text when running", async () => {
      const result = await intelStatusTool.execute({});
      expect(result).toContain("RUNNING");
      expect(result).toContain("Collectors:");
    });
  });

  describe("intel_alert_history", () => {
    it("handles NaN-producing args", async () => {
      const result = await intelAlertHistoryTool.execute({
        hours: "not_a_number",
        limit: null,
      });
      expect(result).toContain("No");
    });

    it("filters by tier", async () => {
      const result = await intelAlertHistoryTool.execute({
        tier: "FLASH",
        hours: 24,
      });
      expect(result).toContain("No FLASH alerts");
    });
  });

  describe("intel_baseline", () => {
    it("requires source and key", async () => {
      const result = await intelBaselineTool.execute({});
      expect(result).toContain("required");
    });

    it("returns message when no baselines exist", async () => {
      const result = await intelBaselineTool.execute({
        source: "usgs",
        key: "quakes_5plus",
      });
      expect(result).toContain("No baselines available");
    });
  });
});
