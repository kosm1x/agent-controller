/**
 * Atomic task checkout tests.
 */

import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";

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

import { checkoutTask, releaseCheckout } from "./checkout.js";

describe("checkout", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue({
      run: mockRun,
      get: mockGet,
    });
  });

  describe("checkoutTask", () => {
    it("should succeed when task is queued", () => {
      mockRun.mockReturnValue({ changes: 1 });

      const result = checkoutTask("task-1", "runner:fast:run-1");

      expect(result).toEqual({ success: true, taskId: "task-1" });
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("AND status = 'queued'"),
      );
      expect(mockRun).toHaveBeenCalledWith("runner:fast:run-1", "task-1");
    });

    it("should fail with already_claimed when task is not queued", () => {
      mockRun.mockReturnValue({ changes: 0 });
      mockGet.mockReturnValue({ status: "running" });

      const result = checkoutTask("task-1", "runner:fast:run-2");

      expect(result).toEqual({
        success: false,
        taskId: "task-1",
        reason: "already_claimed",
      });
    });

    it("should fail with not_found when task does not exist", () => {
      mockRun.mockReturnValue({ changes: 0 });
      mockGet.mockReturnValue(undefined);

      const result = checkoutTask("nonexistent", "runner:fast:run-1");

      expect(result).toEqual({
        success: false,
        taskId: "nonexistent",
        reason: "not_found",
      });
    });

    it("should prevent double checkout", () => {
      // First checkout succeeds
      mockRun.mockReturnValueOnce({ changes: 1 });
      const first = checkoutTask("task-1", "runner:fast:run-1");
      expect(first.success).toBe(true);

      // Second checkout fails (task no longer queued)
      mockRun.mockReturnValueOnce({ changes: 0 });
      mockGet.mockReturnValue({ status: "running" });
      const second = checkoutTask("task-1", "runner:nanoclaw:run-2");
      expect(second.success).toBe(false);
      expect(second.reason).toBe("already_claimed");
    });
  });

  describe("releaseCheckout", () => {
    it("should release when claimedBy matches", () => {
      mockRun.mockReturnValue({ changes: 1 });

      const released = releaseCheckout("task-1", "runner:fast:run-1");

      expect(released).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("AND assigned_to = ?"),
      );
      expect(mockRun).toHaveBeenCalledWith("task-1", "runner:fast:run-1");
    });

    it("should fail when claimedBy does not match", () => {
      mockRun.mockReturnValue({ changes: 0 });

      const released = releaseCheckout("task-1", "wrong-claimer");

      expect(released).toBe(false);
    });

    it("should fail when task is not running", () => {
      mockRun.mockReturnValue({ changes: 0 });

      const released = releaseCheckout("task-1", "runner:fast:run-1");

      expect(released).toBe(false);
    });
  });
});
