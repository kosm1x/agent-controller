import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  emitEvent: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: { schedule: mocks.schedule },
}));
vi.mock("./event-bus.js", () => ({
  getEventBus: () => ({ emitEvent: mocks.emitEvent }),
}));

import { scheduleCron, MISSED_EXECUTION_TOLERANCE_MS } from "./cron.js";

type MissedHandler = (ctx: { dateLocalIso: string }) => void;

function makeTask() {
  return { on: vi.fn(), stop: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleCron", () => {
  it("schedules with the 60s missed-execution tolerance and the id as name", () => {
    mocks.schedule.mockReturnValue(makeTask());
    const fn = vi.fn();
    scheduleCron("my-job", "0 6 * * *", fn, {
      timezone: "America/Mexico_City",
    });
    expect(mocks.schedule).toHaveBeenCalledWith("0 6 * * *", fn, {
      name: "my-job",
      missedExecutionTolerance: MISSED_EXECUTION_TOLERANCE_MS,
      timezone: "America/Mexico_City",
    });
    expect(MISSED_EXECUTION_TOLERANCE_MS).toBe(60_000);
  });

  it("lets caller options override the tolerance default", () => {
    mocks.schedule.mockReturnValue(makeTask());
    scheduleCron("custom", "* * * * *", vi.fn(), {
      missedExecutionTolerance: 5_000,
    });
    expect(mocks.schedule).toHaveBeenCalledWith(
      "* * * * *",
      expect.any(Function),
      expect.objectContaining({ missedExecutionTolerance: 5_000 }),
    );
  });

  it("records a missed execution on the event bus with phase 'missed'", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    scheduleCron("morning-surface", "0 6 * * *", vi.fn());

    expect(task.on).toHaveBeenCalledWith(
      "execution:missed",
      expect.any(Function),
    );
    const handler = task.on.mock.calls[0][1] as MissedHandler;
    handler({ dateLocalIso: "2026-07-14T06:00:00" });

    expect(mocks.emitEvent).toHaveBeenCalledWith("schedule.run_failed", {
      ritual_id: "morning-surface",
      error: expect.stringContaining("missed execution"),
      phase: "missed",
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("swallows an event-bus throw (missed-record is best-effort)", () => {
    const task = makeTask();
    mocks.schedule.mockReturnValue(task);
    mocks.emitEvent.mockImplementation(() => {
      throw new Error("bus not initialized");
    });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    scheduleCron("j", "* * * * *", vi.fn());
    const handler = task.on.mock.calls[0][1] as MissedHandler;
    expect(() => handler({ dateLocalIso: "x" })).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("event bus unavailable"),
    );
    errSpy.mockRestore();
  });
});
