/**
 * Hindsight cost pull on the real `cost_ledger`.
 *
 * hindsight-cost-pull.test.ts stubs `prepare().run`, so it cannot see that
 * rerun idempotency rests on the real partial unique index
 * `idx_cost_ledger_hindsight_run_id ON cost_ledger(run_id) WHERE
 * agent_type = 'hindsight'` and on INSERT OR IGNORE. These cases run the
 * module's INSERT on `initDatabase(":memory:")` and read the rows back.
 *
 * Prometheus is stubbed (no network); only `Date` is faked so the bucket is
 * fixed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { runHindsightCostPull } from "./hindsight-cost-pull.js";

const OK_LABELS = {
  model: "minimax-m2p7",
  scope: "verification",
  provider: "openai",
  success: "true",
  tenant: "public",
};
const FAILED_LABELS = { ...OK_LABELS, success: "false" };

// Input: both series; output: only the successful one.
function stubProm(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const input = url.includes("input");
      const series = input
        ? [
            { metric: OK_LABELS, value: [0, "12000"] },
            { metric: FAILED_LABELS, value: [0, "5000"] },
          ]
        : [{ metric: OK_LABELS, value: [0, "4000"] }];
      return {
        ok: true,
        json: async () => ({
          status: "success",
          data: { resultType: "vector", result: series },
        }),
      };
    }),
  );
}

interface LedgerRow {
  run_id: string;
  task_id: string;
  agent_type: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

function ledger(): LedgerRow[] {
  return getDatabase()
    .prepare(
      `SELECT run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd
       FROM cost_ledger ORDER BY prompt_tokens DESC, run_id`,
    )
    .all() as LedgerRow[];
}

beforeEach(() => {
  initDatabase(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  stubProm();
});

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runHindsightCostPull on the real cost_ledger", () => {
  it("writes one hindsight row per series with the computed tokens and cost", async () => {
    // 10:07:00 lagged by 30 s floors to the 10:05 bucket.
    vi.setSystemTime(new Date("2026-03-02T10:07:00.000Z"));

    const summary = await runHindsightCostPull();

    expect(summary).toMatchObject({
      bucket: "2026-03-02T10:05:00.000Z",
      series: 2,
      recorded: 2,
      skipped: 0,
    });
    // minimax-m2p7: $0.0003/1k in, $0.0012/1k out → 0.0084 + 0.0015.
    expect(summary.cost_usd).toBeCloseTo(0.0099, 4);

    const rows = ledger();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.agent_type).toBe("hindsight");
      expect(r.task_id).toBe(r.run_id);
      expect(r.model).toBe("minimax-m2p7");
      expect(r.run_id).toMatch(
        /^hindsight-verification-[0-9a-f]{8}-2026-03-02T10:05:00\.000Z$/,
      );
    }
    expect(rows[0]).toMatchObject({ prompt_tokens: 12000, completion_tokens: 4000 });
    expect(rows[0].cost_usd).toBeCloseTo(0.0084, 6);
    expect(rows[1]).toMatchObject({ prompt_tokens: 5000, completion_tokens: 0 });
    expect(rows[1].cost_usd).toBeCloseTo(0.0015, 6);
    // Success and failure series of the same model are distinct rows.
    expect(rows[0].run_id).not.toBe(rows[1].run_id);
  });

  it("a rerun in the same bucket is a no-op: the partial unique index makes INSERT OR IGNORE skip every row", async () => {
    vi.setSystemTime(new Date("2026-03-02T10:07:00.000Z"));
    await runHindsightCostPull();
    const before = ledger();

    // Still the 10:05 bucket after the 30 s lag.
    vi.setSystemTime(new Date("2026-03-02T10:09:59.000Z"));
    const rerun = await runHindsightCostPull();

    expect(rerun).toMatchObject({ series: 2, recorded: 0, skipped: 2, cost_usd: 0 });
    expect(ledger()).toEqual(before);
  });

  it("the next bucket adds a fresh row per series", async () => {
    vi.setSystemTime(new Date("2026-03-02T10:07:00.000Z"));
    await runHindsightCostPull();

    vi.setSystemTime(new Date("2026-03-02T10:12:00.000Z"));
    const next = await runHindsightCostPull();

    expect(next).toMatchObject({
      bucket: "2026-03-02T10:10:00.000Z",
      recorded: 2,
      skipped: 0,
    });
    const rows = ledger();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.run_id.endsWith("10:10:00.000Z"))).toHaveLength(2);
  });
});
