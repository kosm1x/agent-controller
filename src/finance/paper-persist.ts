/**
 * F8 — persistence helpers for paper trading.
 *
 * Thin equity-venue wrapper over `paper-persist-core.ts` (Phase 4.5): the
 * shared CRUD + ledger math lives in the core, parameterized by table names;
 * this file keeps the exact F8 exports so the adapter/executor/tests stay
 * untouched. Realized P&L is cents-rounded at the ledger-write boundary —
 * see `roundMoney` in the core.
 *
 * Tables used:
 *   paper_balance     — one row per account; cash + initial_cash
 *   paper_portfolio   — one row per (account, symbol); shares + avg_cost
 *   paper_fills       — append-only; every buy/sell + realized P&L on sells
 *   trade_theses      — existing table; one row per rebalance (symbol='PORTFOLIO')
 */

import {
  type BalanceRowBase,
  type FillInsertBase,
  type FillRowBase,
  type PortfolioRowBase,
  type VenueConfig,
  applyBuyCore,
  applySellCore,
  initAccountCore,
  insertFillCore,
  insertThesisRow,
  linkFillsToThesisCore,
  readBalanceCore,
  readFillsCore,
  readPortfolioCore,
  readPositionCore,
  updateCashCore,
} from "./paper-persist-core.js";

export const DEFAULT_ACCOUNT = "default";
export const DEFAULT_INITIAL_CASH = 100_000;

const EQUITY: VenueConfig = {
  balanceTable: "paper_balance",
  cashColumn: "cash",
  portfolioTable: "paper_portfolio",
  fillsTable: "paper_fills",
  keyColumns: ["symbol"],
  sellLabel: "applySellToPortfolio",
};

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PaperBalanceRow extends BalanceRowBase {
  cash: number;
}

export interface PaperPortfolioRow extends PortfolioRowBase {
  symbol: string;
}

export interface PaperFillRow extends FillRowBase {
  symbol: string;
  commission: number;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export function initAccount(
  account: string = DEFAULT_ACCOUNT,
  initialCash: number = DEFAULT_INITIAL_CASH,
): PaperBalanceRow {
  return initAccountCore<PaperBalanceRow>(EQUITY, account, initialCash);
}

export function readBalance(
  account: string = DEFAULT_ACCOUNT,
): PaperBalanceRow | null {
  return readBalanceCore<PaperBalanceRow>(EQUITY, account);
}

export function updateCash(
  account: string,
  newCash: number,
  nowIso: string,
): void {
  updateCashCore(EQUITY, account, newCash, nowIso);
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export function readPortfolio(
  account: string = DEFAULT_ACCOUNT,
): PaperPortfolioRow[] {
  return readPortfolioCore<PaperPortfolioRow>(EQUITY, account);
}

export function readPosition(
  account: string,
  symbol: string,
): PaperPortfolioRow | null {
  return readPositionCore<PaperPortfolioRow>(EQUITY, account, [symbol]);
}

/** Upsert a position after a buy — weighted-average cost math in `applyBuyCore`. */
export function applyBuyToPortfolio(opts: {
  account: string;
  symbol: string;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): void {
  applyBuyCore(EQUITY, {
    account: opts.account,
    key: [opts.symbol],
    shares: opts.shares,
    fillPrice: opts.fillPrice,
    nowIso: opts.nowIso,
  });
}

/** Apply a sell — realized P&L (cents-rounded) + full-exit semantics in `applySellCore`. */
export function applySellToPortfolio(opts: {
  account: string;
  symbol: string;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): { realizedPnl: number; fullyExited: boolean } {
  return applySellCore(EQUITY, {
    account: opts.account,
    key: [opts.symbol],
    shares: opts.shares,
    fillPrice: opts.fillPrice,
    nowIso: opts.nowIso,
  });
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export function insertFill(
  row: FillInsertBase & { symbol: string; commission: number },
): void {
  insertFillCore(EQUITY, {
    ...row,
    instrument: { symbol: row.symbol },
    commission: row.commission,
  });
}

export interface ReadFillsOpts {
  account?: string;
  symbol?: string;
  since?: string;
  limit?: number;
}

export function readFills(opts: ReadFillsOpts = {}): PaperFillRow[] {
  return readFillsCore<PaperFillRow>(EQUITY, {
    account: opts.account ?? DEFAULT_ACCOUNT,
    filters: { symbol: opts.symbol },
    since: opts.since,
    limit: opts.limit,
  });
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
  return insertThesisRow(
    {
      thesisText,
      entrySignal: "weekly_rebalance",
      exitCondition: "next_weekly_rebalance",
      metadata,
    },
    nowIso,
  );
}

/** Back-link fills to their thesis row by fill_id UUID — see `linkFillsToThesisCore`. */
export function linkFillsToThesis(thesisId: number, fillIds: string[]): number {
  return linkFillsToThesisCore(EQUITY, thesisId, fillIds);
}
