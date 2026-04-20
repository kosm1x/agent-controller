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

  it("negative weight at v1 = exit YES side, does NOT open NO side", async () => {
    seedMarket("0xm1", 0.4);
    const adapter = new PolymarketPaperAdapter({ clock: new FixedClock(NOW) });
    // Seed a YES position first.
    await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: 0.05 }],
      pmAlphaRunId: "pm-1",
      shipOverride: false,
    });
    // Pass a negative weight.
    const result = await runPmRebalance({
      adapter,
      targets: [{ marketId: "0xm1", outcome: "Yes", weight: -0.05 }],
      pmAlphaRunId: "pm-2",
      shipOverride: false,
    });
    // Expect sell (exit), not a NO-side buy.
    expect(result.fills.length).toBe(1);
    expect(result.fills[0]!.side).toBe("sell");
    expect(result.fills[0]!.symbol).toBe("0xm1:Yes");
    // No NO position was opened.
    const positions = await adapter.getPositions();
    expect(
      positions.every((p) => p.kind !== "polymarket" || p.outcome !== "No"),
    ).toBe(true);
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
});
