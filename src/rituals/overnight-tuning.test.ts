import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression (2026-06-20): the ritual used to submitTask a "deliver this report
// via Telegram" instruction to a fast-runner agent, which — lacking a
// telegram_send tool — lifted the bot token out of .env and shelled out a raw
// send (17 turns, ~$1, secret in logs). It now broadcasts the (already rendered)
// report directly via router.broadcastToAll, like every other ritual.

const mockAll = vi.hoisted(() => ({
  broadcastToAll: vi.fn().mockResolvedValue(undefined),
  router: {
    value: null as null | { broadcastToAll: ReturnType<typeof vi.fn> },
  },
  runResult: {
    value: {
      report: "Baseline: 66.3 → Best: 66.3 (+0.0)\nExperiments: 5 run",
      experiments_won: 0,
      baseline_score: 66.3,
      best_score: 66.3,
    } as Record<string, unknown>,
  },
  submitTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    tuningEnabled: true,
    tuningMaxExperiments: 5,
    tuningMaxCostUsd: 5,
  }),
}));
vi.mock("../tuning/test-cases.js", () => ({ seedTestCases: vi.fn() }));
vi.mock("../tuning/schema.js", () => ({ countTestCases: () => 1 }));
vi.mock("../tuning/case-miner.js", () => ({ mineTestCases: vi.fn() }));
vi.mock("../intel/baselines.js", () => ({ computeAllBaselines: vi.fn() }));
vi.mock("../tuning/overnight-loop.js", () => ({
  runOvernightTuning: () => Promise.resolve(mockAll.runResult.value),
}));
vi.mock("../messaging/index.js", () => ({
  getRouter: () => mockAll.router.value,
}));
// Must NOT be used anymore — mocked so an accidental re-introduction is caught.
vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: mockAll.submitTask,
}));

import { executeOvernightTuning } from "./overnight-tuning.js";

describe("overnight-tuning delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll.router.value = { broadcastToAll: mockAll.broadcastToAll };
    mockAll.runResult.value = {
      report: "Baseline: 66.3 → Best: 66.3 (+0.0)\nExperiments: 5 run",
      experiments_won: 0,
      baseline_score: 66.3,
      best_score: 66.3,
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it("broadcasts the rendered report directly (no LLM delivery task)", async () => {
    await executeOvernightTuning();
    expect(mockAll.broadcastToAll).toHaveBeenCalledOnce();
    const msg = mockAll.broadcastToAll.mock.calls[0][0] as string;
    expect(msg).toContain("Overnight Tuning");
    expect(msg).toContain("Baseline: 66.3 → Best: 66.3");
    // The old shell-out delivery path must never come back.
    expect(mockAll.submitTask).not.toHaveBeenCalled();
  });

  it("does not throw when no messaging router is available", async () => {
    mockAll.router.value = null;
    await expect(executeOvernightTuning()).resolves.toBeUndefined();
    expect(mockAll.broadcastToAll).not.toHaveBeenCalled();
  });

  it("skips delivery when the run produced no report", async () => {
    mockAll.runResult.value = { report: "", experiments_won: 0 };
    await executeOvernightTuning();
    expect(mockAll.broadcastToAll).not.toHaveBeenCalled();
  });
});
