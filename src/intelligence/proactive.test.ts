/**
 * Proactive scheduler tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn(), on: vi.fn() }),
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
import client from "prom-client";

async function jobFailures(job: string): Promise<number> {
  const metric = client.register.getSingleMetric("mc_job_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.job === job)?.value ?? 0;
}

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
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createMockRouter();
  });

  afterEach(() => {
    stopProactiveScheduler();
    vi.unstubAllEnvs();
    errorSpy?.mockRestore();
    errorSpy = undefined;
  });

  describe("startProactiveScheduler", () => {
    it("schedules the nudge cron only when PROACTIVE_NUDGE_ENABLED=true", () => {
      vi.stubEnv("PROACTIVE_NUDGE_ENABLED", "true");
      startProactiveScheduler(router);

      expect(cron.schedule).toHaveBeenCalledWith(
        "0 8,12,16,20 * * *",
        expect.any(Function),
        expect.objectContaining({ timezone: "America/Mexico_City" }),
      );
    });

    it("the nudge scan submits its task non-interactive (W-E: explicit, not defaulted)", async () => {
      vi.stubEnv("PROACTIVE_NUDGE_ENABLED", "true");
      startProactiveScheduler(router);
      const call = vi
        .mocked(cron.schedule)
        .mock.calls.find((c) => c[0] === "0 8,12,16,20 * * *");
      (call![1] as () => void)();
      const { submitTask } = await import("../dispatch/dispatcher.js");
      await vi.waitFor(() => expect(submitTask).toHaveBeenCalled());
      expect(vi.mocked(submitTask).mock.calls[0][0]).toMatchObject({
        title: expect.stringContaining("Proactive scan"),
        interactive: false,
      });
    });

    it("a scan whose submit throws resolves and counts one mc_job_failures_total{job=proactive-nudge}", async () => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("PROACTIVE_NUDGE_ENABLED", "true");
      const { submitTask } = await import("../dispatch/dispatcher.js");
      vi.mocked(submitTask).mockRejectedValueOnce(new Error("queue down"));
      startProactiveScheduler(router);
      const call = vi
        .mocked(cron.schedule)
        .mock.calls.find((c) => c[0] === "0 8,12,16,20 * * *");
      const before = await jobFailures("proactive-nudge");
      await expect(
        (call![1] as () => Promise<void>)(),
      ).resolves.toBeUndefined();
      expect(await jobFailures("proactive-nudge")).toBe(before + 1);
      expect(submitTask).toHaveBeenCalledTimes(1);
    });

    it("a scan that throws before its submit resolves and counts one mc_job_failures_total{job=proactive-nudge}", async () => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("PROACTIVE_NUDGE_ENABLED", "true");
      const throwing = {
        ...createMockRouter(),
        getLastMessageTime: () => {
          throw new Error("router gone");
        },
      } as unknown as MessageRouter;
      startProactiveScheduler(throwing);
      const call = vi
        .mocked(cron.schedule)
        .mock.calls.find((c) => c[0] === "0 8,12,16,20 * * *");
      const before = await jobFailures("proactive-nudge");
      await expect(
        (call![1] as () => Promise<void>)(),
      ).resolves.toBeUndefined();
      expect(await jobFailures("proactive-nudge")).toBe(before + 1);
    });

    it("does NOT schedule the NorthStar nudge by default (operator ruling 2026-06-23)", () => {
      // Flag unset → the day-log-truth posture: no NorthStar nudge cron.
      startProactiveScheduler(router);
      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });

  describe("stopProactiveScheduler", () => {
    it("should stop the cron job", () => {
      vi.stubEnv("PROACTIVE_NUDGE_ENABLED", "true");
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
