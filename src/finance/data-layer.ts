/**
 * DataLayer — unified facade over AlphaVantage + Polygon + FRED.
 *
 * Responsibilities:
 *   1. Cache — L1 in-memory (TTL), L2 market_data DB table
 *   2. Dispatch — primary (AV) with fallback (Polygon); macro via FRED
 *   3. Persist — every fetched bar lands in market_data
 *   4. Validate — H2 validation on every bar before insert
 *   5. Watchlist CRUD — add/remove/list with budget-overflow guard
 *   6. In-flight dedup — concurrent callers share one fetch Promise
 *
 * Does NOT:
 *   - Calculate indicators (F2)
 *   - Detect signals (F3)
 *   - Classify regime (F5)
 */

import { getDatabase } from "../db/index.js";
import {
  DataUnavailableError,
  RateLimitedError,
  type AssetClass,
  type FetchResult,
  type IntradayInterval,
  type MacroPoint,
  type MarketBar,
  type Provider,
  type WatchlistRow,
  SymbolError,
} from "./types.js";
import { AlphaVantageAdapter } from "./adapters/alpha-vantage.js";
import { PolygonAdapter } from "./adapters/polygon.js";
import { FredAdapter } from "./adapters/fred.js";
import { validateMarketBar } from "./validation.js";
import { canCall } from "./rate-limit.js";
import {
  AV_TIER1_DAILY_CEILING,
  projectedDailyAvCalls,
  recordBudget,
} from "./budget.js";

// L1 cache entry. `ts` is the wall-clock millis when populated.
interface CacheEntry {
  ts: number;
  bars: MarketBar[];
}

const DAILY_TTL_MS = 24 * 60 * 60 * 1000;
// Weekly bars refresh Friday after close. A 5-day TTL guarantees the cache
// expires before the next Friday no matter when it was populated (audit W4).
const WEEKLY_TTL_MS = 5 * 24 * 60 * 60 * 1000;
/** L2 freshness floor: accept stored rows if within 5% of the requested lookback. */
const WEEKLY_L2_FRESHNESS_FLOOR = 0.95;
const INTRADAY_TTL_MS = 10 * 60 * 1000;
const MACRO_TTL_MS = 6 * 60 * 60 * 1000;
/** Max L1 entries. Evicts oldest insert (FIFO) on overflow to bound memory. */
const L1_MAX_ENTRIES = 500;

export class DataLayer {
  private readonly l1 = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<MarketBar[]>>();
  private readonly macroL1 = new Map<
    string,
    { ts: number; points: MacroPoint[] }
  >();

  constructor(
    private readonly av: AlphaVantageAdapter | null,
    private readonly polygon: PolygonAdapter | null,
    private readonly fred: FredAdapter | null,
  ) {}

  static fromConfig(): DataLayer {
    // Each adapter is optional — if the key isn't set, that provider is absent.
    let av: AlphaVantageAdapter | null = null;
    let polygon: PolygonAdapter | null = null;
    let fred: FredAdapter | null = null;
    try {
      av = AlphaVantageAdapter.fromConfig();
    } catch {
      /* primary absent — only Polygon will serve */
    }
    try {
      polygon = PolygonAdapter.fromConfig();
    } catch {
      /* fallback absent — AV-only mode */
    }
    try {
      fred = FredAdapter.fromConfig();
    } catch {
      /* macro disabled */
    }
    return new DataLayer(av, polygon, fred);
  }

  // -------------------------------------------------------------------------
  // Daily bars
  // -------------------------------------------------------------------------

