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

import {
  pmPaperRebalanceTool,
  pmPaperPortfolioTool,
  pmPaperHistoryTool,
} from "./pm-paper-trading.js";

/** Seed a market + pm_alpha run with one active weight on YES side. */
function seedPmAlphaWithMarket(opts: {
  marketId: string;
  yesPrice: number;
  weight: number;
}) {
  const outcomes = JSON.stringify([
    { id: `${opts.marketId}-yes`, label: "Yes", price: opts.yesPrice },
    { id: `${opts.marketId}-no`, label: "No", price: 1 - opts.yesPrice },
  ]);
  db.prepare(
    `INSERT OR REPLACE INTO prediction_markets
      (source, market_id, slug, question, outcome_tokens, liquidity_usd,
       is_neg_risk, fetched_at)
     VALUES ('polymarket', ?, ?, ?, ?, 50000, 0, '2026-04-20T00:00:00Z')`,
  ).run(opts.marketId, opts.marketId, `test ${opts.marketId}`, outcomes);

  // Active weight row
  db.prepare(
    `INSERT INTO pm_signal_weights
      (run_id, run_timestamp, market_id, slug, outcome, token_id,
       market_price, p_estimate, edge, whale_flow_usd, sentiment_tilt,
       kelly_raw, weight, liquidity_usd, resolution_date, excluded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 50000, '2026-06-01', 0)`,
  ).run(
    "run-1",
    "2026-04-20T00:00:00Z",
    opts.marketId,
    opts.marketId,
    "Yes",
    `${opts.marketId}-yes`,
    opts.yesPrice,
    opts.yesPrice + 0.02,
    0.02,
    opts.weight,
    opts.weight,
  );
}

describe("pmPaperRebalanceTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports clear error when no pm_alpha run exists", async () => {
    const out = (await pmPaperRebalanceTool.execute({})) as string;
    expect(out).toMatch(/no pm_alpha_run found/);
  });

  it("reports when pm_alpha has no active weights", async () => {
    // Insert pm_signal_weights row but mark excluded
    db.prepare(
      `INSERT INTO pm_signal_weights
        (run_id, run_timestamp, market_id, outcome, market_price, p_estimate,
         edge, sentiment_tilt, kelly_raw, weight, excluded, exclude_reason)
       VALUES (?, ?, ?, ?, 0.4, 0.4, 0, 0, 0, 0, 1, 'low_liquidity')`,
    ).run("r", "2026-04-20T00:00:00Z", "0xexcl", "Yes");
    const out = (await pmPaperRebalanceTool.execute({})) as string;
    expect(out).toMatch(/no active weights/);
  });

  it("executes a rebalance end-to-end and persists fills + thesis", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    const out = (await pmPaperRebalanceTool.execute({})) as string;
    expect(out).toContain("pm_paper_rebalance:");
    expect(out).toContain("thesis_id=");
    expect(out).toContain("filled=");

    const fillCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM pm_paper_fills`).get() as {
        n: number;
      }
    ).n;
    expect(fillCount).toBeGreaterThan(0);
    const thesisCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM trade_theses
             WHERE symbol='PORTFOLIO' AND entry_signal='pm_weekly_rebalance'`,
        )
        .get() as { n: number }
    ).n;
    expect(thesisCount).toBe(1);
  });

  it("surfaces STALE_ABORT and respects allow_stale passthrough", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    // First rebalance opens a position.
    await pmPaperRebalanceTool.execute({});
    // Age the market so the held position becomes stale.
    db.prepare(
      `UPDATE prediction_markets SET fetched_at = '2026-03-01T00:00:00Z' WHERE market_id = ?`,
    ).run("0xm1");
    // Re-seed pm_alpha weights so readLatestPmAlphaRun still yields targets.
    const staleOut = (await pmPaperRebalanceTool.execute({})) as string;
    expect(staleOut).toContain("STALE_ABORT");
    // With allow_stale=true the gate lifts and rebalance proceeds.
    const forcedOut = (await pmPaperRebalanceTool.execute({
      allow_stale: true,
    })) as string;
    expect(forcedOut).not.toContain("STALE_ABORT");
  });

  it("surfaces override_ship_gate in output (audit-trail only at v1)", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    const out = (await pmPaperRebalanceTool.execute({
      override_ship_gate: true,
    })) as string;
    expect(out).toContain("SHIP_GATE OVERRIDE");
  });
});

describe("pmPaperPortfolioTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports empty portfolio on fresh account", async () => {
    const out = (await pmPaperPortfolioTool.execute({})) as string;
    expect(out).toContain("pm_paper_portfolio:");
    expect(out).toMatch(/cash=10000/);
    expect(out).toMatch(/no open positions/);
  });

  it("shows positions after a rebalance", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    await pmPaperRebalanceTool.execute({});
    const out = (await pmPaperPortfolioTool.execute({})) as string;
    expect(out).toContain("pm_paper_portfolio:");
    // Displays either slug (which equals marketId in test fixture) or first 8 chars
    expect(out).toMatch(/0xm1/);
    expect(out).toMatch(/Yes/);
  });
});

describe("pmPaperHistoryTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports no fills on fresh account", async () => {
    const out = (await pmPaperHistoryTool.execute({})) as string;
    expect(out).toContain("pm_paper_history:");
    expect(out).toMatch(/no fills/);
  });

  it("lists fills after a rebalance", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    await pmPaperRebalanceTool.execute({});
    const out = (await pmPaperHistoryTool.execute({})) as string;
    expect(out).toContain("pm_paper_history:");
    expect(out).toMatch(/BUY/);
    expect(out).toMatch(/0xm1:Yes/);
  });

  it("filters by market_id", async () => {
    // Seed BOTH markets under the same run_id so pm_alpha_latest yields both
    // tokens in one rebalance call.
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    seedPmAlphaWithMarket({ marketId: "0xm2", yesPrice: 0.3, weight: 0.05 });
    await pmPaperRebalanceTool.execute({});
    const out1 = (await pmPaperHistoryTool.execute({
      market_id: "0xm1",
    })) as string;
    expect(out1).toContain("0xm1:Yes");
    expect(out1).not.toContain("0xm2:Yes");
  });

  it("filters by outcome", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    await pmPaperRebalanceTool.execute({});
    const out = (await pmPaperHistoryTool.execute({
      outcome: "Yes",
    })) as string;
    expect(out).toContain("Yes");
    const out2 = (await pmPaperHistoryTool.execute({
      outcome: "No",
    })) as string;
    expect(out2).toMatch(/no fills/);
  });

  it("accepts YYYY-MM-DD since filter", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    await pmPaperRebalanceTool.execute({});
    const futureOut = (await pmPaperHistoryTool.execute({
      since: "2099-01-01",
    })) as string;
    expect(futureOut).toMatch(/no fills/);
  });
});
