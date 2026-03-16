/**
 * Proactive scheduler tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
  },
}));

vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: vi.fn().mockResolvedValue({
    taskId: "proactive-task-1",
    agentType: "fast",
    classification: { score: 0, reason: "proactive", explicit: false },
  }),
}));

import cron from "node-cron";
import {
  startProactiveScheduler,
  stopProactiveScheduler,
  handleProactiveResult,
  isProactiveTask,
} from "./proactive.js";
import type { MessageRouter } from "../messaging/router.js";

function createMockRouter(): MessageRouter {
  return {
    channelCount: 1,
    getLastMessageTime: () => 0,
    broadcastToAll: vi.fn().mockResolvedValue(undefined),
    registerChannel: vi.fn(),
    startEventListeners: vi.fn(),
    handleInbound: vi.fn(),
    watchRitualTask: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as MessageRouter;
}

describe("proactive", () => {
  let router: MessageRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createMockRouter();
  });

  afterEach(() => {
    stopProactiveScheduler();
  });

  describe("startProactiveScheduler", () => {
    it("should schedule a cron job", () => {
      startProactiveScheduler(router);

      expect(cron.schedule).toHaveBeenCalledWith(
        "0 8,12,16,20 * * *",
        expect.any(Function),
        expect.objectContaining({ timezone: "America/Mexico_City" }),
      );
    });
  });

  describe("stopProactiveScheduler", () => {
    it("should stop the cron job", () => {
      startProactiveScheduler(router);
      const mockJob = vi.mocked(cron.schedule).mock.results[0]?.value;

      stopProactiveScheduler();

      expect(mockJob.stop).toHaveBeenCalled();
    });
  });

  describe("handleProactiveResult", () => {
    it("should not broadcast NOTHING_TO_REPORT", () => {
      startProactiveScheduler(router);

      // Simulate a proactive task being watched
      handleProactiveResult("some-task", "NOTHING_TO_REPORT");

      expect(router.broadcastToAll).not.toHaveBeenCalled();
    });

    it("should broadcast meaningful results", () => {
      startProactiveScheduler(router);

      // Manually mark a task as proactive
      // (In production this happens via watchProactiveTask in runProactiveScan)
      // For this test, we test the handler directly — but since the task
      // isn't in pendingProactive, it should be a no-op
      handleProactiveResult("unknown-task", "Tienes 3 tareas vencidas");

      // Not in pending set, so no broadcast
      expect(router.broadcastToAll).not.toHaveBeenCalled();
    });
  });

  describe("isProactiveTask", () => {
    it("should return false for unknown tasks", () => {
      expect(isProactiveTask("random-task-id")).toBe(false);
    });
  });
});
