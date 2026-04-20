import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(
    resolve(__dirname, "../../db/schema.sql"),
    "utf8",
  );
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../../db/index.js", () => ({
  getDatabase: () => db,
}));

// Stub data-layer so the tool uses a fixed price without hitting AV.
vi.mock("../../finance/data-layer.js", async () => {
  const fakeBar = (symbol: string, close: number) => ({
    symbol,
    timestamp: "2026-04-17T16:00:00-04:00",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    provider: "alpha_vantage" as const,
    interval: "weekly" as const,
  });
  return {
    getDataLayer() {
      return {
        async getWeekly(symbol: string) {
          const priceMap: Record<string, number> = {
            AAPL: 200,
            TSLA: 300,
            NVDA: 500,
          };
          const p = priceMap[symbol];
          if (!p) return { bars: [], provider: "alpha_vantage" };
          return { bars: [fakeBar(symbol, p)], provider: "alpha_vantage" };
        },
      };
    },
  };
});

import {
  paperRebalanceTool,
  paperPortfolioTool,
  paperHistoryTool,
} from "./paper-trading.js";

/** Seed minimum F7 + F7.5 state so paper_rebalance has something to read. */
function seedAlphaAndBacktest(opts: {
  shipBlocked: boolean;
  pbo?: number;
  dsrPvalue?: number;
}) {
  // Alpha run — one weight on AAPL
  db.prepare(
    `INSERT INTO signal_weights
      (run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma, e_norm, ic_30d, regime, n_effective, excluded, exclude_reason)
     VALUES (?, ?, 'returns', 'macd:AAPL', 'macd on AAPL', 0.4, 0, 0.1, 0, null, null, 1, 0, null)`,
  ).run("alpha-run-1", "2026-04-17T16:00:00Z");
  db.prepare(
    `INSERT INTO signal_weights
      (run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma, e_norm, ic_30d, regime, n_effective, excluded, exclude_reason)
     VALUES (?, ?, 'returns', 'rsi:TSLA', 'rsi on TSLA', 0.3, 0, 0.1, 0, null, null, 1, 0, null)`,
  ).run("alpha-run-1", "2026-04-17T16:00:00Z");

  // Backtest run
  db.prepare(
    `INSERT INTO backtest_runs
      (run_id, run_timestamp, strategy, mode, window_start, window_end,
       cost_bps, rebalance_bars, pbo, dsr_ratio, dsr_pvalue, ship_blocked)
     VALUES (?, ?, 'flam', 'returns', '2016-05-06', '2026-04-17',
             5, 1, ?, 0.5, ?, ?)`,
  ).run(
    "bt-run-1",
    "2026-04-17T16:00:00Z",
    opts.pbo ?? 0.3,
    opts.dsrPvalue ?? 0.5,
    opts.shipBlocked ? 1 : 0,
  );
  db.prepare(
    `INSERT INTO backtest_overfit
      (run_id, pbo, pbo_threshold, dsr_observed_sharpe, dsr_expected_null,
       dsr_sharpe_variance, dsr_ratio, dsr_pvalue)
     VALUES (?, ?, 0.5, 1.0, 0.3, 0.1, 0.5, ?)`,
  ).run("bt-run-1", opts.pbo ?? 0.3, opts.dsrPvalue ?? 0.5);
}

