/**
 * Task outcomes CRUD tests.
 */

import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";

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
} from "./task-outcomes.js";

describe("task-outcomes", () => {
  afterEach(() => { vi.restoreAllMocks(); });
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
      );
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
