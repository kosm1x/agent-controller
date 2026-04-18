/**
 * F7 — return matrix construction. Converts F3 firings + F1 daily bars into
 * a flat N×M return matrix R[i*M + s] indexed by (signal, period).
 *
 * Signal identity is the composite key `"{signal_type}:{symbol}"`. A signal
 * that fires on AAPL and a signal of the same type that fires on TSLA are
 * distinct signals — the combination engine weights them independently.
 *
 * Return convention (addendum Part 1, D-B in the impl plan):
 *   R(i, s) = close(symbol_i, s + horizon) / close(symbol_i, s) − 1
 *           = 0 when the signal did NOT fire in period s  (neutral)
 *           = −R          when firing.direction === 'short' (sign flip)
 *           = 0 + flag    when either close is missing (data-quality issue)
 *
 * Signals with >5% flagged entries in the window are returned in
 * `excludePremature` so the caller can drop them before the 11-step pipeline
 * (exclude_reason='missing_data').
 */

export interface FiringRow {
  symbol: string;
  signal_type: string;
  direction: "long" | "short" | "neutral";
  strength: number;
  triggered_at: string; // ISO, any resolution — we slice to YYYY-MM-DD
}

export interface BarRow {
  symbol: string;
  /** ISO 8601 timestamp, any resolution — we slice to YYYY-MM-DD for daily matching. */
  timestamp: string;
  close: number;
}

export interface ReturnMatrixInput {
  firings: FiringRow[];
  bars: BarRow[];
  /** Ordered list of M ISO date strings (YYYY-MM-DD). Must be strictly increasing calendar days. */
  periods: string[];
  /** Forward lookback in bars. Default 1 (next-day return). */
  horizon?: number;
  /** Threshold for premature exclusion. Default 0.05 (5%). Flagged-entry ratio above this → drop signal. */
  flagThreshold?: number;
}

export interface ReturnMatrixFlag {
  i: number;
  s: number;
  reason:
    | "missing_close_now"
    | "missing_close_forward"
    | "out_of_window_forward";
}

export interface ReturnMatrixResult {
  /** Flat N*M, indexed R[i*M + s]. */
  R: Float64Array;
  N: number;
  M: number;
  /** Stable sorted list of "{signal_type}:{symbol}" keys, length N. */
  signalKeys: string[];
  /** Parallel to signalKeys; the symbol each signal fires on. */
  symbolOfKey: string[];
  /** Parallel to signalKeys; signal_type (without symbol). */
  typeOfKey: string[];
  /** Diagnostic log — one entry per flagged (i, s). */
  flags: ReturnMatrixFlag[];
  /** Signal indices whose flag-ratio exceeds `flagThreshold`. Caller excludes these. */
  excludePremature: Set<number>;
}

/**
 * Slice a timestamp to its YYYY-MM-DD calendar-day key. Accepts both
 * full ISO (2026-04-17T14:30:00-04:00) and date-only (2026-04-17).
 */
function toDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Build `"{signal_type}:{symbol}"` composite signal key. */
export function signalKey(signalType: string, symbol: string): string {
  return `${signalType}:${symbol}`;
}

/** Parse a composite key back into its parts. Throws on malformed input. */
export function parseSignalKey(key: string): { type: string; symbol: string } {
  const idx = key.indexOf(":");
  if (idx < 0) throw new Error(`parseSignalKey: missing ':' in '${key}'`);
  return {
    type: key.slice(0, idx),
    symbol: key.slice(idx + 1),
  };
}

/**
 * Build the return matrix R(i, s).
 *
 * All inputs are already persisted rows from F1/F3 tables — this function
 * does NOT fetch. Caller passes bars that span at least `max(periods)` plus
 * `horizon` bars beyond, and periods in sorted ascending order.
 */
