import { describe, it, expect, vi } from "vitest";
import { runTriageTick, type TriageTickDeps } from "./tick.js";
import type { Anomaly, TriageReport } from "./types.js";

const anomaly: Anomaly = {
  kind: "stuck_tasks",
  detail: "5 tasks stuck",
  metric: "tasks.status=running",
  observed: 5,
  threshold: 3,
  severity: "high",
};
const report: TriageReport = {
  severity: "high",
  rootCause: "a runner hung on a Docker pull",
  affectedComponents: ["dispatcher", "runners"],
  recommendedActions: ["inspect the running tasks", "restart the heavy runner"],
  confidence: "medium",
};

function deps(over: Partial<TriageTickDeps> = {}): TriageTickDeps {
  return {
    detect: async () => [anomaly],
    recentTriageExists: () => false,
    analyze: async () => ({ report, costUsd: 0.01, model: "haiku" }),
    persist: () => "report-1",
    ...over,
  };
}

describe("runTriageTick", () => {
  it("no anomalies → no analyze, no persist", async () => {
    const analyze = vi.fn();
    const persist = vi.fn();
    const r = await runTriageTick(
      deps({ detect: async () => [], analyze, persist }),
    );
    expect(r).toEqual({ triaged: false, anomalies: 0 });
    expect(analyze).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("throttles when an open report already exists (no analyze, no spend)", async () => {
    const analyze = vi.fn();
    const r = await runTriageTick(
      deps({ recentTriageExists: () => true, analyze }),
    );
    expect(r.throttled).toBe(true);
    expect(r.triaged).toBe(false);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the sub-agent returns no report (conservative)", async () => {
    const persist = vi.fn();
    const r = await runTriageTick(deps({ analyze: async () => null, persist }));
    expect(r.analysisFailed).toBe(true);
    expect(r.triaged).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("persists the diagnosis and reports on the happy path", async () => {
    const persist = vi.fn(() => "report-xyz");
    const r = await runTriageTick(deps({ persist }));
    expect(r.triaged).toBe(true);
    expect(r.reportId).toBe("report-xyz");
    expect(r.severity).toBe("high");
    expect(persist).toHaveBeenCalledOnce();
    // The tick's only effects are detect/throttle/analyze/persist — there is no
    // remediation dependency to call. The hard-stop is structural.
  });
});
