/**
 * Budget service tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    budgetHourlyLimitUsd: 2.0,
    budgetMonthlyLimitUsd: 200.0,
    inferencePrimaryModel: "qwen3.5-plus",
  }),
}));

import {
  recordCost,
  getDailySpend,
  getHourlySpend,
  getMonthlySpend,
  isBudgetExceeded,
  isAnyWindowExceeded,
  getBudgetStatus,
  getThreeWindowStatus,
  wouldExceedBudget,
} from "./service.js";

describe("budget service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
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

    it("uses costUsdOverride verbatim when provided (claude-sdk Max-auth path)", () => {
      // Regression guard for efficiency audit fix: under claude-sdk provider
      // with Max subscription auth, the SDK reports total_cost_usd=0 (truth).
      // Using the local pricing table would overstate spend by applying a
      // generic API rate card. The override must bypass calculateCost().
      recordCost({
        runId: "run-2",
        taskId: "task-2",
        agentType: "fast",
        model: "claude-sonnet-4-6",
        promptTokens: 50_000,
        completionTokens: 3_000,
        costUsdOverride: 0,
      });

      expect(mockRun).toHaveBeenCalledWith(
        "run-2",
        "task-2",
        "fast",
        "claude-sonnet-4-6",
        50_000,
        3_000,
        0,
      );
    });

    it("prefers costUsdOverride even when non-zero (metered API fallback)", () => {
      recordCost({
        runId: "run-3",
        taskId: "task-3",
        agentType: "heavy",
        model: "claude-sonnet-4-6",
        promptTokens: 10_000,
        completionTokens: 2_000,
        costUsdOverride: 0.087,
      });

      expect(mockRun).toHaveBeenCalledWith(
        "run-3",
        "task-3",
        "heavy",
        "claude-sonnet-4-6",
        10_000,
        2_000,
        0.087,
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

  describe("getHourlySpend", () => {
    it("should query with hour-boundary SQL", () => {
      mockGet.mockReturnValue({ total: 0.5 });
      expect(getHourlySpend()).toBe(0.5);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("%H:00:00"),
      );
    });
  });

  describe("getMonthlySpend", () => {
    it("should query with month-boundary SQL", () => {
      mockGet.mockReturnValue({ total: 45.0 });
      expect(getMonthlySpend()).toBe(45.0);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("%Y-%m-01"),
      );
    });
  });

  describe("getThreeWindowStatus", () => {
    it("should return status for all three windows", () => {
      // Each call to getDailySpend/getHourlySpend/getMonthlySpend calls prepare().get()
      mockGet
        .mockReturnValueOnce({ total: 0.5 }) // hourly
        .mockReturnValueOnce({ total: 3.0 }) // daily
        .mockReturnValueOnce({ total: 50.0 }); // monthly

      const status = getThreeWindowStatus();

      expect(status.hourly.spend).toBe(0.5);
      expect(status.hourly.limit).toBe(2.0);
      expect(status.hourly.exceeded).toBe(false);
      expect(status.daily.spend).toBe(3.0);
      expect(status.daily.limit).toBe(10.0);
      expect(status.monthly.spend).toBe(50.0);
      expect(status.monthly.limit).toBe(200.0);
    });
  });

  describe("isAnyWindowExceeded", () => {
    it("should return false when all under limit", () => {
      mockGet
        .mockReturnValueOnce({ total: 0.5 })
        .mockReturnValueOnce({ total: 3.0 })
        .mockReturnValueOnce({ total: 50.0 });
      expect(isAnyWindowExceeded()).toBe(false);
    });

    it("should return true when hourly exceeded", () => {
      mockGet
        .mockReturnValueOnce({ total: 2.5 }) // hourly over
        .mockReturnValueOnce({ total: 3.0 })
        .mockReturnValueOnce({ total: 50.0 });
      expect(isAnyWindowExceeded()).toBe(true);
    });

    it("should return true when monthly exceeded", () => {
      mockGet
        .mockReturnValueOnce({ total: 0.5 })
        .mockReturnValueOnce({ total: 3.0 })
        .mockReturnValueOnce({ total: 200.0 }); // monthly at limit
      expect(isAnyWindowExceeded()).toBe(true);
    });
  });

  describe("wouldExceedBudget", () => {
    it("should return false when well under all limits", () => {
      mockGet
        .mockReturnValueOnce({ total: 0.1 })
        .mockReturnValueOnce({ total: 1.0 })
        .mockReturnValueOnce({ total: 10.0 });
      const result = wouldExceedBudget("qwen3.5-plus", 10_000, 4_000);
      expect(result.exceeded).toBe(false);
    });

    it("should return true with window name when hourly would exceed", () => {
      mockGet
        .mockReturnValueOnce({ total: 1.99 }) // hourly almost at limit
        .mockReturnValueOnce({ total: 1.99 })
        .mockReturnValueOnce({ total: 10.0 });
      const result = wouldExceedBudget("qwen3.5-plus", 50_000, 4_000);
      expect(result.exceeded).toBe(true);
      expect(result.window).toBe("hourly");
    });
  });
});
