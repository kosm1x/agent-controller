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

/**
 * Fresh-now ISO timestamp. Previously this file hardcoded
 * `'2026-04-20T00:00:00Z'` for both `prediction_markets.fetched_at`
 * and `pm_signal_weights.run_timestamp`. The rebalance path's
 * staleness gate (PolymarketPaperAdapter.quoteStaleMs, 5-day default
 * for weekly cadence) compares `fetched_at` against `Date.now()`. As
 * calendar time advanced past the 2026-04-20 anchor + 5 days, the
 * fixture aged into STALE_ABORT territory and every test that
 * depended on a successful rebalance started failing. Using
 * `new Date()` keeps the fixture always-fresh; tests that need stale
 * semantics (e.g. the "surfaces STALE_ABORT" case at line ~118) set
 * an explicitly-old timestamp in-test.
 *
 * Also future-resolves `resolution_date` so it never passes into the
 * past and gets filtered by a future resolution-date filter.
 */
const FRESH_NOW = () => new Date().toISOString();
const FUTURE_RESOLUTION = () =>
  new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

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
     VALUES ('polymarket', ?, ?, ?, ?, 50000, 0, ?)`,
  ).run(
    opts.marketId,
    opts.marketId,
    `test ${opts.marketId}`,
    outcomes,
    FRESH_NOW(),
  );

  // Active weight row
  db.prepare(
    `INSERT INTO pm_signal_weights
      (run_id, run_timestamp, market_id, slug, outcome, token_id,
       market_price, p_estimate, edge, whale_flow_usd, sentiment_tilt,
       kelly_raw, weight, liquidity_usd, resolution_date, excluded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 50000, ?, 0)`,
  ).run(
    "run-1",
    FRESH_NOW(),
    opts.marketId,
    opts.marketId,
    "Yes",
    `${opts.marketId}-yes`,
    opts.yesPrice,
    opts.yesPrice + 0.02,
    0.02,
    opts.weight,
    opts.weight,
    FUTURE_RESOLUTION(),
  );
}

describe("pmPaperRebalanceTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns an error object when no pm_alpha run exists", async () => {
    const out = (await pmPaperRebalanceTool.execute({})) as string;
    expect(out.startsWith('{"error":')).toBe(true);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(parsed.error).toBe(
      "pm_paper_rebalance: no pm_alpha_run found. Run `pm_alpha_run` first to produce per-token weights.",
    );
    // Nothing was traded or recorded.
    for (const table of ["pm_paper_fills", "trade_theses"]) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n;
      expect(n).toBe(0);
    }
  });

  it("reports when pm_alpha has no active weights", async () => {
    // Insert pm_signal_weights row but mark excluded
    db.prepare(
      `INSERT INTO pm_signal_weights
        (run_id, run_timestamp, market_id, outcome, market_price, p_estimate,
         edge, sentiment_tilt, kelly_raw, weight, excluded, exclude_reason)
       VALUES (?, ?, ?, ?, 0.4, 0.4, 0, 0, 0, 0, 1, 'low_liquidity')`,
    ).run("r", FRESH_NOW(), "0xexcl", "Yes");
    const out = (await pmPaperRebalanceTool.execute({})) as string;
    // No active weights is a result, not a failure: plain text, nothing traded.
    expect(out).toBe(
      "pm_paper_rebalance: pm_alpha run r has no active weights. Nothing to trade.",
    );
    const fills = (
      db.prepare(`SELECT COUNT(*) AS n FROM pm_paper_fills`).get() as {
        n: number;
      }
    ).n;
    expect(fills).toBe(0);
  });

  it("executes a rebalance end-to-end and persists fills + thesis", async () => {
    seedPmAlphaWithMarket({ marketId: "0xm1", yesPrice: 0.4, weight: 0.05 });
    const out = (await pmPaperRebalanceTool.execute({})) as string;
    expect(out.startsWith("pm_paper_rebalance: thesis_id=")).toBe(true);
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
    expect(staleOut.startsWith("pm_paper_rebalance: thesis_id=")).toBe(true);
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

// Description pins: each tool's whole description text as registered.
describe("tool description texts", () => {
  it("pm_paper_rebalance: the whole description", () => {
    expect(pmPaperRebalanceTool.definition.function.description).toBe(`Executes a Polymarket paper-trading rebalance from the latest \`pm_alpha_run\` output.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- The user means the equities paper book (tickers, Alpaca-style) → use paper_rebalance / paper_portfolio.
- No pm_alpha_run has produced signals yet → run pm_alpha_run first.

Pipeline:
  pm_alpha_latest → per-token |weight| × total_equity sizing → diff vs current
  PM positions → sells-first ordering → synthetic fills at midpoint × (1 ± 20 bps
  slip) → persists fills + PM thesis row.

USE WHEN operator asks to "rebalance polymarket positions", "pm paper trade",
"ejecuta pm rebalance", "rotar polymarket", "aplica pesos polymarket".
NOT WHEN equity rebalance (use \`paper_rebalance\` — F8) or alpha analysis only
(use \`pm_alpha_run\` / \`pm_alpha_latest\`).

No F7.5 ship_gate at v1 — deferred to F8.1d. Negative α weights now open
NO-side positions (buy the complement outcome) as of F8.1c; legacy v1
exit-only behavior is no longer active.

Cadence param (F8.1c): "weekly" (default, preserves F8.1b behavior) or
"daily". Daily cadence uses a 24h staleness gate + tags thesis entry_signal
as pm_daily_rebalance for audit separation.

Takes ~0.5-1s. Starts with $10K USDC paper cash on first run. No leverage.
MARKET orders only. Dust threshold: $10 per trade.`);
  });
  it("pm_paper_portfolio: the whole description", () => {
    expect(pmPaperPortfolioTool.definition.function.description).toBe(`Current Polymarket paper portfolio: positions (market + outcome + shares + avg_cost + market_value + unr P&L), USDC cash, total equity.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- The user asks about the equities paper book → use paper_portfolio.
- The user wants fills / trade history → use pm_paper_history.

USE WHEN operator asks "pm portfolio", "polymarket positions", "posiciones polymarket".
NOT WHEN asking for trade history (use \`pm_paper_history\`) or equity positions (use \`paper_portfolio\`).

Reads only, except that it creates the paper account row when none exists yet. Marks to market using cached midpoint per token.`);
  });
  it("pm_paper_history: the whole description", () => {
    expect(pmPaperHistoryTool.definition.function.description).toBe(`Recent Polymarket paper fills. Filter by market_id (Polymarket condition_id UUID), outcome, since-date, limit.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- The user asks for equities fills → use paper_history.
- The user wants current positions or equity → use pm_paper_portfolio.

USE WHEN operator asks "pm history", "polymarket fills", "historial de pm paper".
NOT WHEN asking for current positions (use \`pm_paper_portfolio\`) or equities fills (use \`paper_history\`).

Reads only, except that it creates the paper account row when none exists yet.`);
  });
});
