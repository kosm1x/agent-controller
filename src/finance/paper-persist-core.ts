/**
 * Phase 4.5 — venue-parameterized persistence core for paper trading.
 *
 * `paper-persist.ts` (equity, `paper_*` tables) and `pm-paper-persist.ts`
 * (Polymarket, `pm_paper_*` tables) were 1:1 structural clones. This module
 * holds the shared CRUD + ledger math once, parameterized by a `VenueConfig`
 * (table names, cash column, instrument key columns). The venue files remain
 * as thin wrappers preserving their existing exports, so call sites and tests
 * are untouched.
 *
 * SQL identifiers (table/column names) are interpolated only from the static
 * `VenueConfig` constants defined in the two wrappers — never from caller
 * input. All values still bind via `?` placeholders.
 */

import { getDatabase } from "../db/index.js";

// ---------------------------------------------------------------------------
// Money precision
// ---------------------------------------------------------------------------

/**
 * Ledger money precision: cents.
 *
 * The paper ledgers store money as SQLite REAL (JS float), and raw
 * `(fillPrice - avg_cost) * shares` accumulates binary-float error into
 * reported P&L (e.g. `(0.5 - 0.4) * 60 === 5.999999999999999`). Every
 * realized-P&L value is rounded to cents at the ledger-write boundary, so
 * stored and returned P&L is exact to $0.01 with a residual error < $0.005
 * per fill. `avg_cost` deliberately stays at full float precision — it is a
 * per-share entry basis (PM prices are ≤ $1 with meaningful sub-cent
 * precision), not a ledger money amount.
 *
 * Full integer-cents storage would remove the float substrate entirely but
 * needs a schema migration on live tables — deferred.
 */
