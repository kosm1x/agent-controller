/**
 * F8.1b — persistence helpers for Polymarket paper trading.
 *
 * Parallel to F8's `paper-persist.ts` but keyed by `(market_id, outcome)`
 * instead of `symbol`. USDC-denominated. Tables: `pm_paper_balance`,
 * `pm_paper_portfolio`, `pm_paper_fills`. Thesis rows reuse `trade_theses`
 * with `entry_signal='pm_weekly_rebalance'` + `symbol='PORTFOLIO'` sentinel.
 */

import { getDatabase } from "../db/index.js";

export const DEFAULT_PM_ACCOUNT = "default";
export const DEFAULT_PM_INITIAL_CASH = 10_000; // USDC

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PmPaperBalanceRow {
  account: string;
  cash_usdc: number;
  initial_cash: number;
  last_updated: string;
}

export interface PmPaperPortfolioRow {
  id: number;
  account: string;
  market_id: string;
  outcome: string;
  token_id: string | null;
  slug: string | null;
  shares: number;
  avg_cost: number;
  opened_at: string;
  last_updated: string;
}

export interface PmPaperFillRow {
  id: number;
  fill_id: string;
  thesis_id: number | null;
  account: string;
  market_id: string;
  outcome: string;
  token_id: string | null;
  side: "buy" | "sell";
  shares: number;
  fill_price: number;
  gross_notional: number;
  slippage_bps: number;
  realized_pnl: number | null;
  filled_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export function initPmAccount(
  account: string = DEFAULT_PM_ACCOUNT,
  initialCash: number = DEFAULT_PM_INITIAL_CASH,
): PmPaperBalanceRow {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO pm_paper_balance (account, cash_usdc, initial_cash)
     VALUES (?, ?, ?)`,
  ).run(account, initialCash, initialCash);
  return readPmBalance(account)!;
}

export function readPmBalance(
  account: string = DEFAULT_PM_ACCOUNT,
): PmPaperBalanceRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM pm_paper_balance WHERE account = ?`)
    .get(account) as PmPaperBalanceRow | undefined;
  return row ?? null;
}

export function updatePmCash(
  account: string,
  newCash: number,
  nowIso: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE pm_paper_balance SET cash_usdc = ?, last_updated = ? WHERE account = ?`,
  ).run(newCash, nowIso, account);
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export function readPmPortfolio(
  account: string = DEFAULT_PM_ACCOUNT,
): PmPaperPortfolioRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM pm_paper_portfolio
         WHERE account = ?
         ORDER BY market_id ASC, outcome ASC`,
    )
    .all(account) as PmPaperPortfolioRow[];
}

export function readPmPosition(
  account: string,
  marketId: string,
  outcome: string,
): PmPaperPortfolioRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM pm_paper_portfolio
         WHERE account = ? AND market_id = ? AND outcome = ?`,
    )
    .get(account, marketId, outcome) as PmPaperPortfolioRow | undefined;
  return row ?? null;
}

/**
 * Upsert a position after a buy. Weighted-average cost:
 *   new_avg = (old_shares × old_avg + fill_qty × fill_price) / (old_shares + fill_qty)
 */
export function applyPmBuyToPortfolio(opts: {
  account: string;
  marketId: string;
  outcome: string;
  tokenId: string | null;
  slug: string | null;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): void {
  const db = getDatabase();
  const existing = readPmPosition(opts.account, opts.marketId, opts.outcome);
  if (!existing) {
    db.prepare(
      `INSERT INTO pm_paper_portfolio
        (account, market_id, outcome, token_id, slug, shares, avg_cost,
         opened_at, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.account,
      opts.marketId,
      opts.outcome,
      opts.tokenId,
      opts.slug,
      opts.shares,
      opts.fillPrice,
      opts.nowIso,
      opts.nowIso,
    );
    return;
  }
  const oldCost = existing.shares * existing.avg_cost;
  const newCost = opts.shares * opts.fillPrice;
  const newShares = existing.shares + opts.shares;
  const newAvg = newShares > 0 ? (oldCost + newCost) / newShares : 0;
  db.prepare(
    `UPDATE pm_paper_portfolio
       SET shares = ?, avg_cost = ?, last_updated = ?
     WHERE account = ? AND market_id = ? AND outcome = ?`,
  ).run(
    newShares,
    newAvg,
    opts.nowIso,
    opts.account,
    opts.marketId,
    opts.outcome,
  );
}

/**
 * Apply a sell. Returns realized P&L. On full exit (remaining ≤ EXIT_TOL),
 * the row is deleted so no stale avg_cost carries forward.
 */