export function buildReturnMatrix(
  input: ReturnMatrixInput,
): ReturnMatrixResult {
  const horizon = input.horizon ?? 1;
  const flagThreshold = input.flagThreshold ?? 0.05;
  if (horizon < 1) {
    throw new Error(`buildReturnMatrix: horizon must be >= 1, got ${horizon}`);
  }

  const periods = input.periods;
  const M = periods.length;
  if (M === 0) {
    return {
      R: new Float64Array(0),
      N: 0,
      M: 0,
      signalKeys: [],
      symbolOfKey: [],
      typeOfKey: [],
      flags: [],
      excludePremature: new Set(),
    };
  }

  // Derive unique signal keys from firings; stable sort for determinism
  const keySet = new Set<string>();
  for (const f of input.firings) {
    keySet.add(signalKey(f.signal_type, f.symbol));
  }
  const signalKeys = Array.from(keySet).sort();
  const N = signalKeys.length;
  const symbolOfKey: string[] = new Array(N);
  const typeOfKey: string[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const parsed = parseSignalKey(signalKeys[i]!);
    typeOfKey[i] = parsed.type;
    symbolOfKey[i] = parsed.symbol;
  }

  // Index firings by (key, day) — take the last firing if duplicates
  const firingByKeyDay = new Map<string, FiringRow>();
  for (const f of input.firings) {
    const key = signalKey(f.signal_type, f.symbol);
    const day = toDayKey(f.triggered_at);
    firingByKeyDay.set(`${key}|${day}`, f);
  }

  // Index closes by (normalized symbol, day) — last write wins (duplicate providers)
  const closeBySymbolDay = new Map<string, number>();
  for (const b of input.bars) {
    const day = toDayKey(b.timestamp);
    closeBySymbolDay.set(`${b.symbol}|${day}`, b.close);
  }

  // Pre-compute period-index lookup for horizon targeting
  const periodIndex = new Map<string, number>();
  for (let s = 0; s < M; s++) periodIndex.set(periods[s]!, s);

  const R = new Float64Array(N * M);
  const flags: ReturnMatrixFlag[] = [];
  const flagCount = new Array<number>(N).fill(0);

  for (let i = 0; i < N; i++) {
    const key = signalKeys[i]!;
    const symbol = symbolOfKey[i]!;
    for (let s = 0; s < M; s++) {
      const period = periods[s]!;
      const firing = firingByKeyDay.get(`${key}|${period}`);
      if (!firing) {
        R[i * M + s] = 0; // neutral (no firing)
        continue;
      }

      const forwardS = s + horizon;
      if (forwardS >= M) {
        R[i * M + s] = 0;
        flags.push({ i, s, reason: "out_of_window_forward" });
        flagCount[i]!++;
        continue;
      }

      const forwardPeriod = periods[forwardS]!;
      const closeNow = closeBySymbolDay.get(`${symbol}|${period}`);
      if (closeNow == null) {
        R[i * M + s] = 0;
        flags.push({ i, s, reason: "missing_close_now" });
        flagCount[i]!++;
        continue;
      }
      const closeFwd = closeBySymbolDay.get(`${symbol}|${forwardPeriod}`);
      if (closeFwd == null) {
        R[i * M + s] = 0;
        flags.push({ i, s, reason: "missing_close_forward" });
        flagCount[i]!++;
        continue;
      }
      if (closeNow === 0) {
        // Guard against divide-by-zero. Treat as data error.
        R[i * M + s] = 0;
        flags.push({ i, s, reason: "missing_close_now" });
        flagCount[i]!++;
        continue;
      }

      let ret = closeFwd / closeNow - 1;
      if (firing.direction === "short") ret = -ret;
      R[i * M + s] = ret;
    }
  }

  const excludePremature = new Set<number>();
  // Count the firing opportunities (not just period count) to make the ratio
  // meaningful: a signal that only fires once has M-1 non-firings and 1 firing;
  // flagging that 1 firing would drop the whole signal even though it's only
  // 1 data-quality issue. We count flags relative to actual firing attempts.
  for (let i = 0; i < N; i++) {
    let firingAttempts = 0;
    const symbol = symbolOfKey[i]!;
    const type = typeOfKey[i]!;
    const keyPrefix = signalKey(type, symbol) + "|";
    for (let s = 0; s < M; s++) {
      if (firingByKeyDay.has(keyPrefix + periods[s]!)) firingAttempts++;
    }
    if (firingAttempts === 0) continue; // no firings → already neutral, no exclusion
    if (flagCount[i]! / firingAttempts > flagThreshold) {
      excludePremature.add(i);
    }
  }

  return {
    R,
    N,
    M,
    signalKeys,
    symbolOfKey,
    typeOfKey,
    flags,
    excludePremature,
  };
}

/**
 * Resolve an ordered list of M calendar days ending at `asOf` (inclusive).
 * Uses ALL unique trading days found in the provided bars — callers who
 * need stricter calendar semantics (e.g., NYSE holiday calendar) should
 * pre-filter their bars before calling buildReturnMatrix.
 */
export function resolvePeriodsFromBars(
  bars: BarRow[],
  asOf: string,
  M: number,
): string[] {
  const asOfDay = toDayKey(asOf);
  const dayset = new Set<string>();
  for (const b of bars) {
    const d = toDayKey(b.timestamp);
    if (d <= asOfDay) dayset.add(d);
  }
  const sorted = Array.from(dayset).sort(); // ascending
  if (sorted.length <= M) return sorted;
  return sorted.slice(sorted.length - M);
}

// NOTE: symbols persisted in market_data + market_signals are already
// normalized at F1/F3 write-time via data-layer.normalizeSymbol(). Callers
// needing to normalize a raw operator-provided symbol should import
// normalizeSymbol from data-layer.ts directly — we do not re-export it here
// to keep alpha-matrix dependency-free from the F1 adapter layer.