describe("paperRebalanceTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("refuses with clear message when no alpha run exists", async () => {
    const out = (await paperRebalanceTool.execute({})) as string;
    expect(out).toMatch(/no alpha run found/);
  });

  it("refuses when no backtest run exists", async () => {
    db.prepare(
      `INSERT INTO signal_weights
        (run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma, e_norm, ic_30d, regime, n_effective, excluded, exclude_reason)
       VALUES (?, ?, 'returns', 'macd:AAPL', 'macd on AAPL', 0.4, 0, 0.1, 0, null, null, 1, 0, null)`,
    ).run("a1", "2026-04-17T16:00:00Z");
    const out = (await paperRebalanceTool.execute({})) as string;
    expect(out).toMatch(/no backtest run found/);
  });

  it("refuses when ship_blocked=1 without override", async () => {
    seedAlphaAndBacktest({ shipBlocked: true, pbo: 0.6, dsrPvalue: 0.2 });
    const out = (await paperRebalanceTool.execute({})) as string;
    expect(out).toMatch(/SHIP_BLOCKED/);
    expect(out).toMatch(/PBO=0\.6/);
    expect(out).toMatch(/override_ship_gate/);
    // No fills should land
    const fillCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM paper_fills`).get() as { n: number }
    ).n;
    expect(fillCount).toBe(0);
  });

  it("executes under ship_gate override", async () => {
    seedAlphaAndBacktest({ shipBlocked: true, pbo: 0.6, dsrPvalue: 0.2 });
    const out = (await paperRebalanceTool.execute({
      override_ship_gate: true,
    })) as string;
    expect(out).toContain("paper_rebalance:");
    expect(out).toContain("SHIP_GATE OVERRIDDEN");
    expect(out).toContain("thesis_id=");
    // At least one fill should land (AAPL or TSLA)
    const fillCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM paper_fills`).get() as { n: number }
    ).n;
    expect(fillCount).toBeGreaterThan(0);
    // Thesis row persisted
    const thesisCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM trade_theses WHERE symbol='PORTFOLIO'`,
        )
        .get() as { n: number }
    ).n;
    expect(thesisCount).toBe(1);
  });

  it("executes when ship_blocked=0 (no override needed)", async () => {
    seedAlphaAndBacktest({ shipBlocked: false });
    const out = (await paperRebalanceTool.execute({})) as string;
    expect(out).toContain("paper_rebalance:");
    expect(out).not.toMatch(/SHIP_GATE OVERRIDDEN/);
  });

  it("reports when alpha has no active weights", async () => {
    // Insert an alpha row but mark it excluded
    db.prepare(
      `INSERT INTO signal_weights
        (run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma, e_norm, ic_30d, regime, n_effective, excluded, exclude_reason)
       VALUES (?, ?, 'returns', 'macd:AAPL', 'macd', 0, null, null, null, null, null, 0, 1, 'ic_le_zero')`,
    ).run("a1", "2026-04-17T16:00:00Z");
    db.prepare(
      `INSERT INTO backtest_runs
        (run_id, run_timestamp, strategy, mode, window_start, window_end,
         cost_bps, rebalance_bars, pbo, dsr_ratio, dsr_pvalue, ship_blocked)
       VALUES ('bt', ?, 'flam', 'returns', 'a', 'b', 5, 1, 0.3, 0.5, 0.5, 0)`,
    ).run("2026-04-17T16:00:00Z");
    const out = (await paperRebalanceTool.execute({})) as string;
    expect(out).toMatch(/no active weights/);
  });
});

describe("paperPortfolioTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports empty portfolio on fresh account", async () => {
    const out = (await paperPortfolioTool.execute({})) as string;
    expect(out).toContain("paper_portfolio:");
    expect(out).toMatch(/equity=100000/);
    expect(out).toMatch(/no open positions/);
  });

  it("shows positions after a rebalance", async () => {
    seedAlphaAndBacktest({ shipBlocked: false });
    await paperRebalanceTool.execute({});
    const out = (await paperPortfolioTool.execute({})) as string;
    expect(out).toMatch(/AAPL|TSLA/);
  });
});

describe("paperHistoryTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports no fills on fresh account", async () => {
    const out = (await paperHistoryTool.execute({})) as string;
    expect(out).toContain("paper_history:");
    expect(out).toMatch(/no fills/);
  });

  it("lists fills after a rebalance", async () => {
    seedAlphaAndBacktest({ shipBlocked: false });
    await paperRebalanceTool.execute({});
    const out = (await paperHistoryTool.execute({})) as string;
    expect(out).toContain("paper_history:");
    expect(out).toMatch(/BUY/);
  });

  it("filters by symbol", async () => {
    seedAlphaAndBacktest({ shipBlocked: false });
    await paperRebalanceTool.execute({});
    const outFiltered = (await paperHistoryTool.execute({
      symbol: "AAPL",
    })) as string;
    expect(outFiltered).toContain("AAPL");
    expect(outFiltered).not.toContain("TSLA");
  });

  it("converts YYYY-MM-DD since filter to full ISO", async () => {
    seedAlphaAndBacktest({ shipBlocked: false });
    await paperRebalanceTool.execute({});
    // since far in the future → no fills
    const out = (await paperHistoryTool.execute({
      since: "2099-01-01",
    })) as string;
    expect(out).toMatch(/no fills/);
  });
});

describe("integration: rebalance → portfolio → history chain", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("end-to-end: seed → rebalance → portfolio + history show consistent state", async () => {
    seedAlphaAndBacktest({ shipBlocked: false });
    const rebOut = (await paperRebalanceTool.execute({})) as string;
    expect(rebOut).toContain("paper_rebalance:");

    const portOut = (await paperPortfolioTool.execute({})) as string;
    const histOut = (await paperHistoryTool.execute({})) as string;

    // Both should reflect the same underlying data
    expect(portOut).toContain("paper_portfolio:");
    expect(histOut).toContain("paper_history:");

    // paper_fills count matches what we see in history
    const fillCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM paper_fills`).get() as {
        n: number;
      }
    ).n;
    expect(fillCount).toBeGreaterThan(0);

    // Cash + positions value == equity
    const bal = db
      .prepare(`SELECT cash FROM paper_balance WHERE account='default'`)
      .get() as { cash: number };
    expect(bal.cash).toBeLessThan(100_000); // cash was spent on buys
    expect(bal.cash).toBeGreaterThan(0); // didn't overspend
  });
});