export function roundMoney(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Realized P&L for a sell — the single place ledger P&L is computed.
 * Rounded to ledger precision (cents); see `roundMoney`.
 */
export function computeRealizedPnl(
  fillPrice: number,
  avgCost: number,
  shares: number,
): number {
  return roundMoney((fillPrice - avgCost) * shares);
}

/** Below this remaining-share tolerance a sell counts as a full exit. */
const EXIT_TOL = 1e-9;

// ---------------------------------------------------------------------------
// Venue config
// ---------------------------------------------------------------------------

export interface VenueConfig {
  balanceTable: string;
  /** Cash column on the balance table ("cash" equity / "cash_usdc" PM). */
  cashColumn: string;
  portfolioTable: string;
  fillsTable: string;
  /**
   * Instrument-identity columns, in WHERE / ORDER BY order:
   * `["symbol"]` (equity) or `["market_id", "outcome"]` (PM).
   */
  keyColumns: readonly string[];
  /**
   * Function-name label for the insufficient-shares error, keeping each
   * venue's message byte-identical to its pre-refactor wording.
   */
  sellLabel: string;
}

/** `account = ? AND <key cols> = ?` — shared WHERE clause for one position. */
function whereKey(cfg: VenueConfig): string {
  return ["account", ...cfg.keyColumns].map((c) => `${c} = ?`).join(" AND ");
}

// ---------------------------------------------------------------------------
// Shared row shapes (venue wrappers extend these with their key columns)
// ---------------------------------------------------------------------------

export interface BalanceRowBase {
  account: string;
  initial_cash: number;
  last_updated: string;
}

export interface PortfolioRowBase {
  id: number;
  account: string;
  shares: number;
  avg_cost: number;
  opened_at: string;
  last_updated: string;
}

export interface FillRowBase {
  id: number;
  fill_id: string;
  thesis_id: number | null;
  account: string;
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

/**
 * Return the balance row for an account, inserting a default row if one
 * doesn't already exist. Safe to call multiple times (idempotent).
 */
export function initAccountCore<Row>(
  cfg: VenueConfig,
  account: string,
  initialCash: number,
): Row {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO ${cfg.balanceTable} (account, ${cfg.cashColumn}, initial_cash)
     VALUES (?, ?, ?)`,
  ).run(account, initialCash, initialCash);
  return readBalanceCore<Row>(cfg, account)!;
}

export function readBalanceCore<Row>(
  cfg: VenueConfig,
  account: string,
): Row | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM ${cfg.balanceTable} WHERE account = ?`)
    .get(account) as Row | undefined;
  return row ?? null;
}

export function updateCashCore(
  cfg: VenueConfig,
  account: string,
  newCash: number,
  nowIso: string,
): void {
  getDatabase()
    .prepare(
      `UPDATE ${cfg.balanceTable} SET ${cfg.cashColumn} = ?, last_updated = ? WHERE account = ?`,
    )
    .run(newCash, nowIso, account);
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export function readPortfolioCore<Row>(
  cfg: VenueConfig,
  account: string,
): Row[] {
  const orderBy = cfg.keyColumns.map((c) => `${c} ASC`).join(", ");
  return getDatabase()
    .prepare(
      `SELECT * FROM ${cfg.portfolioTable} WHERE account = ? ORDER BY ${orderBy}`,
    )
    .all(account) as Row[];
}

export function readPositionCore<Row>(
  cfg: VenueConfig,
  account: string,
  key: readonly string[],
): Row | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM ${cfg.portfolioTable} WHERE ${whereKey(cfg)}`)
    .get(account, ...key) as Row | undefined;
  return row ?? null;
}

/**
 * Upsert a position after a buy. Recomputes weighted-average cost:
 *   new_avg = (old_shares × old_avg + fill_qty × fill_price) / (old_shares + fill_qty)
 *
 * `avg_cost` stays at full float precision (per-share basis, not a ledger
 * money amount — see `roundMoney`).
 */
export function applyBuyCore(
  cfg: VenueConfig,
  opts: {
    account: string;
    /** Values for `cfg.keyColumns`, in the same order. */
    key: readonly string[];
    /** Columns written only on first insert (e.g. PM token_id / slug). */
    insertExtras?: Record<string, string | null>;
    shares: number;
    fillPrice: number;
    nowIso: string;
  },
): void {
  const db = getDatabase();
  const existing = readPositionCore<PortfolioRowBase>(
    cfg,
    opts.account,
    opts.key,
  );
  if (!existing) {
    const extras = opts.insertExtras ?? {};
    const cols = [
      "account",
      ...cfg.keyColumns,
      ...Object.keys(extras),
      "shares",
      "avg_cost",
      "opened_at",
      "last_updated",
    ];
    db.prepare(
      `INSERT INTO ${cfg.portfolioTable} (${cols.join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})`,
    ).run(
      opts.account,
      ...opts.key,
      ...Object.values(extras),
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
    `UPDATE ${cfg.portfolioTable}
       SET shares = ?, avg_cost = ?, last_updated = ?
     WHERE ${whereKey(cfg)}`,
  ).run(newShares, newAvg, opts.nowIso, opts.account, ...opts.key);
}

/**
 * Apply a sell. Returns realized P&L (cents-rounded at this ledger boundary
 * — see `computeRealizedPnl`). If the sell reduces shares to 0 (within
 * tolerance), the row is deleted — no stale zero-share rows carrying
 * avg_cost values forward.
 */
export function applySellCore(
  cfg: VenueConfig,
  opts: {
    account: string;
    /** Values for `cfg.keyColumns`, in the same order. */
    key: readonly string[];
    shares: number;
    fillPrice: number;
    nowIso: string;
  },
): { realizedPnl: number; fullyExited: boolean } {
  const db = getDatabase();
  const existing = readPositionCore<PortfolioRowBase>(
    cfg,
    opts.account,
    opts.key,
  );
  if (!existing || existing.shares < opts.shares - 1e-9) {
    throw new Error(
      `${cfg.sellLabel}: insufficient shares for ${opts.key.join("/")} ` +
        `(held=${existing?.shares ?? 0}, asked=${opts.shares})`,
    );
  }
  const realizedPnl = computeRealizedPnl(
    opts.fillPrice,
    existing.avg_cost,
    opts.shares,
  );
  const remaining = existing.shares - opts.shares;
  if (remaining <= EXIT_TOL) {
    db.prepare(`DELETE FROM ${cfg.portfolioTable} WHERE ${whereKey(cfg)}`).run(
      opts.account,
      ...opts.key,
    );
    return { realizedPnl, fullyExited: true };
  }
  // avg_cost unchanged on sell (sells don't alter the weighted entry of
  // what's left).
  db.prepare(
    `UPDATE ${cfg.portfolioTable}
       SET shares = ?, last_updated = ?
     WHERE ${whereKey(cfg)}`,
  ).run(remaining, opts.nowIso, opts.account, ...opts.key);
  return { realizedPnl, fullyExited: false };
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/** Venue-independent fields of a fill insert (wrappers add instrument identity). */
export interface FillInsertBase {
  fillId: string;
  thesisId: number | null;
  account: string;
  side: "buy" | "sell";
  shares: number;
  fillPrice: number;
  grossNotional: number;
  slippageBps: number;
  realizedPnl: number | null;
  filledAt: string;
}

export function insertFillCore(
  cfg: VenueConfig,
  row: FillInsertBase & {
    /** Instrument identity + venue extras, in table column order. */
    instrument: Record<string, string | null>;
    /** Equity-only per-fill commission; column omitted when undefined. */
    commission?: number;
  },
): void {
  const hasCommission = row.commission !== undefined;
  const cols = [
    "fill_id",
    "thesis_id",
    "account",
    ...Object.keys(row.instrument),
    "side",
    "shares",
    "fill_price",
    "gross_notional",
    ...(hasCommission ? ["commission"] : []),
    "slippage_bps",
    "realized_pnl",
    "filled_at",
  ];
  getDatabase()
    .prepare(
      `INSERT INTO ${cfg.fillsTable} (${cols.join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(
      row.fillId,
      row.thesisId,
      row.account,
      ...Object.values(row.instrument),
      row.side,
      row.shares,
      row.fillPrice,
      row.grossNotional,
      ...(hasCommission ? [row.commission] : []),
      row.slippageBps,
      // Ledger-write boundary: persist P&L at cents precision (see roundMoney).
      row.realizedPnl === null ? null : roundMoney(row.realizedPnl),
      row.filledAt,
    );
}

export function readFillsCore<Row>(
  cfg: VenueConfig,
  opts: {
    account: string;
    /** column → value equality filters; falsy values are skipped. */
    filters?: Record<string, string | undefined>;
    since?: string;
    limit?: number;
  },
): Row[] {
  const conds: string[] = [`account = ?`];
  const params: unknown[] = [opts.account];
  for (const [col, val] of Object.entries(opts.filters ?? {})) {
    if (val) {
      conds.push(`${col} = ?`);
      params.push(val);
    }
  }
  if (opts.since) {
    conds.push(`filled_at >= ?`);
    params.push(opts.since);
  }
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 50));
  const sql = `SELECT * FROM ${cfg.fillsTable}
               WHERE ${conds.join(" AND ")}
               ORDER BY filled_at DESC
               LIMIT ${limit}`;
  return getDatabase()
    .prepare(sql)
    .all(...params) as Row[];
}

/**
 * Back-link a set of fills to their thesis row by fill_id UUID. Matching by
 * fill_id (not by time window) avoids misattributing fills from a concurrent
 * rebalance — the audit-R2-4 fix to the earlier time-window approach.
 */
export function linkFillsToThesisCore(
  cfg: VenueConfig,
  thesisId: number,
  fillIds: string[],
): number {
  if (fillIds.length === 0) return 0;
  const placeholders = fillIds.map(() => "?").join(",");
  const result = getDatabase()
    .prepare(
      `UPDATE ${cfg.fillsTable}
         SET thesis_id = ?
       WHERE fill_id IN (${placeholders})`,
    )
    .run(thesisId, ...fillIds);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Thesis writes (both venues reuse the existing trade_theses table)
// ---------------------------------------------------------------------------

/**
 * Insert one `trade_theses` row tagging a rebalance. `symbol='PORTFOLIO'` is
 * the sentinel for multi-symbol rebalances; `outcome='open'` always. The
 * venue wrappers build the JSON payloads + entry_signal/exit_condition.
 * Returns the inserted row id so fills can link back.
 */
export function insertThesisRow(
  row: {
    thesisText: string;
    entrySignal: string;
    exitCondition: string;
    metadata: string;
  },
  nowIso: string,
): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO trade_theses
        (symbol, thesis_text, entry_signal, entry_time, exit_condition,
         outcome, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "PORTFOLIO",
      row.thesisText,
      row.entrySignal,
      nowIso,
      row.exitCondition,
      "open",
      row.metadata,
    );
  return result.lastInsertRowid as number;
}
