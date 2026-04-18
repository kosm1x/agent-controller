/**
 * Watchlist auto-seed.
 *
 * Fires on `market_watchlist_add` and on `market_watchlist_reseed`. Fetches a
 * minimum history of weekly OHLCV bars via DataLayer, persists them, then runs
 * full signal detection over the fetched series and persists the resulting
 * firings. Idempotent: skips the fetch if enough fresh rows already exist.
 *
 * This exists because F7 (alpha combination) and F7.5 (backtester) both assume
 * every active watchlist symbol has ≥ minBars of weekly history and non-empty
 * market_signals coverage. Without auto-seed, "add a symbol" leaves those
 * downstream tools blind until some other path backfills the bars.
 */

import { getDatabase } from "../db/index.js";
import { detectAllSignals, persistSignals } from "./signals.js";
import { getDataLayer } from "./data-layer.js";

export interface SeedOptions {
  /** Minimum weekly bars that must be present for us to skip re-fetching. */
  minBars?: number;
  /** Requested lookback when we do fetch. Bounded by provider history (~1000 weeks). */
  lookback?: number;
}

export interface SeedResult {
  symbol: string;
  skipped: boolean;
  barsBefore: number;
  barsAfter: number;
  barsInserted: number;
  signalsInserted: number;
  error?: string;
}

export const WATCHLIST_SEED_DEFAULTS = {
  minBars: 300, // ~5.7 years of weekly history — covers CPCV N=6 w/ margin
  lookback: 520, // ~10 years; AV weekly returns full history, we just slice
} as const;

function countWeeklyBars(symbol: string): number {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM market_data
       WHERE symbol = ? AND interval = 'weekly'`,
    )
    .get(symbol) as { n: number };
  return row.n;
}

/**
 * Seed a single symbol's weekly bars + detected signals.
 *
 * Behavior:
 *  - If `countWeeklyBars(symbol) >= minBars`: return `{ skipped: true }`
 *    without touching the provider.
 *  - Otherwise: fetch via `DataLayer.getWeekly({ lookback })`, then run
 *    `detectAllSignals()` over the returned bars and persist each firing.
 *  - Any provider-side error is captured in the result and returned — the
 *    caller (e.g. `market_watchlist_add`) must decide whether the absence
 *    of history blocks the watchlist row.
 */
export async function seedSymbol(
  rawSymbol: string,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const minBars = opts.minBars ?? WATCHLIST_SEED_DEFAULTS.minBars;
  const lookback = opts.lookback ?? WATCHLIST_SEED_DEFAULTS.lookback;

  // Audit C1 round 1: every path (including countWeeklyBars' DB call) must
  // return a structured SeedResult — callers treat this function as non-throwing
  // so an uncaught error here leaks out of market_watchlist_add after the
  // watchlist row was already inserted.
  let before = 0;
  let signalsInserted = 0;
  try {
    before = countWeeklyBars(symbol);
    if (before >= minBars) {
      return {
        symbol,
        skipped: true,
        barsBefore: before,
        barsAfter: before,
        barsInserted: 0,
        signalsInserted: 0,
      };
    }

    const layer = getDataLayer();
    const fetched = await layer.getWeekly(symbol, { lookback });
    const after = countWeeklyBars(symbol);
    const barsInserted = Math.max(0, after - before);

    if (fetched.bars.length > 0) {
      // Signal detection runs on the full series we just got back (DataLayer
      // persists as a side effect; we don't need to re-read from the DB).
      const signals = detectAllSignals(fetched.bars);
      signalsInserted = persistSignals(signals);
    }

    return {
      symbol,
      skipped: false,
      barsBefore: before,
      barsAfter: after,
      barsInserted,
      signalsInserted,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Best-effort re-count; if countWeeklyBars itself is what failed, stay at 0.
    let after = before;
    try {
      after = countWeeklyBars(symbol);
    } catch {
      /* ignore */
    }
    return {
      symbol,
      skipped: false,
      barsBefore: before,
      barsAfter: after,
      barsInserted: Math.max(0, after - before),
      signalsInserted,
      error: errorMsg,
    };
  }
}

export function formatSeedResult(r: SeedResult): string {
  if (r.error) {
    return `  ${r.symbol}: seed error — ${r.error} (bars: ${r.barsBefore} → ${r.barsAfter})`;
  }
  if (r.skipped) {
    return `  ${r.symbol}: skipped (${r.barsBefore} bars already present)`;
  }
  return `  ${r.symbol}: +${r.barsInserted} bars, +${r.signalsInserted} signals (${r.barsBefore} → ${r.barsAfter})`;
}
