/**
 * F2 Indicator Engine — pure-math technical indicators.
 *
 * Every indicator is a pure function: takes number[] inputs, returns a
 * same-length array where leading elements are `null` when insufficient
 * data exists to compute. No state, no side effects, no I/O.
 *
 * Conventions (matches Alpha Vantage server-side + TradingView):
 *   - RSI uses Wilder's smoothing (RMA)
 *   - EMA uses SMA-seed for the first N bars, then α = 2/(N+1)
 *   - Bollinger uses sample std dev (n-1 divisor)
 *   - ATR uses Wilder's smoothing
 *   - VWAP is intraday (no reset; callers pass a single session)
 *
 * All outputs have `.length === input.length`. Callers consume the
 * valid tail and ignore the null prefix.
 */

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

/** Simple moving average over `period` bars. */
export function sma(closes: number[], period: number): (number | null)[] {
  if (period < 1) throw new Error(`sma: period must be >= 1, got ${period}`);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average. First N bars seed via SMA; then EMA recurrence. */
export function ema(closes: number[], period: number): (number | null)[] {
  if (period < 1) throw new Error(`ema: period must be >= 1, got ${period}`);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const alpha = 2 / (period + 1);
  // Seed: SMA of first N bars
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = alpha * closes[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

/**
 * Relative Strength Index. Wilder's RMA smoothing.
 *
 * RSI = 100 - (100 / (1 + avgGain/avgLoss))
 * First `period` bars: simple average of gains/losses.
 * Subsequent:  new_avg = (prev * (n-1) + current) / n
 */
export function rsi(closes: number[], period = 14): (number | null)[] {
  if (period < 1) throw new Error(`rsi: period must be >= 1, got ${period}`);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = computeRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = computeRsi(avgGain, avgLoss);
  }
  return out;
}

/**
 * RSI boundary cases:
 *   - avgLoss === 0 && avgGain > 0 → 100 (all gains, no losses = max strength)
 *   - avgLoss === 0 && avgGain === 0 → 50 (flat series, neutral midpoint)
 *
 * Wilder's original definition is undefined for flat series. 50 matches the
 * "no directional pressure" reading and keeps the output within [0,100]
 * even on synthetic constant-price test data.
 */
function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD — Moving Average Convergence/Divergence.
 *   macd       = EMA(fast) - EMA(slow)
 *   signal     = EMA(macd, signalPeriod)
 *   histogram  = macd - signal
 */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
} {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const a = emaFast[i];
    const b = emaSlow[i];
    return a !== null && b !== null ? a - b : null;
  });
  // Signal = EMA of macdLine starting where macdLine first has values.
  // Build a compact array, EMA it, then place back with null prefix.
  const firstIdx = macdLine.findIndex((v) => v !== null);
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  const histogram: (number | null)[] = new Array(closes.length).fill(null);
  if (firstIdx !== -1) {
    const compact = macdLine.slice(firstIdx) as number[];
    const signalCompact = ema(compact, signalPeriod);
    for (let i = 0; i < signalCompact.length; i++) {
      signalLine[firstIdx + i] = signalCompact[i];
    }
    for (let i = 0; i < closes.length; i++) {
      const m = macdLine[i];
      const s = signalLine[i];
      histogram[i] = m !== null && s !== null ? m - s : null;
    }
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

/**
 * Bollinger Bands — SMA ± k*σ over the period window.
 * Uses sample std dev (n-1 divisor) — standard charting convention.
 */
export function bollingerBands(
  closes: number[],
  period = 20,
  stdDev = 2,
): {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
} {
  if (period < 2) throw new Error(`bollinger: period must be >= 2`);
  const middle = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i]!;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (closes[j] - mean) ** 2;
    }
    // Sample std dev: divide by (n-1). Matches TradingView/AV convention.
    const sigma = Math.sqrt(variance / (period - 1));
    upper[i] = mean + stdDev * sigma;
    lower[i] = mean - stdDev * sigma;
  }
  return { upper, middle, lower };
}

/**
 * Average True Range. Wilder's smoothing.
 *   TR = max(H-L, |H - prevClose|, |L - prevClose|)
 *   ATR seed = SMA of first N TRs, then Wilder RMA.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): (number | null)[] {
  if (highs.length !== lows.length || lows.length !== closes.length) {
    throw new Error("atr: highs/lows/closes must have equal length");
  }
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  const tr: number[] = new Array(closes.length);
  tr[0] = highs[0] - lows[0]; // first bar: no prev close, use simple range
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  let avg = 0;
  for (let i = 0; i < period; i++) avg += tr[i];
  avg /= period;
  out[period - 1] = avg;
  for (let i = period; i < closes.length; i++) {
    avg = (avg * (period - 1) + tr[i]) / period;
    out[i] = avg;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * Volume-Weighted Average Price (single-session / cumulative).
 * Typical formula: VWAP = Σ(TP × V) / Σ(V) where TP = (H+L+C)/3.
 *
 * Intraday conventionally resets daily; callers pass one session's bars.
 * If volume is zero at any bar, VWAP stays at previous value.
 */
export function vwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
): (number | null)[] {
  const n = closes.length;
  if (highs.length !== n || lows.length !== n || volumes.length !== n) {
    throw new Error("vwap: all arrays must have equal length");
  }
  const out: (number | null)[] = new Array(n).fill(null);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumPV += tp * volumes[i];
    cumV += volumes[i];
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rate-of-change family
// ---------------------------------------------------------------------------

/**
 * Rate of Change — percentage change from `period` bars ago.
 *   ROC = ((close[i] - close[i-period]) / close[i-period]) * 100
 */
export function roc(closes: number[], period = 10): (number | null)[] {
  if (period < 1) throw new Error(`roc: period must be >= 1`);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const prev = closes[i - period];
    if (prev !== 0) out[i] = ((closes[i] - prev) / prev) * 100;
  }
  return out;
}

/**
 * Williams %R — overbought/oversold in [-100, 0] range.
 *   %R = -100 * (highestHigh - close) / (highestHigh - lowestLow)
 */
export function williamsR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): (number | null)[] {
  if (highs.length !== lows.length || lows.length !== closes.length) {
    throw new Error("williamsR: arrays must have equal length");
  }
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const range = hh - ll;
    out[i] = range === 0 ? 0 : -100 * ((hh - closes[i]) / range);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Return the last non-null value from an indicator output, or null if all null. */
export function latest(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

export type SingleValueIndicator =
  | "sma"
  | "ema"
  | "rsi"
  | "macd_hist"
  | "roc"
  | "williams";

export type AllIndicator =
  | "sma"
  | "ema"
  | "rsi"
  | "macd"
  | "bollinger"
  | "vwap"
  | "atr"
  | "roc"
  | "williams";
