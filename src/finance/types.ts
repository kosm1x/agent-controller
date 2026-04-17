/**
 * F1 Data Layer — shared types.
 *
 * Stable contract between adapters (AlphaVantage / Polygon / FRED),
 * the DataLayer facade, and the 6 finance tools. Changes here cascade
 * to every finance consumer, so edit with care.
 */

export type AssetClass =
  | "equity"
  | "etf"
  | "fx"
  | "commodity"
  | "crypto"
  | "macro";

export type Interval =
  | "1min"
  | "5min"
  | "15min"
  | "60min"
  | "daily"
  | "weekly"
  | "monthly";

export type IntradayInterval = "1min" | "5min" | "15min" | "60min";

export type Provider = "alpha_vantage" | "polygon" | "fmp" | "fred" | "manual";

export type BudgetStatus = "success" | "rate_limited" | "error" | "timeout";

/**
 * Single OHLCV bar. Timestamp is ISO 8601 America/New_York.
 * `adjustedClose` is present when the provider supplies split/dividend-adjusted data.
 */
export interface MarketBar {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose?: number;
  provider: Provider;
  interval: Interval;
}

/** Daily macro observation. Date-only — no TZ, no time component. */
export interface MacroPoint {
  series: string;
  date: string;
  value: number;
  provider: Provider;
}

export interface WatchlistRow {
  symbol: string;
  name?: string;
  assetClass: AssetClass;
  tags: string[];
  active: boolean;
  addedAt: string;
  notes?: string;
}

/** Fetch envelope. `gaps` lists expected-but-missing timestamps; `stale` means DB cache fallback. */
export interface FetchResult<T> {
  bars: T[];
  gaps?: string[];
  stale?: boolean;
  provider: Provider;
}

export interface BudgetEntry {
  provider: Provider;
  endpoint: string;
  status: BudgetStatus;
  responseTimeMs?: number;
  costUnits?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RateLimitedError extends Error {
  readonly provider: Provider;
  readonly retryAfterMs?: number;
  constructor(provider: Provider, retryAfterMs?: number) {
    super(`Rate limited by ${provider}`);
    this.name = "RateLimitedError";
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

export class DataUnavailableError extends Error {
  readonly attempts: { provider: Provider; reason: string }[];
  constructor(attempts: { provider: Provider; reason: string }[]) {
    super(
      `All data providers unavailable: ${attempts.map((a) => `${a.provider}(${a.reason})`).join(", ")}`,
    );
    this.name = "DataUnavailableError";
    this.attempts = attempts;
  }
}

export class ValidationError extends Error {
  readonly bar: unknown;
  readonly reason: string;
  constructor(bar: unknown, reason: string) {
    super(`Invalid market bar: ${reason}`);
    this.name = "ValidationError";
    this.bar = bar;
    this.reason = reason;
  }
}

export class SymbolError extends Error {
  readonly raw: string;
  constructor(raw: string, reason: string) {
    super(reason);
    this.name = "SymbolError";
    this.raw = raw;
  }
}

/**
 * Strip API key fragments from an error message before it bubbles to the
 * LLM / user. Covers the three key names used by F1 adapters (apiKey/
 * apikey/api_key) across case variations.
 */
export function redactApiKeys(message: string): string {
  return message
    .replace(/([?&])(apiKey|apikey|api_key)=[^&\s]+/gi, "$1$2=REDACTED")
    .replace(/"?(apiKey|apikey|api_key)"?\s*:\s*"[^"]+"/gi, '"$1":"REDACTED"');
}

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

export interface FetchOpts {
  /** Number of bars requested (inclusive). Adapters may return fewer on holidays/new listings. */
  lookback: number;
}

/** Common OHLCV adapter interface. Not every provider implements every method. */
export interface MarketDataAdapter {
  readonly provider: Provider;
  fetchDaily(symbol: string, opts: FetchOpts): Promise<MarketBar[]>;
  fetchIntraday(
    symbol: string,
    interval: IntradayInterval,
    opts: FetchOpts,
  ): Promise<MarketBar[]>;
  /** FX pair daily bars. Only AV has this at F1. Polygon skips. */
  fetchFxDaily?(
    from: string,
    to: string,
    opts: FetchOpts,
  ): Promise<MarketBar[]>;
  /** Current snapshot. AV has it via GLOBAL_QUOTE. Polygon at F1 skips — F10 adds WS. */
  fetchQuote?(symbol: string): Promise<MarketBar>;
}

/** Macro adapter — FRED for VIXCLS/ICSA/M2SL; AV for FEDFUNDS/CPI/etc. */
export interface MacroAdapter {
  readonly provider: Provider;
  fetchMacro(series: string): Promise<MacroPoint[]>;
}
