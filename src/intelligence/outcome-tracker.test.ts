/**
 * Outcome tracker tests — mock DB and memory to verify tracking logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/task-outcomes.js", () => ({
  recordOutcome: vi.fn(),
  updateFeedback: vi.fn(),
}));

vi.mock("../dispatch/dispatcher.js", () => ({
  getTask: vi.fn().mockReturnValue({
    task_id: "task-1",
    title: "Chat: test message",
    agent_type: "fast",
    classification: JSON.stringify({
      agentType: "fast",
      score: 0,
      reason: "messaging",
    }),
    output: null,
    metadata: JSON.stringify({ tags: ["messaging", "telegram"] }),
  }),
}));

vi.mock("../memory/index.js", () => ({
  getMemoryService: () => ({
    backend: "sqlite",
    retain: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { recordOutcome, updateFeedback } from "../db/task-outcomes.js";
import {
  trackTaskOutcome,
  checkFeedbackWindow,
  recordTaskFeedback,
  clearAllFeedbackWindows,
} from "./outcome-tracker.js";

describe("outcome-tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearAllFeedbackWindows();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllFeedbackWindows();
  });

  describe("trackTaskOutcome", () => {
    it("should record outcome to SQLite", () => {
      trackTaskOutcome("task-1", 2500, true, "telegram");

      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: "task-1",
          classified_as: "fast",
          ran_on: "fast",
          duration_ms: 2500,
          success: true,
        }),
      );
    });

    it("should start a feedback window", () => {
      trackTaskOutcome("task-1", 2500, true, "telegram");

      // Window should be active
      const feedbackTaskId = checkFeedbackWindow("telegram");
      expect(feedbackTaskId).toBe("task-1");
    });
  });

  describe("feedback window", () => {
    it("should return null when no window is active", () => {
      expect(checkFeedbackWindow("telegram")).toBeNull();
    });

    it("should expire after 2 minutes", () => {
      trackTaskOutcome("task-1", 2500, true, "telegram");

      vi.advanceTimersByTime(120_001);

      expect(checkFeedbackWindow("telegram")).toBeNull();
    });

    it("should close window on check", () => {
      trackTaskOutcome("task-1", 2500, true, "telegram");

      // First check returns the task
      expect(checkFeedbackWindow("telegram")).toBe("task-1");
      // Second check returns null (window closed)
      expect(checkFeedbackWindow("telegram")).toBeNull();
    });
  });

  describe("recordTaskFeedback", () => {
    it("should update feedback in SQLite", () => {
      recordTaskFeedback("task-1", "positive");

      expect(updateFeedback).toHaveBeenCalledWith("task-1", "positive");
    });
  });
});
