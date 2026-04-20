/**
 * F8 — persistence helpers for paper trading.
 *
 * Centralizes SQL + DB-transaction orchestration so the adapter + executor
 * stay focused on business logic. All readers return structured rows; writers
 * return the ids/counts the caller needs for downstream sanity checks.
 *
 * Tables used:
 *   paper_balance     — one row per account; cash + initial_cash
 *   paper_portfolio   — one row per (account, symbol); shares + avg_cost
 *   paper_fills       — append-only; every buy/sell + realized P&L on sells
 *   trade_theses      — existing table; one row per rebalance (symbol='PORTFOLIO')
 */

import { getDatabase } from "../db/index.js";

export const DEFAULT_ACCOUNT = "default";
export const DEFAULT_INITIAL_CASH = 100_000;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PaperBalanceRow {
  account: string;
  cash: number;
  initial_cash: number;
  last_updated: string;
}

export interface PaperPortfolioRow {
  id: number;
  account: string;
  symbol: string;
  shares: number;
  avg_cost: number;
  opened_at: string;
  last_updated: string;
}

export interface PaperFillRow {
  id: number;
  fill_id: string;
  thesis_id: number | null;
  account: string;
  symbol: string;
  side: "buy" | "sell";
  shares: number;
  fill_price: number;
  gross_notional: number;
  commission: number;
  slippage_bps: number;
  realized_pnl: number | null;
  filled_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * Return the balance row for an account, inserting a default row if one
 * doesn't already exist. Safe to call multiple times (idempotent).
 */
export function initAccount(
  account: string = DEFAULT_ACCOUNT,
  initialCash: number = DEFAULT_INITIAL_CASH,
): PaperBalanceRow {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO paper_balance (account, cash, initial_cash)
     VALUES (?, ?, ?)`,
  ).run(account, initialCash, initialCash);
  return readBalance(account)!;
}

export function readBalance(
  account: string = DEFAULT_ACCOUNT,
): PaperBalanceRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM paper_balance WHERE account = ?`)
    .get(account) as PaperBalanceRow | undefined;
  return row ?? null;
}

export function updateCash(
  account: string,
  newCash: number,
  nowIso: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE paper_balance SET cash = ?, last_updated = ? WHERE account = ?`,
  ).run(newCash, nowIso, account);
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export function readPortfolio(
  account: string = DEFAULT_ACCOUNT,
): PaperPortfolioRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM paper_portfolio WHERE account = ? ORDER BY symbol ASC`,
    )
    .all(account) as PaperPortfolioRow[];
}

export function readPosition(
  account: string,
  symbol: string,
): PaperPortfolioRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM paper_portfolio WHERE account = ? AND symbol = ?`)
    .get(account, symbol) as PaperPortfolioRow | undefined;
  return row ?? null;
}

/**
 * Upsert a position after a buy. Recomputes weighted-average cost:
 *   new_avg = (old_shares × old_avg + fill_qty × fill_price) / (old_shares + fill_qty)
 */
export function applyBuyToPortfolio(opts: {
  account: string;
  symbol: string;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): void {
  const db = getDatabase();
  const existing = readPosition(opts.account, opts.symbol);
  if (!existing) {
    db.prepare(
      `INSERT INTO paper_portfolio (account, symbol, shares, avg_cost, opened_at, last_updated)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.account,
      opts.symbol,
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
    `UPDATE paper_portfolio
       SET shares = ?, avg_cost = ?, last_updated = ?
     WHERE account = ? AND symbol = ?`,
  ).run(newShares, newAvg, opts.nowIso, opts.account, opts.symbol);
}

/**
 * Apply a sell. Returns realized P&L for the sold shares. If the sell
 * reduces shares to 0 (within tolerance), the row is deleted — no stale
 * zero-share rows carrying avg_cost values forward.
 */