  async getDaily(
    rawSymbol: string,
    opts: { lookback: number },
  ): Promise<FetchResult<MarketBar>> {
    const symbol = normalizeSymbol(rawSymbol, "equity");
    const key = `daily:${symbol}:${opts.lookback}`;
    const cached = this.l1Lookup(key, DAILY_TTL_MS);
    if (cached) {
      return { bars: cached, provider: cached[0]?.provider ?? "alpha_vantage" };
    }

    // L2: DB. If we have enough fresh rows, return them.
    const dbRows = this.dbDaily(symbol, opts.lookback);
    if (dbRows.length === opts.lookback) {
      const newest = dbRows[dbRows.length - 1];
      const age = Date.now() - Date.parse(newest.timestamp);
      if (age < DAILY_TTL_MS) {
        this.l1Set(key, dbRows);
        return { bars: dbRows, provider: newest.provider };
      }
    }

    // In-flight dedup
    const existing = this.inflight.get(key);
    if (existing) {
      const bars = await existing;
      return { bars, provider: bars[0]?.provider ?? "alpha_vantage" };
    }

    const fetchPromise = this.fetchDailyDispatch(symbol, opts.lookback, dbRows);
    this.inflight.set(key, fetchPromise);
    try {
      const bars = await fetchPromise;
      this.l1Set(key, bars);
      const stale = bars.length > 0 && bars === dbRows;
      return {
        bars,
        provider: bars[0]?.provider ?? "alpha_vantage",
        stale: stale ? true : undefined,
      };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchDailyDispatch(
    symbol: string,
    lookback: number,
    dbFallback: MarketBar[],
  ): Promise<MarketBar[]> {
    const attempts: { provider: Provider; reason: string }[] = [];

    if (this.av && canCall("alpha_vantage")) {
      try {
        const bars = await this.av.fetchDaily(symbol, { lookback });
        this.persistBars(bars);
        return bars;
      } catch (err) {
        attempts.push({
          provider: "alpha_vantage",
          reason: err instanceof Error ? err.message : String(err),
        });
        if (!(err instanceof RateLimitedError)) {
          // Non-rate-limit error: still try Polygon
        }
      }
    } else if (this.av) {
      attempts.push({ provider: "alpha_vantage", reason: "rate limited" });
    } else {
      attempts.push({ provider: "alpha_vantage", reason: "not configured" });
    }

    if (this.polygon && canCall("polygon")) {
      try {
        const bars = await this.polygon.fetchDaily(symbol, { lookback });
        this.persistBars(bars);
        return bars;
      } catch (err) {
        attempts.push({
          provider: "polygon",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (this.polygon) {
      attempts.push({ provider: "polygon", reason: "rate limited" });
    } else {
      attempts.push({ provider: "polygon", reason: "not configured" });
    }

    // Last resort: stale DB rows
    if (dbFallback.length > 0) {
      return dbFallback;
    }
    throw new DataUnavailableError(attempts);
  }

  // -------------------------------------------------------------------------
  // Weekly bars
  // -------------------------------------------------------------------------

  async getWeekly(
    rawSymbol: string,
    opts: { lookback: number },
  ): Promise<FetchResult<MarketBar>> {
    const symbol = normalizeSymbol(rawSymbol, "equity");
    const key = `weekly:${symbol}:${opts.lookback}`;
    const cached = this.l1Lookup(key, WEEKLY_TTL_MS);
    if (cached) {
      return { bars: cached, provider: cached[0]?.provider ?? "alpha_vantage" };
    }

    const dbRows = this.dbBars(symbol, "weekly", opts.lookback);
    // Audit W4 round 1: accept L2 when count is within 5% of requested lookback.
    // Exact-match-only would force a re-fetch for every call when DB is short
    // by a single row — thrashes AV + burns through rate limit.
    const l2Floor = Math.floor(opts.lookback * WEEKLY_L2_FRESHNESS_FLOOR);
    if (dbRows.length >= l2Floor) {
      const newest = dbRows[dbRows.length - 1]!;
      const age = Date.now() - Date.parse(newest.timestamp);
      if (age < WEEKLY_TTL_MS) {
        this.l1Set(key, dbRows);
        return { bars: dbRows, provider: newest.provider };
      }
    }

    const existing = this.inflight.get(key);
    if (existing) {
      const bars = await existing;
      return { bars, provider: bars[0]?.provider ?? "alpha_vantage" };
    }

    const fetchPromise = this.fetchWeeklyDispatch(
      symbol,
      opts.lookback,
      dbRows,
    );
    this.inflight.set(key, fetchPromise);
    try {
      const bars = await fetchPromise;
      this.l1Set(key, bars);
      const stale = bars.length > 0 && bars === dbRows;
      return {
        bars,
        provider: bars[0]?.provider ?? "alpha_vantage",
        stale: stale ? true : undefined,
      };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchWeeklyDispatch(
    symbol: string,
    lookback: number,
    dbFallback: MarketBar[],
  ): Promise<MarketBar[]> {
    const attempts: { provider: Provider; reason: string }[] = [];

    if (this.av?.fetchWeekly && canCall("alpha_vantage")) {
      try {
        const bars = await this.av.fetchWeekly(symbol, { lookback });
        this.persistBars(bars);
        return bars;
      } catch (err) {
        attempts.push({
          provider: "alpha_vantage",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (this.av?.fetchWeekly) {
      attempts.push({ provider: "alpha_vantage", reason: "rate limited" });
    } else {
      attempts.push({
        provider: "alpha_vantage",
        reason: "weekly endpoint not supported",
      });
    }

    // Polygon weekly fallback is not implemented at F1 — skip.
    attempts.push({
      provider: "polygon",
      reason: "weekly endpoint not supported",
    });

    if (dbFallback.length > 0) return dbFallback;
    throw new DataUnavailableError(attempts);
  }

  // -------------------------------------------------------------------------
  // Intraday bars
  // -------------------------------------------------------------------------

  async getIntraday(
    rawSymbol: string,
    interval: IntradayInterval,
    opts: { lookback: number },
  ): Promise<FetchResult<MarketBar>> {
    const symbol = normalizeSymbol(rawSymbol, "equity");
    const key = `intra:${symbol}:${interval}:${opts.lookback}`;
    const cached = this.l1Lookup(key, INTRADAY_TTL_MS);
    if (cached) {
      return { bars: cached, provider: cached[0]?.provider ?? "alpha_vantage" };
    }
    const existing = this.inflight.get(key);
    if (existing) {
      const bars = await existing;
      return { bars, provider: bars[0]?.provider ?? "alpha_vantage" };
    }
    const p = this.fetchIntradayDispatch(symbol, interval, opts.lookback);
    this.inflight.set(key, p);
    try {
      const bars = await p;
      this.l1Set(key, bars);
      return { bars, provider: bars[0]?.provider ?? "alpha_vantage" };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchIntradayDispatch(
    symbol: string,
    interval: IntradayInterval,
    lookback: number,
  ): Promise<MarketBar[]> {
    const attempts: { provider: Provider; reason: string }[] = [];
    if (this.av && canCall("alpha_vantage")) {
      try {
        const bars = await this.av.fetchIntraday(symbol, interval, {
          lookback,
        });
        this.persistBars(bars);
        return bars;
      } catch (err) {
        attempts.push({
          provider: "alpha_vantage",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (this.polygon && canCall("polygon")) {
      try {
        const bars = await this.polygon.fetchIntraday(symbol, interval, {
          lookback,
        });
        this.persistBars(bars);
        return bars;
      } catch (err) {
        attempts.push({
          provider: "polygon",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw new DataUnavailableError(attempts);
  }

  // -------------------------------------------------------------------------
  // Macro
  // -------------------------------------------------------------------------

  async getMacro(rawSeries: string): Promise<MacroPoint[]> {
    const series = normalizeSymbol(rawSeries, "macro");
    const cached = this.macroL1.get(series);
    if (cached && Date.now() - cached.ts < MACRO_TTL_MS) {
      return cached.points;
    }
    // FRED-native series (VIXCLS, ICSA, M2SL) → FRED
    const fredSeries = new Set(["VIXCLS", "ICSA", "M2SL"]);
    if (fredSeries.has(series)) {
      if (!this.fred) {
        throw new Error(
          `FRED adapter not configured — cannot fetch macro series ${series}`,
        );
      }
      const points = await this.fred.fetchMacro(series);
      this.macroL1.set(series, { ts: Date.now(), points });
      return points;
    }
    // Everything else → Alpha Vantage macro
    if (!this.av) {
      throw new Error(
        `Alpha Vantage adapter not configured — cannot fetch macro series ${series}`,
      );
    }
    const points = await this.av.fetchMacro(series);
    this.macroL1.set(series, { ts: Date.now(), points });
    return points;
  }

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  async getQuote(rawSymbol: string): Promise<MarketBar> {
    const symbol = normalizeSymbol(rawSymbol, "equity");
    if (!this.av) {
      throw new Error(
        "Alpha Vantage not configured — market_quote requires AV",
      );
    }
    return this.av.fetchQuote(symbol);
  }

  // -------------------------------------------------------------------------
  // Watchlist CRUD
  // -------------------------------------------------------------------------

  addToWatchlist(args: {
    symbol: string;
    assetClass: AssetClass;
    name?: string;
    tags?: string[];
    notes?: string;
  }): WatchlistRow {
    const symbol = normalizeSymbol(args.symbol, args.assetClass);
    const db = getDatabase();

    // Budget preview: refuse if projected daily > 80% of tier 1
    const currentSize = (
      db
        .prepare("SELECT COUNT(*) AS n FROM watchlist WHERE active=1")
        .get() as {
        n: number;
      }
    ).n;
    const projected = projectedDailyAvCalls(currentSize + 1);
    if (projected > AV_TIER1_DAILY_CEILING) {
      throw new Error(
        `Adding ${symbol} would push projected daily AV usage to ${projected}/${AV_TIER1_DAILY_CEILING} calls — above 80% ceiling. Upgrade tier or remove a symbol first.`,
      );
    }

    db.prepare(
      `INSERT INTO watchlist (symbol, name, asset_class, tags, notes, active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(symbol) DO UPDATE SET
         name = excluded.name,
         asset_class = excluded.asset_class,
         tags = excluded.tags,
         notes = excluded.notes,
         active = 1`,
    ).run(
      symbol,
      args.name ?? null,
      args.assetClass,
      JSON.stringify(args.tags ?? []),
      args.notes ?? null,
    );

    return this.getWatchlistEntry(symbol)!;
  }

  removeFromWatchlist(rawSymbol: string): boolean {
    // Try equity normalize first; if it fails, fall back to raw uppercase
    // (some macro series names like "FEDFUNDS" are valid for removal but don't
    // match the equity regex).
    let symbol: string;
    try {
      symbol = normalizeSymbol(rawSymbol, "equity");
    } catch {
      symbol = rawSymbol.trim().toUpperCase();
      if (!/^[A-Z0-9_]{2,20}$/.test(symbol)) {
        throw new SymbolError(rawSymbol, `Invalid symbol: '${rawSymbol}'`);
      }
    }
    const db = getDatabase();
    const result = db
      .prepare("UPDATE watchlist SET active=0 WHERE symbol=? AND active=1")
      .run(symbol);
    return result.changes > 0;
  }

  listWatchlist(): WatchlistRow[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        "SELECT symbol, name, asset_class, tags, notes, added_at, active FROM watchlist WHERE active=1 ORDER BY asset_class, symbol",
      )
      .all() as {
      symbol: string;
      name: string | null;
      asset_class: AssetClass;
      tags: string;
      notes: string | null;
      added_at: string;
      active: number;
    }[];
    return rows.map((r) => ({
      symbol: r.symbol,
      name: r.name ?? undefined,
      assetClass: r.asset_class,
      tags: safeJsonArray(r.tags),
      active: r.active === 1,
      addedAt: r.added_at,
      notes: r.notes ?? undefined,
    }));
  }

  private getWatchlistEntry(symbol: string): WatchlistRow | null {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT symbol, name, asset_class, tags, notes, added_at, active FROM watchlist WHERE symbol=?",
      )
      .get(symbol) as
      | {
          symbol: string;
          name: string | null;
          asset_class: AssetClass;
          tags: string;
          notes: string | null;
          added_at: string;
          active: number;
        }
      | undefined;
    if (!row) return null;
    return {
      symbol: row.symbol,
      name: row.name ?? undefined,
      assetClass: row.asset_class,
      tags: safeJsonArray(row.tags),
      active: row.active === 1,
      addedAt: row.added_at,
      notes: row.notes ?? undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private l1Lookup(key: string, ttl: number): MarketBar[] | null {
    const entry = this.l1.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > ttl) {
      this.l1.delete(key);
      return null;
    }
    return entry.bars;
  }

  private l1Set(key: string, bars: MarketBar[]): void {
    // FIFO eviction: Map iteration order is insertion order, so the first
    // key is the oldest. This caps memory without an LRU library.
    if (this.l1.size >= L1_MAX_ENTRIES) {
      const oldest = this.l1.keys().next().value;
      if (oldest !== undefined) this.l1.delete(oldest);
    }
    this.l1.set(key, { ts: Date.now(), bars });
  }

  private dbDaily(symbol: string, lookback: number): MarketBar[] {
    return this.dbBars(symbol, "daily", lookback);
  }

  /**
   * Generalized L2 read. Caller picks the interval; SQL filter matches.
   * Used by getDaily / getWeekly; getIntraday goes through a separate path
   * because intraday bars are never persisted to L2 (TTL too short).
   *
   * Ordering invariant: `ORDER BY timestamp DESC LIMIT ?` + `.reverse()` means
   * the returned slice always ENDS with the newest bar available. Callers
   * that check the L2 freshness floor (getWeekly) rely on this to guarantee
   * the most recent bar is present whenever the returned length clears the
   * floor. Do not change the ORDER clause without updating those callers.
   */
  private dbBars(
    symbol: string,
    interval: "daily" | "weekly" | "monthly",
    lookback: number,
  ): MarketBar[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT symbol, provider, interval, timestamp, open, high, low, close, volume, adjusted_close
         FROM market_data
         WHERE symbol=? AND interval=?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(symbol, interval, lookback) as {
      symbol: string;
      provider: Provider;
      interval: "daily" | "weekly" | "monthly";
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      adjusted_close: number | null;
    }[];
    return rows
      .map((r) => ({
        symbol: r.symbol,
        provider: r.provider,
        interval: r.interval,
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        adjustedClose: r.adjusted_close ?? undefined,
      }))
      .reverse();
  }

  private persistBars(bars: MarketBar[]): void {
    if (bars.length === 0) return;
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO market_data
        (symbol, provider, interval, timestamp, open, high, low, close, volume, adjusted_close)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Audit C2 round 1: wrap inserts in a single transaction. Without this,
    // each insert.run is an implicit auto-commit → fsync-per-row. Auto-seed
    // writes ~520 weekly bars × 10 symbols on first-use; non-transactional
    // writes block the LLM tool dispatch loop for multiple seconds.
    const tx = db.transaction((all: MarketBar[]) => {
      let prev: MarketBar | undefined;
      const prevVols: number[] = [];
      for (const bar of all) {
        const outcome = validateMarketBar(bar, {
          previousBar: prev,
          previousVolumes: prevVols.slice(-5),
        });
        if (!outcome.valid) {
          recordBudget({
            provider: bar.provider,
            endpoint: "validate",
            status: "error",
          });
          continue; // Skip invalid; don't poison the table
        }
        insert.run(
          bar.symbol,
          bar.provider,
          bar.interval,
          bar.timestamp,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.adjustedClose ?? null,
        );
        prev = bar;
        prevVols.push(bar.volume);
        if (prevVols.length > 10) prevVols.shift();
      }
    });
    tx(bars);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a symbol string for storage.
 *  - Trim + uppercase
 *  - Equity/ETF: [A-Z][A-Z0-9.-]{0,9}
 *  - FX: strip separators, must be 6 letters (EURUSD)
 *  - Macro: keep as-is after uppercase (FEDFUNDS, VIXCLS, CPI, etc.)
 *  - Crypto: deferred (F10)
 */
export function normalizeSymbol(raw: string, assetClass: AssetClass): string {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) throw new SymbolError(raw, "Symbol is empty");

  if (assetClass === "fx") {
    const stripped = trimmed.replace(/[\s/_-]/g, "");
    if (!/^[A-Z]{6}$/.test(stripped)) {
      throw new SymbolError(
        raw,
        `FX symbol must be 6 letters (e.g. EURUSD). Got '${raw}'.`,
      );
    }
    return stripped;
  }
  if (assetClass === "macro") {
    if (!/^[A-Z0-9_]{2,20}$/.test(trimmed)) {
      throw new SymbolError(
        raw,
        `Macro series must be an AV/FRED ID (e.g. FEDFUNDS, VIXCLS). Got '${raw}'.`,
      );
    }
    return trimmed;
  }
  // equity / etf / commodity / crypto
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(trimmed)) {
    throw new SymbolError(
      raw,
      `Symbol '${raw}' is not a valid ticker. Use SPY, AAPL, BRK.B format.`,
    );
  }
  return trimmed;
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Singleton accessor
let _instance: DataLayer | null = null;
export function getDataLayer(): DataLayer {
  if (!_instance) _instance = DataLayer.fromConfig();
  return _instance;
}

export function __resetDataLayerForTests(): void {
  _instance = null;
}