export function applyPmSellToPortfolio(opts: {
  account: string;
  marketId: string;
  outcome: string;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): { realizedPnl: number; fullyExited: boolean } {
  const db = getDatabase();
  const existing = readPmPosition(opts.account, opts.marketId, opts.outcome);
  if (!existing || existing.shares < opts.shares - 1e-9) {
    throw new Error(
      `applyPmSellToPortfolio: insufficient shares for ${opts.marketId}/${opts.outcome} ` +
        `(held=${existing?.shares ?? 0}, asked=${opts.shares})`,
    );
  }
  const realizedPnl = (opts.fillPrice - existing.avg_cost) * opts.shares;
  const remaining = existing.shares - opts.shares;
  const EXIT_TOL = 1e-9;
  if (remaining <= EXIT_TOL) {
    db.prepare(
      `DELETE FROM pm_paper_portfolio
         WHERE account = ? AND market_id = ? AND outcome = ?`,
    ).run(opts.account, opts.marketId, opts.outcome);
    return { realizedPnl, fullyExited: true };
  }
  db.prepare(
    `UPDATE pm_paper_portfolio
       SET shares = ?, last_updated = ?
     WHERE account = ? AND market_id = ? AND outcome = ?`,
  ).run(remaining, opts.nowIso, opts.account, opts.marketId, opts.outcome);
  return { realizedPnl, fullyExited: false };
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export function insertPmFill(row: {
  fillId: string;
  thesisId: number | null;
  account: string;
  marketId: string;
  outcome: string;
  tokenId: string | null;
  side: "buy" | "sell";
  shares: number;
  fillPrice: number;
  grossNotional: number;
  slippageBps: number;
  realizedPnl: number | null;
  filledAt: string;
}): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO pm_paper_fills
      (fill_id, thesis_id, account, market_id, outcome, token_id, side, shares,
       fill_price, gross_notional, slippage_bps, realized_pnl, filled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.fillId,
    row.thesisId,
    row.account,
    row.marketId,
    row.outcome,
    row.tokenId,
    row.side,
    row.shares,
    row.fillPrice,
    row.grossNotional,
    row.slippageBps,
    row.realizedPnl,
    row.filledAt,
  );
}

export interface ReadPmFillsOpts {
  account?: string;
  marketId?: string;
  outcome?: string;
  since?: string;
  limit?: number;
}

export function readPmFills(opts: ReadPmFillsOpts = {}): PmPaperFillRow[] {
  const db = getDatabase();
  const conds: string[] = [`account = ?`];
  const params: unknown[] = [opts.account ?? DEFAULT_PM_ACCOUNT];
  if (opts.marketId) {
    conds.push(`market_id = ?`);
    params.push(opts.marketId);
  }
  if (opts.outcome) {
    conds.push(`outcome = ?`);
    params.push(opts.outcome);
  }
  if (opts.since) {
    conds.push(`filled_at >= ?`);
    params.push(opts.since);
  }
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 50));
  const sql = `SELECT * FROM pm_paper_fills
               WHERE ${conds.join(" AND ")}
               ORDER BY filled_at DESC
               LIMIT ${limit}`;
  return db.prepare(sql).all(...params) as PmPaperFillRow[];
}

/**
 * Back-link a set of PM fills to a thesis row by fill_id UUID. Same
 * concurrent-safe pattern as F8 equity's `linkFillsToThesis`.
 */
export function linkPmFillsToThesis(
  thesisId: number,
  fillIds: string[],
): number {
  if (fillIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = fillIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE pm_paper_fills
         SET thesis_id = ?
       WHERE fill_id IN (${placeholders})`,
    )
    .run(thesisId, ...fillIds);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Thesis (reuse trade_theses with PM-specific entry_signal)
// ---------------------------------------------------------------------------

export interface PmPortfolioThesisInput {
  account: string;
  pmAlphaRunId: string | null;
  shipOverride: boolean;
  targetWeights: Record<string, { outcome: string; weight: number }>;
  notes?: string;
  aborted?: boolean;
}

export function insertPmPortfolioThesis(
  input: PmPortfolioThesisInput,
  nowIso: string,
): number {
  const db = getDatabase();
  const thesisText = JSON.stringify({
    kind: "pm",
    account: input.account,
    pm_alpha_run_id: input.pmAlphaRunId,
    override: input.shipOverride,
    notes: input.notes ?? null,
  });
  const metadata = JSON.stringify({
    target_weights: input.targetWeights,
    aborted: input.aborted === true,
  });
  const result = db
    .prepare(
      `INSERT INTO trade_theses
        (symbol, thesis_text, entry_signal, entry_time, exit_condition,
         outcome, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "PORTFOLIO",
      thesisText,
      "pm_weekly_rebalance",
      nowIso,
      "next_pm_rebalance",
      "open",
      metadata,
    );
  return result.lastInsertRowid as number;
}
