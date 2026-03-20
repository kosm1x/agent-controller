/**
 * Budget service tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: mockRun,
    get: mockGet,
  }),
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    budgetEnabled: true,
    budgetDailyLimitUsd: 10.0,
    inferencePrimaryModel: "qwen3.5-plus",
  }),
}));

import {
  recordCost,
  getDailySpend,
  isBudgetExceeded,
  getBudgetStatus,
} from "./service.js";

describe("budget service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue({
      run: mockRun,
      get: mockGet,
    });
  });

  describe("recordCost", () => {
    it("should insert cost_ledger row with calculated cost", () => {
      recordCost({
        runId: "run-1",
        taskId: "task-1",
        agentType: "fast",
        model: "qwen3.5-plus",
        promptTokens: 10_000,
        completionTokens: 2_000,
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO cost_ledger"),
      );
      // Cost: (10000/1000)*0.0008 + (2000/1000)*0.002 = 0.008 + 0.004 = 0.012
      expect(mockRun).toHaveBeenCalledWith(
        "run-1",
        "task-1",
        "fast",
        "qwen3.5-plus",
        10_000,
        2_000,
        expect.closeTo(0.012, 6),
      );
    });
  });

  describe("getDailySpend", () => {
    it("should return sum from last 24 hours", () => {
      mockGet.mockReturnValue({ total: 5.25 });

      const spend = getDailySpend();

      expect(spend).toBe(5.25);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("datetime('now', '-1 day')"),
      );
    });

    it("should return 0 when no records exist", () => {
      mockGet.mockReturnValue({ total: 0 });

      expect(getDailySpend()).toBe(0);
    });
  });

  describe("isBudgetExceeded", () => {
    it("should return false when under limit", () => {
      mockGet.mockReturnValue({ total: 5.0 });
      expect(isBudgetExceeded()).toBe(false);
    });

    it("should return true when at limit", () => {
      mockGet.mockReturnValue({ total: 10.0 });
      expect(isBudgetExceeded()).toBe(true);
    });

    it("should return true when over limit", () => {
      mockGet.mockReturnValue({ total: 15.0 });
      expect(isBudgetExceeded()).toBe(true);
    });
  });

  describe("getBudgetStatus", () => {
    it("should return full status object", () => {
      mockGet.mockReturnValue({ total: 3.5 });

      const status = getBudgetStatus();

      expect(status).toEqual({
        dailySpend: 3.5,
        dailyLimit: 10.0,
        remaining: 6.5,
        exceeded: false,
      });
    });

    it("should clamp remaining to 0 when over budget", () => {
      mockGet.mockReturnValue({ total: 12.0 });

      const status = getBudgetStatus();

      expect(status.remaining).toBe(0);
      expect(status.exceeded).toBe(true);
    });
  });
});