export function applySellToPortfolio(opts: {
  account: string;
  symbol: string;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): { realizedPnl: number; fullyExited: boolean } {
  const db = getDatabase();
  const existing = readPosition(opts.account, opts.symbol);
  if (!existing || existing.shares < opts.shares - 1e-9) {
    throw new Error(
      `applySellToPortfolio: insufficient shares for ${opts.symbol} ` +
        `(held=${existing?.shares ?? 0}, asked=${opts.shares})`,
    );
  }
  const realizedPnl = (opts.fillPrice - existing.avg_cost) * opts.shares;
  const remaining = existing.shares - opts.shares;
  const EXIT_TOL = 1e-9;
  if (remaining <= EXIT_TOL) {
    db.prepare(
      `DELETE FROM paper_portfolio WHERE account = ? AND symbol = ?`,
    ).run(opts.account, opts.symbol);
    return { realizedPnl, fullyExited: true };
  }
  // avg_cost unchanged on sell (sells don't alter the weighted entry of
  // what's left).
  db.prepare(
    `UPDATE paper_portfolio
       SET shares = ?, last_updated = ?
     WHERE account = ? AND symbol = ?`,
  ).run(remaining, opts.nowIso, opts.account, opts.symbol);
  return { realizedPnl, fullyExited: false };
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export function insertFill(row: {
  fillId: string;
  thesisId: number | null;
  account: string;
  symbol: string;
  side: "buy" | "sell";
  shares: number;
  fillPrice: number;
  grossNotional: number;
  commission: number;
  slippageBps: number;
  realizedPnl: number | null;
  filledAt: string;
}): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO paper_fills
      (fill_id, thesis_id, account, symbol, side, shares, fill_price,
       gross_notional, commission, slippage_bps, realized_pnl, filled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.fillId,
    row.thesisId,
    row.account,
    row.symbol,
    row.side,
    row.shares,
    row.fillPrice,
    row.grossNotional,
    row.commission,
    row.slippageBps,
    row.realizedPnl,
    row.filledAt,
  );
}

export interface ReadFillsOpts {
  account?: string;
  symbol?: string;
  since?: string;
  limit?: number;
}

export function readFills(opts: ReadFillsOpts = {}): PaperFillRow[] {
  const db = getDatabase();
  const conds: string[] = [];
  const params: unknown[] = [];
  conds.push(`account = ?`);
  params.push(opts.account ?? DEFAULT_ACCOUNT);
  if (opts.symbol) {
    conds.push(`symbol = ?`);
    params.push(opts.symbol);
  }
  if (opts.since) {
    conds.push(`filled_at >= ?`);
    params.push(opts.since);
  }
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 50));
  const sql = `SELECT * FROM paper_fills
               WHERE ${conds.join(" AND ")}
               ORDER BY filled_at DESC
               LIMIT ${limit}`;
  return db.prepare(sql).all(...params) as PaperFillRow[];
}

// ---------------------------------------------------------------------------
// Thesis writes (reuses existing trade_theses table)
// ---------------------------------------------------------------------------

export interface PortfolioThesisInput {
  account: string;
  alphaRunId: string | null;
  backtestRunId: string | null;
  regime: string | null;
  shipBlocked: boolean;
  overrideShip: boolean;
  targetWeights: Record<string, number>;
  notes?: string;
  /**
   * Flags this thesis as an aborted rebalance (stale quotes, no trades). The
   * existing `trade_theses` schema CHECK constraint restricts `outcome` to a
   * fixed enum that doesn't include 'aborted', so we encode the abort state
   * in `metadata.aborted=true` + a "aborted:" prefix in `notes`. Queries can
   * filter with `WHERE thesis_text LIKE '%aborted%'`.
   */
  aborted?: boolean;
}

/**
 * Insert one `trade_theses` row tagging this rebalance. `symbol='PORTFOLIO'`
 * is our sentinel for multi-symbol rebalances; per-symbol thesis rows are
 * reserved for F8.2 (one thesis per trade idea) if the operator asks for them.
 * Returns the inserted row id so fills can link back.
 */
export function insertPortfolioThesis(
  input: PortfolioThesisInput,
  nowIso: string,
): number {
  const db = getDatabase();
  const thesisText = JSON.stringify({
    account: input.account,
    alpha_run_id: input.alphaRunId,
    backtest_run_id: input.backtestRunId,
    regime: input.regime,
    ship_blocked: input.shipBlocked,
    override_ship: input.overrideShip,
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
      "weekly_rebalance",
      nowIso,
      "next_weekly_rebalance",
      "open",
      metadata,
    );
  return result.lastInsertRowid as number;
}

/**
 * Back-link a set of fills to their thesis row by UUID. Called after a
 * rebalance once the thesis id is known. Matching by fill_id (not by time
 * window) avoids misattributing fills from a concurrent rebalance — the
 * audit-R2-4 fix to the earlier time-window approach.
 */
export function linkFillsToThesis(thesisId: number, fillIds: string[]): number {
  if (fillIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = fillIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE paper_fills
         SET thesis_id = ?
       WHERE fill_id IN (${placeholders})`,
    )
    .run(thesisId, ...fillIds);
  return result.changes;
}
