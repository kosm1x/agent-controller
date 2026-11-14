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
  getRemainingBudgetUsd,
  BudgetExhaustedError,
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
      // Cache fields default to 0 when unset (openai/qwen path).
      expect(mockRun).toHaveBeenCalledWith(
        "run-1",
        "task-1",
        "fast",
        "qwen3.5-plus",
        10_000,
        2_000,
        expect.closeTo(0.012, 6),
        0,
        0,
        null,
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
        0,
        0,
        null,
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
        0,
        0,
        null,
      );
    });

    it("persists cache breakdown when provided (v8 S4 — claude-sdk path)", () => {
      // claude-sdk path forwards cacheReadTokens + cacheCreationTokens so
      // cache-hit ratio can be derived as cache_read_tokens / prompt_tokens.
      // Without persistence, the prompt_tokens column conflates raw input,
      // cache-creation, and cache-read into one number — making the cache
      // structure invisible at query time.
      recordCost({
        runId: "run-4",
        taskId: "task-4",
        agentType: "fast",
        model: "claude-sonnet-4-6",
        promptTokens: 50_000,
        completionTokens: 3_000,
        costUsdOverride: 0,
        cacheReadTokens: 41_500,
        cacheCreationTokens: 2_400,
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("cache_read_tokens"),
      );
      expect(mockRun).toHaveBeenCalledWith(
        "run-4",
        "task-4",
        "fast",
        "claude-sonnet-4-6",
        50_000,
        3_000,
        0,
        41_500,
        2_400,
        null,
      );
    });

    it("persists the SDK cost basis when provided (queue 2026-10-07 item 5)", () => {
      recordCost({
        runId: "run-6",
        taskId: "task-6",
        agentType: "fast",
        model: "claude-sonnet-5-5",
        promptTokens: 1_000,
        completionTokens: 100,
        costUsdOverride: 0.01,
        costBasis: "managed",
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("cost_basis"),
      );
      expect(mockRun).toHaveBeenCalledWith(
        "run-6",
        "task-6",
        "fast",
        "claude-sonnet-5-5",
        1_000,
        100,
        0.01,
        0,
        0,
        "managed",
      );
    });

    it("defaults cache columns to 0 when only one cache field is set", () => {
      // Defensive: nullish coalescing per-field, not per-pair, so a partially
      // populated record still inserts cleanly.
      recordCost({
        runId: "run-5",
        taskId: "task-5",
        agentType: "fast",
        model: "claude-sonnet-4-6",
        promptTokens: 10_000,
        completionTokens: 1_000,
        costUsdOverride: 0,
        cacheReadTokens: 8_000,
        // cacheCreationTokens omitted
      });

      expect(mockRun).toHaveBeenCalledWith(
        "run-5",
        "task-5",
        "fast",
        "claude-sonnet-4-6",
        10_000,
        1_000,
        0,
        8_000,
        0,
        null,
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

  describe("getRemainingBudgetUsd (V8.5 Phase 3.3)", () => {
    // getThreeWindowStatus query order: hourly, daily, monthly.
    // Config mock limits: hourly 2, daily 10, monthly 200.
    it("returns the smallest window headroom", () => {
      mockGet
        .mockReturnValueOnce({ total: 1.5 }) // hourly → 0.5 left
        .mockReturnValueOnce({ total: 5.0 }) // daily → 5 left
        .mockReturnValueOnce({ total: 50.0 }); // monthly → 150 left
      expect(getRemainingBudgetUsd()).toBeCloseTo(0.5);
    });

    it("reports a breached window as NEGATIVE, not the clamped 0", () => {
      mockGet
        .mockReturnValueOnce({ total: 2.5 }) // hourly breached by 0.5
        .mockReturnValueOnce({ total: 0 })
        .mockReturnValueOnce({ total: 0 });
      expect(getRemainingBudgetUsd()).toBeCloseTo(-0.5);
    });

    it("BudgetExhaustedError carries a stable name for callers that branch on it", () => {
      const err = new BudgetExhaustedError("budget_exhausted: test");
      expect(err.name).toBe("BudgetExhaustedError");
      expect(err).toBeInstanceOf(Error);
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

  // Real SQL on a real in-memory schema: the mocked prepare delegates to it,
  // so a wrong column or window fails here. The daily rows sit hours away
  // from their edge on the database clock. The hourly and monthly reads run
  // with the statement's 'now' fixed at an explicit instant and the process
  // zone set by the case, so their edges cannot move between seeding and
  // reading and the answer depends neither on the host clock nor on its zone.
  describe("spend reads on the real schema", () => {
    type RealIndex = typeof import("../db/index.js");
    let real: RealIndex;

    beforeEach(async () => {
      real = await vi.importActual<RealIndex>("../db/index.js");
      real.initDatabase(":memory:");
      const db = real.getDatabase();
      mockDb.prepare.mockImplementation((sql: string) => db.prepare(sql));
    });
    afterEach(() => {
      real.closeDatabase();
    });

    /**
     * One ledger row; `createdAtSql` is a fixed SQL datetime expression. The
     * spend reads count every agent and task, so cases mix two of each: a
     * read narrowed to one of them loses a row.
     */
    function spend(
      runId: string,
      costUsd: number,
      createdAtSql: string,
      agentType = "fast",
      taskId = "task-1",
    ): void {
      real
        .getDatabase()
        .prepare(
          `INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ${createdAtSql})`,
        )
        .run(runId, taskId, agentType, costUsd);
    }

    /**
     * Runs one spend read with its statement's 'now' replaced by `instant`
     * (a UTC datetime) and the process zone set to `zone`; the boundary
     * arithmetic is still SQLite's own. Every test file runs in its own
     * forked process, and the zone is restored before returning.
     */
    function readAt(zone: string, instant: string, read: () => number): number {
      const db = real.getDatabase();
      const statements: string[] = [];
      mockDb.prepare.mockImplementation((sql: string) => {
        statements.push(sql);
        return db.prepare(sql.replaceAll("'now'", `'${instant}'`));
      });
      const savedZone = process.env.TZ;
      process.env.TZ = zone;
      try {
        const total = read();
        // Fails closed: a read that stopped naming 'now' exactly once would
        // run on the wall clock instead of the instant.
        expect(statements).toHaveLength(1);
        expect(statements[0].split("'now'")).toHaveLength(2);
        return total;
      } finally {
        if (savedZone === undefined) delete process.env.TZ;
        else process.env.TZ = savedZone;
        mockDb.prepare.mockImplementation((sql: string) => db.prepare(sql));
      }
    }

    it("getDailySpend sums the last 24 hours only, 0 on an empty ledger", () => {
      expect(getDailySpend()).toBe(0);
      spend("r1", 1.25, "datetime('now', '-1 hours')");
      spend("r2", 0.5, "datetime('now', '-23 hours')");
      spend("r3", 4, "datetime('now', '-25 hours')");
      expect(getDailySpend()).toBeCloseTo(1.75, 6);
    });

    // created_at is UTC, and so is the hour edge; the zone is not UTC so a
    // local conversion added to the read would move the edge by hours.
    it("getHourlySpend sums from the start of the current UTC clock hour", () => {
      spend("edge", 0.25, "'2026-03-15 12:00:00'", "heavy", "task-2");
      spend("in-1", 0.5, "'2026-03-15 12:30:00'");
      spend("in-2", 0.5, "'2026-03-15 12:30:00'", "heavy", "task-2");
      spend("past", 3, "'2026-03-15 11:59:59'");
      expect(
        readAt("Etc/GMT+6", "2026-03-15 12:34:56", getHourlySpend),
      ).toBeCloseTo(1.25, 6);
    });

    // The month starts at local midnight on the 1st (the service's zone),
    // compared in UTC because created_at is UTC. One row sits exactly on that
    // edge and one a second before it, in a zone west of UTC and one east of
    // it (Etc/GMT+6 is UTC-6, Etc/GMT-5 is UTC+5); the second instant of each
    // zone is one where the local month and the UTC month differ.
    it.each([
      {
        zone: "Etc/GMT+6",
        now: "2026-03-15 12:00:00",
        edge: "2026-03-01 06:00:00",
        past: "2026-03-01 05:59:59",
        inside: "2026-03-10 00:00:00",
      },
      {
        zone: "Etc/GMT+6",
        now: "2026-04-01 03:00:00",
        edge: "2026-03-01 06:00:00",
        past: "2026-03-01 05:59:59",
        inside: "2026-03-31 23:00:00",
      },
      {
        zone: "Etc/GMT-5",
        now: "2026-03-15 12:00:00",
        edge: "2026-02-28 19:00:00",
        past: "2026-02-28 18:59:59",
        inside: "2026-03-10 00:00:00",
      },
      {
        zone: "Etc/GMT-5",
        now: "2026-03-31 21:00:00",
        edge: "2026-03-31 19:00:00",
        past: "2026-03-31 18:59:59",
        inside: "2026-03-31 20:00:00",
      },
    ])(
      "getMonthlySpend sums from local midnight on the 1st, in UTC ($zone, now $now)",
      ({ zone, now, edge, past, inside }) => {
        spend("edge", 2, `'${edge}'`, "heavy", "task-2");
        spend("in-1", 0.5, `'${inside}'`);
        spend("in-2", 0.5, `'${inside}'`, "heavy", "task-2");
        spend("past", 7, `'${past}'`);
        expect(readAt(zone, now, getMonthlySpend)).toBeCloseTo(3, 6);
      },
    );

    // Every column the write sets holds a value no other column of its row
    // holds and is read back on its own, so two swapped columns or a value
    // the statement defaults cannot pass. Omitted optional fields: cache
    // counts 0, cost basis NULL (never defaulted), cost from the price table.
    it("recordCost writes every given field to its own column, and the documented defaults for omitted ones", () => {
      recordCost({
        runId: "run-a",
        taskId: "task-a",
        agentType: "heavy",
        model: "model-a",
        promptTokens: 101,
        completionTokens: 202,
        costUsdOverride: 0.303,
        cacheReadTokens: 404,
        cacheCreationTokens: 505,
        costBasis: "managed",
      });
      recordCost({
        runId: "run-b",
        taskId: "task-b",
        agentType: "fast",
        model: "qwen3.5-plus",
        promptTokens: 10_000,
        completionTokens: 2_000,
      });
      const rows = real
        .getDatabase()
        .prepare(
          `SELECT run_id, task_id, agent_type, model, prompt_tokens,
                  completion_tokens, cost_usd, cache_read_tokens,
                  cache_creation_tokens, cost_basis,
                  abs(julianday('now') - julianday(created_at)) * 86400 < 60
                    AS stamped_now
             FROM cost_ledger ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        {
          run_id: "run-a",
          task_id: "task-a",
          agent_type: "heavy",
          model: "model-a",
          prompt_tokens: 101,
          completion_tokens: 202,
          cost_usd: 0.303,
          cache_read_tokens: 404,
          cache_creation_tokens: 505,
          cost_basis: "managed",
          stamped_now: 1,
        },
        {
          run_id: "run-b",
          task_id: "task-b",
          agent_type: "fast",
          model: "qwen3.5-plus",
          prompt_tokens: 10_000,
          completion_tokens: 2_000,
          cost_usd: expect.closeTo(0.012, 6),
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_basis: null,
          stamped_now: 1,
        },
      ]);
    });
  });
});
