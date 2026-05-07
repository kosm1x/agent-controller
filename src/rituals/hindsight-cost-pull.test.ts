import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn().mockReturnValue(undefined),
  recordCost: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: () => ({
      get: mocks.exists,
    }),
  }),
}));

vi.mock("../budget/service.js", () => ({
  recordCost: mocks.recordCost,
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
    mocks.exists.mockReturnValue(undefined);
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
    expect(mocks.recordCost).toHaveBeenCalledOnce();
    const arg = mocks.recordCost.mock.calls[0][0];
    expect(arg.agentType).toBe("hindsight");
    expect(arg.model).toBe("accounts/fireworks/models/minimax-m2p7");
    expect(arg.promptTokens).toBe(12_000);
    expect(arg.completionTokens).toBe(4_000);
    expect(arg.runId).toMatch(/^hindsight-verification-[0-9a-f]{8}-/);
    // pricing.ts: minimax-m2p7 = $0.0003/1k in + $0.0012/1k out
    // 12k * 0.0003 + 4k * 0.0012 / 1k = 0.0036 + 0.0048 = 0.0084
    expect(summary.cost_usd).toBeCloseTo(0.0084, 4);
  });

  it("skips series whose run_id already exists (idempotent)", async () => {
    mocks.exists.mockReturnValue({ "1": 1 });
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
    expect(mocks.recordCost).not.toHaveBeenCalled();
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
    expect(mocks.recordCost).not.toHaveBeenCalled();
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
    expect(mocks.recordCost.mock.calls[0][0].promptTokens).toBe(5000);
    expect(mocks.recordCost.mock.calls[0][0].completionTokens).toBe(0);
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
