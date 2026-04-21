import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

import { FixedClock } from "./clock.js";
import { PolymarketPaperAdapter } from "./pm-paper-adapter.js";
import { runPmRebalance } from "./pm-paper-executor.js";

function seedMarket(marketId: string, yesPrice: number) {
  const outcomes = JSON.stringify([
    { id: `${marketId}-yes`, label: "Yes", price: yesPrice },
    { id: `${marketId}-no`, label: "No", price: 1 - yesPrice },
  ]);
  db.prepare(
    `INSERT OR REPLACE INTO prediction_markets
      (source, market_id, slug, question, outcome_tokens, liquidity_usd,
       is_neg_risk, fetched_at)
     VALUES ('polymarket', ?, ?, ?, ?, 50000, 0, '2026-04-20T00:00:00Z')`,
  ).run(marketId, marketId, `test ${marketId}`, outcomes);
}

const NOW = new Date("2026-04-20T16:00:00Z");

describe("runPmRebalance", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("empty targets + empty portfolio → no orders, thesis still written", async () => {
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [],
      pmAlphaRunId: null,
      shipOverride: false,
    });
    expect(result.fills).toEqual([]);
    expect(result.rejects).toEqual([]);
    expect(result.ordersPlanned).toBe(0);
    expect(result.thesisId).toBeGreaterThan(0);
  });

  it("single active weight → buys target shares", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.side).toBe("buy");
    expect(result.fills[0]!.symbol).toBe("0xm1:Yes");
    // Target notional = 10_000 × (1 - 20bps) × 0.05 = $499; at 0.4 = 1247.5
    // shares. Fill at 0.4 × (1 + 20 bps) = 0.4008.
    expect(result.fills[0]!.quantity).toBeCloseTo(1247.5, 1);
  });

  it("sells existing position when weight drops to 0", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // First buy.
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Then target drops to 0.
    const result = await runPmRebalance({
      adapter,
      targets: [],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.side).toBe("sell");
    // Full exit → position removed.
    expect((await adapter.getPositions()).length).toBe(0);
  });

  it("sells before buying to free cash (order ordering)", async () => {
    seedMarket("0xm1", 0.4);
    seedMarket("0xm2", 0.3);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // Fill up on 0xm1.
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.2 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Rotate: drop 0xm1, add 0xm2.
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm2", outcome: "Yes", weight: 0.2 }],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    expect(result.fills.length).toBeGreaterThanOrEqual(2);
    // Sell must come before buy (freed cash).
    expect(result.fills[0]!.side).toBe("sell");
    expect(result.fills[result.fills.length - 1]!.side).toBe("buy");
  });

  it("skips dust trades below $10 notional", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // Target = 10_000 × 0.0005 = $5 (below $10 dust)
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.0005 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(0);
    expect(result.ordersPlanned).toBe(0);
    // Thesis row still persisted for audit.
    expect(result.thesisId).toBeGreaterThan(0);
  });

  it("negative weight (F8.1c) opens NO-side position on binary market", async () => {
    seedMarket("0xm1", 0.4); // YES=0.4, NO=0.6
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // Negative weight on YES → should buy NO at its 0.6 price.
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: -0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.side).toBe("buy");
    expect(result.fills[0]!.symbol).toBe("0xm1:No");
    // Target notional = 10_000 × (1 - 20bps) × |0.05| = $499; at NO=0.6
    // → 831.67 shares. Fill at 0.6 × (1 + 20 bps) = 0.6012.
    expect(result.fills[0]!.quantity).toBeCloseTo(831.67, 1);
  });

  it("negative weight on multi-outcome market is skipped (no complement)", async () => {
    // Seed a 3-outcome market — no clean Yes/No complement.
    const outcomes = JSON.stringify([
      { id: "0xm3-a", label: "Candidate A", price: 0.5 },
      { id: "0xm3-b", label: "Candidate B", price: 0.3 },
      { id: "0xm3-c", label: "Candidate C", price: 0.2 },
    ]);
    db.prepare(
      `INSERT OR REPLACE INTO prediction_markets
        (source, market_id, slug, question, outcome_tokens, liquidity_usd,
         is_neg_risk, fetched_at)
       VALUES ('polymarket', '0xm3', '0xm3', 'three-way', ?, 50000, 0,
               '2026-04-20T00:00:00Z')`,
    ).run(outcomes);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm3", outcome: "Candidate A", weight: -0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(0);
    expect(result.ordersSkipped).toBeGreaterThan(0);
  });

  it("existing YES holding + negative weight sells YES AND opens NO", async () => {
    seedMarket("0xm1", 0.4); // YES=0.4, NO=0.6
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // First: buy YES.
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Second: flip to negative weight — must sell YES (no target on YES) AND buy NO.
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: -0.05 }],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    const sides = result.fills.map((f) => `${f.side}:${f.symbol}`);
    expect(sides).toContain("sell:0xm1:Yes");
    expect(sides).toContain("buy:0xm1:No");
    // Sell must come before buy (cash ordering).
    expect(result.fills[0]!.side).toBe("sell");
  });

  it("skips tokens with no quote available (no_quote)", async () => {
    // Seed only 0xm1; 0xm2 has no row → no_quote path.
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [
        { marketId: "0xm1", outcome: "Yes", weight: 0.05 },
        { marketId: "0xm2", outcome: "Yes", weight: 0.05 },
      ],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.symbol).toBe("0xm1:Yes");
    expect(result.ordersSkipped).toBeGreaterThan(0);
  });

  it("persists thesis with kind:pm + pm_alpha_run_id + target weights", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.03 }],
      pmAlphaRunId: "pm-xyz",
      shipOverride: true,
      notes: "smoke test",
    });
    const row = db
      .prepare(`SELECT * FROM trade_theses WHERE id = ?`)
      .get(result.thesisId) as {
      symbol: string;
      entry_signal: string;
      thesis_text: string;
      metadata: string;
    };
    expect(row.symbol).toBe("PORTFOLIO");
    expect(row.entry_signal).toBe("pm_weekly_rebalance");
    const thesis = JSON.parse(row.thesis_text);
    expect(thesis.kind).toBe("pm");
    expect(thesis.pm_alpha_run_id).toBe("pm-xyz");
    expect(thesis.override).toBe(true);
    expect(thesis.notes).toBe("smoke test");
    const md = JSON.parse(row.metadata);
    expect(md.target_weights["0xm1"].outcome).toBe("Yes");
  });

  it("full-exit sells bypass the $10 dust filter (stranded penny positions)", async () => {
    // Seed market at yes=0.4 and buy a position.
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.01 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Re-quote the market so the position is worth well under $10 at mark.
    // $100 notional / 0.4 ≈ 250 shares at entry; at 0.02 mark that's ~$5.
    seedMarket("0xm1", 0.02);
    const result = await runPmRebalance({
      adapter,
      targets: [], // full exit
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    // Even though |delta × price| ≈ $5 < $10 dust, full-exit must fill.
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.side).toBe("sell");
    expect((await adapter.getPositions()).length).toBe(0);
  });

  it("stale-abort thesis metadata carries aborted=true", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    db.prepare(
      `UPDATE prediction_markets SET fetched_at = '2026-03-01T00:00:00Z' WHERE market_id = ?`,
    ).run("0xm1");
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.07 }],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    expect(result.stalePositionsAborted).toBe(true);
    const row = db
      .prepare(`SELECT metadata FROM trade_theses WHERE id = ?`)
      .get(result.thesisId) as { metadata: string };
    const md = JSON.parse(row.metadata);
    expect(md.aborted).toBe(true);
  });

  it("aborts pre-trade when a held position has a stale mark", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // Seed a position.
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Age the market row past the stale window (>5 days).
    db.prepare(
      `UPDATE prediction_markets SET fetched_at = '2026-03-01T00:00:00Z' WHERE market_id = ?`,
    ).run("0xm1");
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.07 }],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    expect(result.stalePositionsAborted).toBe(true);
    expect(result.fills.length).toBe(0);
    expect(result.ordersPlanned).toBe(0);
    // Thesis still persisted for audit.
    expect(result.thesisId).toBeGreaterThan(0);
  });

  it("allowStale=true overrides the stale-abort gate", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    db.prepare(
      `UPDATE prediction_markets SET fetched_at = '2026-03-01T00:00:00Z' WHERE market_id = ?`,
    ).run("0xm1");
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.07 }],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
      allowStale: true,
    });
    expect(result.stalePositionsAborted).toBe(false);
    // Cash buffer derates target by 20 bps — some rebalance may or may not
    // cross the dust threshold at this delta; assert on the gate itself.
  });

  it("links fills to the thesis by fill_id (audit-W4-style guard)", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    expect(result.fills.length).toBe(1);
    const linked = db
      .prepare(`SELECT COUNT(*) AS n FROM pm_paper_fills WHERE thesis_id = ?`)
      .get(result.thesisId) as { n: number };
    expect(linked.n).toBe(result.fills.length);
  });

  // F8.1c — cadence param writes to entry_signal
  it("cadence='daily' tags thesis entry_signal=pm_daily_rebalance", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.03 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
      cadence: "daily",
    });
    const row = db
      .prepare(`SELECT entry_signal FROM trade_theses WHERE id = ?`)
      .get(result.thesisId) as { entry_signal: string };
    expect(row.entry_signal).toBe("pm_daily_rebalance");
  });

  it("cadence='weekly' (default, unspecified) preserves pm_weekly_rebalance", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.03 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
      // cadence omitted → defaults to weekly
    });
    const row = db
      .prepare(`SELECT entry_signal FROM trade_theses WHERE id = ?`)
      .get(result.thesisId) as { entry_signal: string };
    expect(row.entry_signal).toBe("pm_weekly_rebalance");
  });

  // F8.1c — staleness threshold parametrization
  it("24h staleness threshold rejects a 48h-old quote", async () => {
    // Seed a market with a 48h-old fetched_at.
    const outcomes = JSON.stringify([
      { id: "0xm4-yes", label: "Yes", price: 0.4 },
      { id: "0xm4-no", label: "No", price: 0.6 },
    ]);
    const oldFetch = new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO prediction_markets
        (source, market_id, slug, question, outcome_tokens, liquidity_usd,
         is_neg_risk, fetched_at)
       VALUES ('polymarket', '0xm4', '0xm4', 'old', ?, 50000, 0, ?)`,
    ).run(outcomes, oldFetch);
    const adapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
      quoteStaleMs: 24 * 3600 * 1000,
    });
    await expect(adapter.getMarketData("0xm4:Yes")).rejects.toThrow(
      /stale quote/,
    );
  });

  it("default (5d) staleness threshold accepts a 48h-old quote", async () => {
    const outcomes = JSON.stringify([
      { id: "0xm5-yes", label: "Yes", price: 0.4 },
      { id: "0xm5-no", label: "No", price: 0.6 },
    ]);
    const oldFetch = new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO prediction_markets
        (source, market_id, slug, question, outcome_tokens, liquidity_usd,
         is_neg_risk, fetched_at)
       VALUES ('polymarket', '0xm5', '0xm5', 'old', ?, 50000, 0, ?)`,
    ).run(outcomes, oldFetch);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const q = await adapter.getMarketData("0xm5:Yes");
    expect(q.price).toBe(0.4);
  });

  it("24h staleness + held position aged 25h → executor aborts (stalePositionsAborted=true)", async () => {
    // Seed market at YES=0.4. Buy position via a 5d-adapter (so the buy
    // doesn't trip its own staleness gate) — the resulting position is
    // persisted in the DB regardless of adapter instance.
    seedMarket("0xm1", 0.4);
    const primeAdapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
    });
    await runPmRebalance({
      adapter: primeAdapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-prime",
      shipOverride: false,
    });
    // Age the market's fetched_at to 25h ago.
    db.prepare(
      `UPDATE prediction_markets SET fetched_at = ? WHERE market_id = ?`,
    ).run(new Date(NOW.getTime() - 25 * 3600 * 1000).toISOString(), "0xm1");
    // Daily cadence adapter with 24h threshold — held position now stale.
    const dailyAdapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
      quoteStaleMs: 24 * 3600 * 1000,
    });
    const result = await runPmRebalance({
      adapter: dailyAdapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-daily",
      shipOverride: false,
      cadence: "daily",
    });
    expect(result.stalePositionsAborted).toBe(true);
    expect(result.fills.length).toBe(0);
    expect(result.staleMarkets).toContain("0xm1:Yes");
  });

  it("multi-outcome market (3+ outcomes) rejects NO-side short", async () => {
    const outcomes = JSON.stringify([
      { id: "yn-yes", label: "Yes", price: 0.4 },
      { id: "yn-no", label: "No", price: 0.3 },
      { id: "yn-maybe", label: "Maybe", price: 0.3 },
    ]);
    db.prepare(
      `INSERT OR REPLACE INTO prediction_markets
        (source, market_id, slug, question, outcome_tokens, liquidity_usd,
         is_neg_risk, fetched_at)
       VALUES ('polymarket', 'yn3', 'yn3', 'three-way', ?, 50000, 0,
               '2026-04-20T00:00:00Z')`,
    ).run(outcomes);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "yn3", outcome: "Yes", weight: -0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Even though "Yes" has a clean complement label "No", the 3-outcome
    // market means NO-side buying doesn't fully hedge — skip.
    expect(result.fills.length).toBe(0);
    expect(result.ordersSkipped).toBeGreaterThan(0);
  });

  it("quoteStaleMs<=0 clamps to 5d default (prevents always-stale misconfig)", async () => {
    const outcomes = JSON.stringify([
      { id: "0xm6-yes", label: "Yes", price: 0.4 },
      { id: "0xm6-no", label: "No", price: 0.6 },
    ]);
    const recentFetch = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO prediction_markets
        (source, market_id, slug, question, outcome_tokens, liquidity_usd,
         is_neg_risk, fetched_at)
       VALUES ('polymarket', '0xm6', '0xm6', 'fresh', ?, 50000, 0, ?)`,
    ).run(outcomes, recentFetch);
    const adapter = new PolymarketPaperAdapter({
      clock: new FixedClock(NOW),
      quoteStaleMs: 0,
    });
    // Would-be-stale (0ms threshold) clamps to default; 1h fresh quote is fine.
    const q = await adapter.getMarketData("0xm6:Yes");
    expect(q.price).toBe(0.4);
  });
});

describe("complementOutcome", () => {
  it("yes ↔ no case-preserving", async () => {
    const { complementOutcome } = await import("./pm-paper-executor.js");
    expect(complementOutcome("Yes")).toBe("No");
    expect(complementOutcome("No")).toBe("Yes");
    expect(complementOutcome("YES")).toBe("NO");
    expect(complementOutcome("yes")).toBe("no");
  });

  it("true/false, up/down, si/sí → no", async () => {
    const { complementOutcome } = await import("./pm-paper-executor.js");
    expect(complementOutcome("True")).toBe("False");
    expect(complementOutcome("up")).toBe("down");
    expect(complementOutcome("Sí")).toBe("No");
    expect(complementOutcome("si")).toBe("no");
  });

  it("unknown / multi-outcome → null", async () => {
    const { complementOutcome } = await import("./pm-paper-executor.js");
    expect(complementOutcome("Candidate A")).toBeNull();
    expect(complementOutcome("Trump")).toBeNull();
    expect(complementOutcome("50-60% range")).toBeNull();
  });
});
