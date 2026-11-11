import { describe, it, expect, vi } from "vitest";
import client from "prom-client";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn((_expr: string, _fn: () => unknown) => ({
    stop: vi.fn(),
    on: vi.fn(),
  })),
  runTriageTick: vi.fn(),
}));

vi.mock("node-cron", () => ({ default: { schedule: mocks.schedule } }));
vi.mock("../../db/index.js", () => ({ getDatabase: () => ({}) }));
vi.mock("./analyze.js", () => ({ runTriageAnalysis: vi.fn() }));
vi.mock("./tick.js", () => ({ runTriageTick: mocks.runTriageTick }));

import { registerTriageCron, stopTriageCron } from "./triage-cron.js";

async function jobFailures(job: string): Promise<number> {
  const metric = client.register.getSingleMetric("mc_job_failures_total");
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.job === job)?.value ?? 0;
}

describe("registerTriageCron", () => {
  it("the tick throws → the job function resolves and mc_job_failures_total{job=self-healing-triage} goes up by one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runTriageTick.mockRejectedValueOnce(new Error("prometheus down"));
    registerTriageCron({ info: () => {}, warn: () => {} });
    const job = mocks.schedule.mock.calls[0][1] as () => Promise<void>;
    const before = await jobFailures("self-healing-triage");
    await expect(job()).resolves.toBeUndefined();
    expect(await jobFailures("self-healing-triage")).toBe(before + 1);
    stopTriageCron();
    vi.restoreAllMocks();
  });
});
