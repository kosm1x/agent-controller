/**
 * F8.1b — persistence helpers for Polymarket paper trading.
 *
 * Thin PM-venue wrapper over `paper-persist-core.ts` (Phase 4.5): keyed by
 * `(market_id, outcome)` instead of `symbol`, USDC-denominated. Tables:
 * `pm_paper_balance`, `pm_paper_portfolio`, `pm_paper_fills`. Thesis rows
 * reuse `trade_theses` with `entry_signal='pm_weekly_rebalance'` +
 * `symbol='PORTFOLIO'` sentinel. Realized P&L is cents-rounded at the
 * ledger-write boundary — see `roundMoney` in the core. PM-specific
 * multi-outcome logic (marketOutcomeCount, complementOutcome) lives in
 * `pm-paper-executor.ts`.
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

export const DEFAULT_PM_ACCOUNT = "default";
export const DEFAULT_PM_INITIAL_CASH = 10_000; // USDC

const PM: VenueConfig = {
  balanceTable: "pm_paper_balance",
  cashColumn: "cash_usdc",
  portfolioTable: "pm_paper_portfolio",
  fillsTable: "pm_paper_fills",
  keyColumns: ["market_id", "outcome"],
  sellLabel: "applyPmSellToPortfolio",
};

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PmPaperBalanceRow extends BalanceRowBase {
  cash_usdc: number;
}

export interface PmPaperPortfolioRow extends PortfolioRowBase {
  market_id: string;
  outcome: string;
  token_id: string | null;
  slug: string | null;
}

export interface PmPaperFillRow extends FillRowBase {
  market_id: string;
  outcome: string;
  token_id: string | null;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export function initPmAccount(
  account: string = DEFAULT_PM_ACCOUNT,
  initialCash: number = DEFAULT_PM_INITIAL_CASH,
): PmPaperBalanceRow {
  return initAccountCore<PmPaperBalanceRow>(PM, account, initialCash);
}

export function readPmBalance(
  account: string = DEFAULT_PM_ACCOUNT,
): PmPaperBalanceRow | null {
  return readBalanceCore<PmPaperBalanceRow>(PM, account);
}

export function updatePmCash(
  account: string,
  newCash: number,
  nowIso: string,
): void {
  updateCashCore(PM, account, newCash, nowIso);
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export function readPmPortfolio(
  account: string = DEFAULT_PM_ACCOUNT,
): PmPaperPortfolioRow[] {
  return readPortfolioCore<PmPaperPortfolioRow>(PM, account);
}

export function readPmPosition(
  account: string,
  marketId: string,
  outcome: string,
): PmPaperPortfolioRow | null {
  return readPositionCore<PmPaperPortfolioRow>(PM, account, [
    marketId,
    outcome,
  ]);
}

/** Upsert a position after a buy — weighted-average cost math in `applyBuyCore`. */
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
  applyBuyCore(PM, {
    account: opts.account,
    key: [opts.marketId, opts.outcome],
    insertExtras: { token_id: opts.tokenId, slug: opts.slug },
    shares: opts.shares,
    fillPrice: opts.fillPrice,
    nowIso: opts.nowIso,
  });
}

/** Apply a sell — realized P&L (cents-rounded) + full-exit semantics in `applySellCore`. */
export function applyPmSellToPortfolio(opts: {
  account: string;
  marketId: string;
  outcome: string;
  shares: number;
  fillPrice: number;
  nowIso: string;
}): { realizedPnl: number; fullyExited: boolean } {
  return applySellCore(PM, {
    account: opts.account,
    key: [opts.marketId, opts.outcome],
    shares: opts.shares,
    fillPrice: opts.fillPrice,
    nowIso: opts.nowIso,
  });
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export function insertPmFill(
  row: FillInsertBase & {
    marketId: string;
    outcome: string;
    tokenId: string | null;
  },
): void {
  insertFillCore(PM, {
    ...row,
    instrument: {
      market_id: row.marketId,
      outcome: row.outcome,
      token_id: row.tokenId,
    },
  });
}

export interface ReadPmFillsOpts {
  account?: string;
  marketId?: string;
  outcome?: string;
  since?: string;
  limit?: number;
}

export function readPmFills(opts: ReadPmFillsOpts = {}): PmPaperFillRow[] {
  return readFillsCore<PmPaperFillRow>(PM, {
    account: opts.account ?? DEFAULT_PM_ACCOUNT,
    filters: { market_id: opts.marketId, outcome: opts.outcome },
    since: opts.since,
    limit: opts.limit,
  });
}

/** Back-link PM fills to a thesis row by fill_id UUID — see `linkFillsToThesisCore`. */
export function linkPmFillsToThesis(
  thesisId: number,
  fillIds: string[],
): number {
  return linkFillsToThesisCore(PM, thesisId, fillIds);
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
  /**
   * Rebalance cadence — drives `trade_theses.entry_signal` so audit queries
   * can separate weekly from daily runs. Defaults to "weekly" for backward
   * compat with F8.1b callers that don't pass the param.
   */
  cadence?: "weekly" | "daily";
}

export function insertPmPortfolioThesis(
  input: PmPortfolioThesisInput,
  nowIso: string,
): number {
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
  return insertThesisRow(
    {
      thesisText,
      entrySignal: `pm_${input.cadence ?? "weekly"}_rebalance`,
      exitCondition: "next_pm_rebalance",
      metadata,
    },
    nowIso,
  );
}
