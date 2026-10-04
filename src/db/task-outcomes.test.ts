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
});
