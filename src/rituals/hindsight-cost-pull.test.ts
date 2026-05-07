import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock SQLite via the prepared-statement.run() return shape that
// hindsight-cost-pull now relies on for INSERT OR IGNORE dedup
// (`result.changes === 0` => skipped).
const mocks = vi.hoisted(() => ({
  insertRun: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: () => ({
      run: mocks.insertRun,
    }),
  }),
}));

import { runHindsightCostPull } from "./hindsight-cost-pull.js";

function promResp(
  series: Array<{ labels: Record<string, string>; value: number }>,
) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: series.map((s) => ({
        metric: s.labels,
        value: [Date.now() / 1000, String(s.value)],
      })),
    },
  };
}

describe("hindsight-cost-pull", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertRun.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records one cost_ledger row per (scope, model, success) series", async () => {
    const labels = {
      model: "accounts/fireworks/models/minimax-m2p7",
      scope: "verification",
      provider: "openai",
      success: "true",
      tenant: "public",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const tokens = url.includes("input") ? 12_000 : 4_000;
        return {
          ok: true,
          json: async () => promResp([{ labels, value: tokens }]),
        };
      }),
    );

    const summary = await runHindsightCostPull();

    expect(summary.series).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(mocks.insertRun).toHaveBeenCalledOnce();
    const args = mocks.insertRun.mock.calls[0];
    // INSERT OR IGNORE binds: run_id, task_id, agent_type, model, prompt, completion, cost
    const [runId, taskId, agentType, model, prompt, completion] = args;
    expect(runId).toMatch(/^hindsight-verification-[0-9a-f]{8}-/);
    expect(taskId).toBe(runId);
    expect(agentType).toBe("hindsight");
    expect(model).toBe("accounts/fireworks/models/minimax-m2p7");
    expect(prompt).toBe(12_000);
    expect(completion).toBe(4_000);
    // pricing.ts: minimax-m2p7 = $0.0003/1k in + $0.0012/1k out
    // 12k * 0.0003 + 4k * 0.0012 / 1k = 0.0036 + 0.0048 = 0.0084
    expect(summary.cost_usd).toBeCloseTo(0.0084, 4);
  });

  it("skips series whose run_id already exists (INSERT OR IGNORE returns changes=0)", async () => {
    mocks.insertRun.mockReturnValue({ changes: 0, lastInsertRowid: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          promResp([
            {
              labels: {
                model: "m1",
                scope: "verification",
                provider: "openai",
                success: "true",
                tenant: "public",
              },
              value: 1000,
            },
          ]),
      }),
    );

    const summary = await runHindsightCostPull();

    expect(summary.recorded).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.cost_usd).toBe(0);
  });

  it("ignores zero-token series", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          promResp([
            {
              labels: { model: "m1", scope: "v", success: "true" },
              value: 0,
            },
          ]),
      }),
    );

    const summary = await runHindsightCostPull();
    expect(summary.series).toBe(0);
    expect(mocks.insertRun).not.toHaveBeenCalled();
  });

  it("treats success=false series as billable cost", async () => {
    const labels = {
      model: "minimax-m2p7",
      scope: "verification",
      provider: "openai",
      success: "false",
      tenant: "public",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        json: async () =>
          promResp([{ labels, value: url.includes("input") ? 5000 : 0 }]),
      })),
    );

    const summary = await runHindsightCostPull();
    expect(summary.recorded).toBe(1);
    const [, , , , prompt, completion] = mocks.insertRun.mock.calls[0];
    expect(prompt).toBe(5000);
    expect(completion).toBe(0);
  });

  it("throws when Prometheus returns error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "error", error: "bad query" }),
      }),
    );

    await expect(runHindsightCostPull()).rejects.toThrow(
      /Prometheus query error/,
    );
  });

  it("throws on non-200 HTTP from Prometheus", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );
    await expect(runHindsightCostPull()).rejects.toThrow(/Prometheus HTTP 503/);
  });
});
