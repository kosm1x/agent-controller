/**
 * Task outcomes CRUD tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  }),
};

vi.mock("./index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: <T>(fn: () => T): T => fn(),
}));

import {
  recordOutcome,
  queryOutcomes,
  updateFeedback,
  noteConcernDetail,
  takeConcernDetail,
  findLatestOutcomeTaskForThread,
  aggregateToolEffectiveness,
  aggregateRunnerPerformance,
  queryRunnerStats,
  queryOutcomesByKeywords,
  queryFeedbackQuality,
} from "./task-outcomes.js";

describe("task-outcomes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue({
      run: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    });
  });

  describe("recordOutcome", () => {
    it("should insert row with correct values", () => {
      const runFn = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runFn });

      recordOutcome({
        task_id: "task-1",
        classified_as: "fast",
        ran_on: "fast",
        tools_used: ["jarvis_file_read", "jarvis_file_write"],
        duration_ms: 2500,
        success: true,
        tags: ["messaging", "telegram"],
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO task_outcomes"),
      );
      expect(runFn).toHaveBeenCalledWith(
        "task-1",
        "fast",
        "fast",
        '["jarvis_file_read","jarvis_file_write"]',
        2500,
        1,
        '["messaging","telegram"]',
        null,
        null,
        null,
      );
    });

    it("should store success=0 for failed tasks", () => {
      const runFn = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runFn });

      recordOutcome({
        task_id: "task-2",
        classified_as: "fast",
        ran_on: "fast",
        tools_used: [],
        duration_ms: 500,
        success: false,
        tags: [],
      });

      expect(runFn).toHaveBeenCalledWith(
        "task-2",
        "fast",
        "fast",
        "[]",
        500,
        0,
        "[]",
        null,
        null,
        null,
      );
    });
  });

  describe("concern_detail", () => {
    it("recordOutcome writes concern_detail as the 10th bound value", () => {
      const runFn = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runFn });

      recordOutcome({
        task_id: "task-3",
        classified_as: "fast",
        ran_on: "fast",
        tools_used: [],
        duration_ms: 100,
        success: true,
        tags: [],
        concern_reason: "other",
        concern_detail: "no pude verificar la fuente",
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("concern_reason, concern_detail)"),
      );
      expect(runFn.mock.calls[0]).toHaveLength(10);
      expect(runFn.mock.calls[0]![8]).toBe("other");
      expect(runFn.mock.calls[0]![9]).toBe("no pude verificar la fuente");
    });

    it("take returns the noted detail once, then null", () => {
      noteConcernDetail("t-once", "  sin datos de hoy  ");
      expect(takeConcernDetail("t-once")).toBe("sin datos de hoy");
      expect(takeConcernDetail("t-once")).toBeNull();
    });

    it("null / blank / never-noted → null; a null note clears an earlier one", () => {
      expect(takeConcernDetail("t-never")).toBeNull();
      noteConcernDetail("t-blank", "   ");
      expect(takeConcernDetail("t-blank")).toBeNull();
      noteConcernDetail("t-clear", "stale");
      noteConcernDetail("t-clear", null);
      expect(takeConcernDetail("t-clear")).toBeNull();
      noteConcernDetail("t-obj", { not: "a string" });
      expect(takeConcernDetail("t-obj")).toBeNull();
    });

    it("caps the detail at 500 chars", () => {
      noteConcernDetail("t-cap", "c".repeat(800));
      expect(takeConcernDetail("t-cap")).toBe("c".repeat(500));
    });

    it("redacts a credential BEFORE the 500-char cut", () => {
      // Built at runtime — no key-shaped literal in the (public) repo.
      const key = "AIza" + "b".repeat(35);
      noteConcernDetail("t-redact", "x".repeat(480) + " " + key); // key spans 481..519
      const got = takeConcernDetail("t-redact")!;
      expect(got).not.toMatch(/AIza|bbbbb/);
      expect(got.length).toBeLessThanOrEqual(500);

      noteConcernDetail("t-redact2", `fallo con ${key} al publicar`);
      const short = takeConcernDetail("t-redact2")!;
      expect(short).toContain("[REDACTED");
      expect(short).not.toContain(key);
    });

    it("is bounded: the oldest untaken note is evicted", () => {
      noteConcernDetail("t-oldest", "first");
      for (let i = 0; i < 256; i++) noteConcernDetail(`t-fill-${i}`, "x");
      expect(takeConcernDetail("t-oldest")).toBeNull();
      expect(takeConcernDetail("t-fill-255")).toBe("x");
      for (let i = 0; i < 256; i++) takeConcernDetail(`t-fill-${i}`);
    });
  });

  describe("queryOutcomes", () => {
    it("should query with no filters", () => {
      const allFn = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: allFn });

      queryOutcomes();

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM task_outcomes"),
      );
      expect(allFn).toHaveBeenCalledWith(50);
    });

    it("should filter by runner type", () => {
      const allFn = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: allFn });

      queryOutcomes({ ran_on: "fast", limit: 10 });

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("ran_on = ?"),
      );
      expect(allFn).toHaveBeenCalledWith("fast", 10);
    });
  });

  describe("updateFeedback", () => {
    it("should update feedback_signal for task", () => {
      const runFn = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runFn });

      updateFeedback("task-1", "positive");

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE task_outcomes SET feedback_signal"),
      );
      expect(runFn).toHaveBeenCalledWith("positive", "task-1");
    });
  });

  // Real SQL on a real in-memory schema: the mocked prepare delegates to it.
  describe("findLatestOutcomeTaskForThread", () => {
    type RealIndex = typeof import("./index.js");
    let real: RealIndex;

    beforeEach(async () => {
      real = await vi.importActual<RealIndex>("./index.js");
      real.initDatabase(":memory:");
      const db = real.getDatabase();
      mockDb.prepare.mockImplementation((sql: string) => db.prepare(sql));
    });
    afterEach(() => {
      real.closeDatabase();
    });

    function seed(
      taskId: string,
      threadId: string | null,
      success: 0 | 1,
      ageHours = 0,
    ): void {
      const db = real.getDatabase();
      db.prepare(
        `INSERT INTO tasks (task_id, title, description, metadata) VALUES (?, 't', 'd', ?)`,
      ).run(taskId, threadId ? JSON.stringify({ threadId }) : null);
      db.prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, success, created_at)
         VALUES (?, 'fast', 'fast', ?, datetime('now', '-' || ? || ' hours'))`,
      ).run(taskId, success, ageHours);
    }

    it("returns the newest outcome in the thread", () => {
      seed("t-old", "thread-a", 1, 2);
      seed("t-new", "thread-a", 1, 2);
      expect(findLatestOutcomeTaskForThread("thread-a")).toBe("t-new");
    });

    it("ignores outcomes of another thread", () => {
      seed("t-a", "thread-a", 1, 1);
      seed("t-b", "thread-b", 1, 0);
      expect(findLatestOutcomeTaskForThread("thread-a")).toBe("t-a");
      expect(findLatestOutcomeTaskForThread("thread-c")).toBeNull();
    });

    it("returns null when the newest outcome is older than 12 h", () => {
      seed("t-stale", "thread-a", 1, 13);
      expect(findLatestOutcomeTaskForThread("thread-a")).toBeNull();
      seed("t-fresh", "thread-a", 1, 11);
      expect(findLatestOutcomeTaskForThread("thread-a")).toBe("t-fresh");
    });

    it("returns null when the newest outcome failed (never skips back)", () => {
      seed("t-good", "thread-a", 1, 1);
      seed("t-failed", "thread-a", 0, 0);
      expect(findLatestOutcomeTaskForThread("thread-a")).toBeNull();
    });

    it("returns null for tasks with no threadId", () => {
      seed("t-none", null, 1, 0);
      expect(findLatestOutcomeTaskForThread("thread-a")).toBeNull();
    });
  });

  // Real SQL on a real in-memory schema for the writers and for the aggregates
  // the classifier and the evolution data read: the mocked prepare delegates
  // to it, so a wrong column, filter or group fails here. Row ages come from
  // the database clock on both sides of each window.
  describe("on the real schema", () => {
    type RealIndex = typeof import("./index.js");
    let real: RealIndex;

    beforeEach(async () => {
      real = await vi.importActual<RealIndex>("./index.js");
      real.initDatabase(":memory:");
      const db = real.getDatabase();
      mockDb.prepare.mockImplementation((sql: string) => db.prepare(sql));
    });
    afterEach(() => {
      real.closeDatabase();
    });

    function seed(
      taskId: string,
      ranOn: string,
      success: 0 | 1,
      ageHours: number,
      cols: {
        classifiedAs?: string;
        tools?: string[];
        durationMs?: number;
        feedback?: string;
        tier?: string;
      } = {},
    ): void {
      real
        .getDatabase()
        .prepare(
          `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, feedback_signal, model_tier, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-' || ? || ' hours'))`,
        )
        .run(
          taskId,
          cols.classifiedAs ?? ranOn,
          ranOn,
          JSON.stringify(cols.tools ?? []),
          cols.durationMs ?? 1000,
          success,
          cols.feedback ?? "none",
          cols.tier ?? null,
          ageHours,
        );
    }

    /** Three runner rows inside a 7-day window and one outside it. */
    function seedRunners(): void {
      seed("t1", "fast", 1, 1, {
        tools: ["web_search", "file_read"],
        durationMs: 1000,
      });
      seed("t2", "fast", 0, 2, { tools: ["web_search"], durationMs: 3000 });
      seed("t3", "heavy", 1, 3, { tools: ["web_search"], durationMs: 5000 });
      seed("t-old", "fast", 0, 240, { tools: ["web_search"] });
    }

    const ids = (rows: Array<{ task_id: string }>) => rows.map((r) => r.task_id);

    it("recordOutcome writes every bound column into a row queryOutcomes reads back", () => {
      recordOutcome({
        task_id: "t-rec",
        classified_as: "heavy",
        ran_on: "fast",
        tools_used: ["web_search"],
        duration_ms: 2500,
        success: false,
        tags: ["messaging"],
        model_tier: "sonnet",
        concern_reason: "other",
        concern_detail: "no source for today",
      });
      const rows = queryOutcomes();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        task_id: "t-rec",
        classified_as: "heavy",
        ran_on: "fast",
        tools_used: '["web_search"]',
        duration_ms: 2500,
        success: 0,
        feedback_signal: "none",
        tags: '["messaging"]',
        model_tier: "sonnet",
        concern_reason: "other",
        concern_detail: "no source for today",
      });
    });

    it("queryOutcomes filters by runner, success and age, newest first, up to the limit", () => {
      seedRunners();
      expect(ids(queryOutcomes({ ran_on: "fast", days: 7 }))).toEqual([
        "t1",
        "t2",
      ]);
      expect(ids(queryOutcomes({ success: true, days: 7 }))).toEqual([
        "t1",
        "t3",
      ]);
      expect(ids(queryOutcomes({ limit: 2 }))).toEqual(["t1", "t2"]);
      expect(ids(queryOutcomes())).toEqual(["t1", "t2", "t3", "t-old"]);
    });

    it("updateFeedback sets the signal on that task's outcome only", () => {
      seed("t-a", "fast", 1, 1);
      seed("t-b", "fast", 1, 2);
      updateFeedback("t-a", "negative");
      const rows = real
        .getDatabase()
        .prepare(
          "SELECT task_id, feedback_signal FROM task_outcomes ORDER BY task_id",
        )
        .all();
      expect(rows).toEqual([
        { task_id: "t-a", feedback_signal: "negative" },
        { task_id: "t-b", feedback_signal: "none" },
      ]);
    });

    it("aggregateToolEffectiveness counts each tool per classification inside the window", () => {
      seedRunners();
      const rows = aggregateToolEffectiveness(7);
      expect(rows[0]).toEqual({
        tool: "web_search",
        classified_as: "fast",
        total_uses: 2,
        success_count: 1,
        success_rate: 50,
      });
      expect(rows).toHaveLength(3);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            tool: "file_read",
            classified_as: "fast",
            total_uses: 1,
            success_count: 1,
            success_rate: 100,
          },
          {
            tool: "web_search",
            classified_as: "heavy",
            total_uses: 1,
            success_count: 1,
            success_rate: 100,
          },
        ]),
      );
    });

    it("aggregateRunnerPerformance summarises each runner inside the window", () => {
      seedRunners();
      expect(aggregateRunnerPerformance(7)).toEqual([
        {
          ran_on: "heavy",
          total: 1,
          successes: 1,
          avg_duration_ms: 5000,
          success_rate: 100,
        },
        {
          ran_on: "fast",
          total: 2,
          successes: 1,
          avg_duration_ms: 2000,
          success_rate: 50,
        },
      ]);
    });

    it("queryRunnerStats joins the ledger cost per task, 0 for a runner without cost rows", () => {
      seedRunners();
      const ledger = real
        .getDatabase()
        .prepare(
          "INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd) VALUES (?, ?, 'fast', ?)",
        );
      ledger.run("r1", "t1", 0.02);
      ledger.run("r2", "t2", 0.04);
      const rows = queryRunnerStats(7);
      expect(rows.map((r) => r.ran_on)).toEqual(["fast", "heavy"]);
      expect(rows[0]).toMatchObject({
        total: 2,
        successes: 1,
        avg_duration_ms: 2000,
        success_rate: 0.5,
      });
      expect(rows[0]!.avg_cost_usd).toBeCloseTo(0.03, 6);
      expect(rows[1]).toEqual({
        ran_on: "heavy",
        total: 1,
        successes: 1,
        avg_duration_ms: 5000,
        success_rate: 1,
        avg_cost_usd: 0,
      });
    });

    it("queryRunnerStats still reports the runners, at 0 cost, when the joined query fails", () => {
      seedRunners();
      // Without the ledger table the joined query fails and the plain one answers.
      real.getDatabase().exec("DROP TABLE cost_ledger");
      expect(queryRunnerStats(7)).toEqual([
        {
          ran_on: "fast",
          total: 2,
          successes: 1,
          avg_duration_ms: 2000,
          success_rate: 0.5,
          avg_cost_usd: 0,
        },
        {
          ran_on: "heavy",
          total: 1,
          successes: 1,
          avg_duration_ms: 5000,
          success_rate: 1,
          avg_cost_usd: 0,
        },
      ]);
    });

    it("queryOutcomesByKeywords matches task titles inside the window, newest first", () => {
      const task = real
        .getDatabase()
        .prepare(
          "INSERT INTO tasks (task_id, title, description) VALUES (?, ?, 'd')",
        );
      task.run("t1", "deploy the api");
      task.run("t2", "weekly report");
      task.run("t3", "unrelated chore");
      task.run("t-old", "deploy last year");
      seed("t1", "fast", 1, 1, { durationMs: 1200 });
      seed("t2", "heavy", 0, 2, { durationMs: 4000 });
      seed("t3", "fast", 1, 3);
      seed("t-old", "fast", 1, 240);
      expect(queryOutcomesByKeywords(["deploy", "report"], 7, 10)).toEqual([
        { task_id: "t1", ran_on: "fast", success: 1, duration_ms: 1200 },
        { task_id: "t2", ran_on: "heavy", success: 0, duration_ms: 4000 },
      ]);
      expect(ids(queryOutcomesByKeywords(["deploy", "report"], 7, 1))).toEqual(
        ["t1"],
      );
    });

    it("queryFeedbackQuality rates negative feedback per runner and tier, groups of 3 or more", () => {
      // fast/sonnet: 2 negative of 3 rated rows; an older one is outside the window.
      seed("q1", "fast", 1, 1, { tier: "sonnet", feedback: "negative" });
      seed("q2", "fast", 1, 2, { tier: "sonnet", feedback: "rephrase" });
      seed("q3", "fast", 1, 3, { tier: "sonnet", feedback: "positive" });
      seed("q-old", "fast", 1, 240, { tier: "sonnet", feedback: "negative" });
      // heavy without a tier: 1 negative of 3 rated rows; an unrated row is left out.
      seed("q4", "heavy", 1, 1, { feedback: "implicit_rephrase" });
      seed("q5", "heavy", 1, 2, { feedback: "positive" });
      seed("q6", "heavy", 1, 3, { feedback: "positive" });
      seed("q7", "heavy", 1, 4);
      // fast/haiku: only 2 rated rows, below the sparse-data floor.
      seed("q8", "fast", 0, 1, { tier: "haiku", feedback: "negative" });
      seed("q9", "fast", 0, 2, { tier: "haiku", feedback: "negative" });
      expect(queryFeedbackQuality(7)).toEqual([
        {
          ran_on: "fast",
          model_tier: "sonnet",
          total: 3,
          negative_count: 2,
          negative_rate: 0.667,
        },
        {
          ran_on: "heavy",
          model_tier: null,
          total: 3,
          negative_count: 1,
          negative_rate: 0.333,
        },
      ]);
    });
  });
});
