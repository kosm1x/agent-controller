import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import client from "prom-client";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  stop: vi.fn(),
  runSycophancyProbe: vi.fn(),
  checkSycophancyDrift: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: { schedule: mocks.schedule },
}));
vi.mock("../../rituals/config.js", () => ({
  RITUALS_TIMEZONE: "America/Mexico_City",
}));
vi.mock("./sycophancy.js", () => ({
  runSycophancyProbe: mocks.runSycophancyProbe,
  checkSycophancyDrift: mocks.checkSycophancyDrift,
}));

import {
  registerSycophancyProbeCron,
  stopSycophancyProbeCron,
} from "./probe-cron.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.schedule.mockReturnValue({ stop: mocks.stop, on: vi.fn() });
  stopSycophancyProbeCron();
  mocks.stop.mockClear();
});

let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
});

describe("registerSycophancyProbeCron", () => {
  it("schedules at 02:30 in the rituals timezone", () => {
    const ok = registerSycophancyProbeCron();
    expect(ok).toBe(true);
    expect(mocks.schedule).toHaveBeenCalledWith(
      "30 2 * * *",
      expect.any(Function),
      expect.objectContaining({
        timezone: "America/Mexico_City",
        missedExecutionTolerance: 60_000,
      }),
    );
  });

  it("is idempotent — re-registering stops the prior job first", () => {
    registerSycophancyProbeCron();
    registerSycophancyProbeCron();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("the tick runs the probe then the drift check, swallowing errors", async () => {
    mocks.runSycophancyProbe.mockResolvedValue([]);
    mocks.checkSycophancyDrift.mockReturnValue({
      total: 0,
      conceded: 0,
      rate: 0,
      threshold: 0.05,
      drift: false,
      blockerOpened: false,
    });
    registerSycophancyProbeCron();
    const tick = mocks.schedule.mock.calls[0][1] as () => void;
    tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.runSycophancyProbe).toHaveBeenCalledTimes(1);
    expect(mocks.checkSycophancyDrift).toHaveBeenCalledTimes(1);
  });

  it("the probe throws → the tick resolves and mc_job_failures_total{job=sycophancy-probe} goes up by one", async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runSycophancyProbe.mockRejectedValueOnce(new Error("model down"));
    registerSycophancyProbeCron();
    const tick = mocks.schedule.mock.calls[0][1] as () => Promise<void>;
    const before = await jobFailures("sycophancy-probe");
    await expect(tick()).resolves.toBeUndefined();
    expect(mocks.checkSycophancyDrift).not.toHaveBeenCalled();
    expect(await jobFailures("sycophancy-probe")).toBe(before + 1);
  });
});

async function jobFailures(job: string): Promise<number> {
  const metric = client.register.getSingleMetric("mc_job_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.job === job)?.value ?? 0;
}
