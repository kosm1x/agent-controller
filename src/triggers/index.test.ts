import { describe, it, expect, vi } from "vitest";
import client from "prom-client";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn((_expr: string, _fn: () => unknown, _opts: { name: string }) => ({
    stop: vi.fn(),
    on: vi.fn(),
  })),
  runIdleDetectCheck: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: { schedule: mocks.schedule, validate: () => true },
}));
vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({ subscribe: vi.fn(), emitEvent: vi.fn() }),
}));
vi.mock("./n-turn.js", () => ({ handleTaskCompleted: vi.fn() }));
vi.mock("./morning-surface.js", () => ({ runMorningSurface: vi.fn() }));
vi.mock("./idle-detect.js", () => ({
  runIdleDetectCheck: mocks.runIdleDetectCheck,
}));

import { startTriggers, stopTriggers } from "./index.js";

async function jobFailures(job: string): Promise<number> {
  const metric = client.register.getSingleMetric("mc_job_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.job === job)?.value ?? 0;
}

describe("startTriggers", () => {
  it("the idle check rejects → the job function resolves and mc_job_failures_total{job=idle-detect} goes up by one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runIdleDetectCheck.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    startTriggers();
    const call = mocks.schedule.mock.calls.find((c) => c[2].name === "idle-detect");
    const before = await jobFailures("idle-detect");
    await expect(Promise.resolve(call![1]())).resolves.toBeUndefined();
    expect(await jobFailures("idle-detect")).toBe(before + 1);
    stopTriggers();
    vi.restoreAllMocks();
  });
});
