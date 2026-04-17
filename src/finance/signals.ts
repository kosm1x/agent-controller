/**
 * F3 Signal Detector — 6 pattern detectors + aggregator + persistence.
 *
 * Each detector is a pure function over MarketBar[] that returns zero or
 * more Signal events. Detectors fire only at the event bar (state change),
 * not on every bar where the condition is satisfied — prevents double-
 * counting in downstream F7 composition.
 *
 * Persistence is separate and synchronous (better-sqlite3); callers decide
 * whether to persist. F3 tool handlers persist on every scan.
 */

import { getDatabase } from "../db/index.js";
import type { MarketBar } from "./types.js";
import { sma, rsi, macd, bollingerBands } from "./indicators.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalType =
  | "ma_crossover"
  | "rsi_extreme"
  | "macd_crossover"
  | "bollinger_breakout"
  | "volume_spike"
  | "price_threshold";

export interface Signal {
  symbol: string;
  type: SignalType;
  direction: "long" | "short" | "neutral";
  strength: number; // 0..1
  price: number;
  timestamp: string;
  description: string;
  indicators: Record<string, number>;
  transmissionChain: never[]; // populated by F7/F8; empty at F3
}

export interface DetectOpts {
  /** MA crossover fast/slow periods. Default 50/200 (golden-cross convention). */
  maFast?: number;
  maSlow?: number;
  /** RSI extremes thresholds. Default 70/30. */
  rsiOverbought?: number;
  rsiOversold?: number;
  /** Volume-spike σ threshold. Default 2.0. */
  volSigma?: number;
  /** Price-threshold triggers; each fires one signal on cross. */
  priceThresholds?: number[];
}

// ---------------------------------------------------------------------------
// MA crossover (golden/death cross)
// ---------------------------------------------------------------------------

/**
 * Fires once at the bar where fast SMA crosses above (bullish) or below
 * (bearish) the slow SMA — classic golden/death cross (SMA(50)/SMA(200)
 * on daily, matches chart-convention). Does NOT fire on every subsequent
 * bar while the relationship holds — that would double-count the same
 * signal for downstream composition.
 *
 * Audit C2: implementation + doc both use SMA. Switch to EMA (exists in
 * indicators.ts) if a later requirement prefers momentum-sensitive crosses.
 */
export function detectMaCrossover(
  bars: MarketBar[],
  fast = 50,
  slow = 200,
): Signal[] {
  if (bars.length < slow + 1) return [];
  const closes = bars.map((b) => b.close);
  const fastArr = sma(closes, fast);
  const slowArr = sma(closes, slow);
  const signals: Signal[] = [];
  for (let i = slow; i < bars.length; i++) {
    const f = fastArr[i];
    const s = slowArr[i];
    const fp = fastArr[i - 1];
    const sp = slowArr[i - 1];
    if (f === null || s === null || fp === null || sp === null) continue;
    const prevDiff = fp - sp;
    const currDiff = f - s;
    // Sign-change crossover. Note Math.sign(0) === 0, so a transition from
    // exactly 0 to nonzero does fire — chart convention treats that as a
    // valid cross. True-zero MACD/SMA difference is essentially absent in
    // production floating-point math; the audit W2 concern (synthetic zero
    // grazing) is theoretical.
    if (Math.sign(prevDiff) === Math.sign(currDiff)) continue;
    const direction: Signal["direction"] = currDiff > 0 ? "long" : "short";
    const label = direction === "long" ? "golden cross" : "death cross";
    signals.push({
      symbol: bars[i].symbol,
      type: "ma_crossover",
      direction,
      strength: Math.min(1, Math.abs(currDiff) / bars[i].close),
      price: bars[i].close,
      timestamp: bars[i].timestamp,
      description: `SMA(${fast}) crossed ${direction === "long" ? "above" : "below"} SMA(${slow}) (${label}) @ ${bars[i].close.toFixed(2)}`,
      indicators: { smaFast: f, smaSlow: s },
      transmissionChain: [],
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// RSI extremes
// ---------------------------------------------------------------------------

/**
 * Fires only at the first bar crossing into an extreme zone. While in-zone,
 * no further signals emit. Prevents multi-day "overbought" series from
 * producing one signal per bar.
 */
export function detectRsiExtremes(
  bars: MarketBar[],
  overbought = 70,
  oversold = 30,
  period = 14,
): Signal[] {
  if (bars.length < period + 2) return [];
  const closes = bars.map((b) => b.close);
  const rsiArr = rsi(closes, period);
  const signals: Signal[] = [];
  for (let i = period + 1; i < bars.length; i++) {
    const v = rsiArr[i];
    const prev = rsiArr[i - 1];
    if (v === null || prev === null) continue;
    if (prev < overbought && v >= overbought) {
      signals.push({
        symbol: bars[i].symbol,
        type: "rsi_extreme",
        direction: "short",
        strength: Math.min(1, (v - overbought) / (100 - overbought)),
        price: bars[i].close,
        timestamp: bars[i].timestamp,
        description: `RSI(${period})=${v.toFixed(1)} (overbought) @ ${bars[i].close.toFixed(2)}`,
        indicators: { rsi: v },
        transmissionChain: [],
      });
    } else if (prev > oversold && v <= oversold) {
      signals.push({
        symbol: bars[i].symbol,
        type: "rsi_extreme",
        direction: "long",
        strength: Math.min(1, (oversold - v) / oversold),
        price: bars[i].close,
        timestamp: bars[i].timestamp,
        description: `RSI(${period})=${v.toFixed(1)} (oversold) @ ${bars[i].close.toFixed(2)}`,
        indicators: { rsi: v },
        transmissionChain: [],
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// MACD crossover
// ---------------------------------------------------------------------------

/** Fires at the bar where MACD line crosses its signal line. */
export function detectMacdCrossover(bars: MarketBar[]): Signal[] {
  if (bars.length < 40) return [];
  const closes = bars.map((b) => b.close);
  const m = macd(closes);
  const signals: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const curr = m.histogram[i];
    const prev = m.histogram[i - 1];
    if (curr === null || prev === null) continue;
    // Sign-change crossover. See detectMaCrossover comment on the W2 tradeoff.
    if (Math.sign(prev) === Math.sign(curr)) continue;
    const direction: Signal["direction"] = curr > 0 ? "long" : "short";
    signals.push({
      symbol: bars[i].symbol,
      type: "macd_crossover",
      direction,
      strength: Math.min(1, Math.abs(curr) / (bars[i].close * 0.01)),
      price: bars[i].close,
      timestamp: bars[i].timestamp,
      description: `MACD ${direction === "long" ? "bullish" : "bearish"} crossover (hist ${curr.toFixed(2)}) @ ${bars[i].close.toFixed(2)}`,
      indicators: {
        macd: m.macd[i]!,
        signal: m.signal[i]!,
        histogram: curr,
      },
      transmissionChain: [],
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Bollinger breakout
// ---------------------------------------------------------------------------

/**
 * Fires at the bar where close moves outside the band, **only** if the
 * previous close was inside. Prevents multi-bar breakouts from emitting
 * on every bar.
 */
export function detectBollingerBreakout(
  bars: MarketBar[],
  period = 20,
  stdDev = 2,
): Signal[] {
  if (bars.length < period + 1) return [];
  const closes = bars.map((b) => b.close);
  const b = bollingerBands(closes, period, stdDev);
  const signals: Signal[] = [];
  for (let i = period; i < bars.length; i++) {
    const upper = b.upper[i];
    const lower = b.lower[i];
    const mid = b.middle[i];
    const prevUpper = b.upper[i - 1];
    const prevLower = b.lower[i - 1];
    if (
      upper === null ||
      lower === null ||
      mid === null ||
      prevUpper === null ||
      prevLower === null
    )
      continue;
    const curr = closes[i];
    const prev = closes[i - 1];

    const prevInside = prev <= prevUpper && prev >= prevLower;
    if (!prevInside) continue;

    if (curr > upper) {
      signals.push({
        symbol: bars[i].symbol,
        type: "bollinger_breakout",
        direction: "short", // Upper-band break = mean-reversion bias short
        strength: Math.min(1, (curr - upper) / (upper - mid)),
        price: curr,
        timestamp: bars[i].timestamp,
        description: `Upper Bollinger break (${curr.toFixed(2)} vs ${upper.toFixed(2)})`,
        indicators: { upper, middle: mid, lower, close: curr },
        transmissionChain: [],
      });
    } else if (curr < lower) {
      signals.push({
        symbol: bars[i].symbol,
        type: "bollinger_breakout",
        direction: "long", // Lower-band break = mean-reversion bias long
        strength: Math.min(1, (lower - curr) / (mid - lower)),
        price: curr,
        timestamp: bars[i].timestamp,
        description: `Lower Bollinger break (${curr.toFixed(2)} vs ${lower.toFixed(2)})`,
        indicators: { upper, middle: mid, lower, close: curr },
        transmissionChain: [],
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Volume spike
// ---------------------------------------------------------------------------

/** Fires when volume z-score over the prior N bars exceeds the threshold. */
export function detectVolumeSpike(
  bars: MarketBar[],
  sigma = 2,
  window = 20,
): Signal[] {
  if (bars.length < window + 1) return [];
  const signals: Signal[] = [];
  for (let i = window; i < bars.length; i++) {
    const slice = bars.slice(i - window, i).map((b) => b.volume);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    let variance = 0;
    for (const v of slice) variance += (v - mean) ** 2;
    variance /= window;
    const std = Math.sqrt(variance);
    if (std === 0 || mean === 0) continue;
    const z = (bars[i].volume - mean) / std;
    if (z < sigma) continue;
    // Direction from price action
    const dir: Signal["direction"] =
      bars[i].close > bars[i].open
        ? "long"
        : bars[i].close < bars[i].open
          ? "short"
          : "neutral";
    signals.push({
      symbol: bars[i].symbol,
      type: "volume_spike",
      direction: dir,
      strength: Math.min(1, z / 5),
      price: bars[i].close,
      timestamp: bars[i].timestamp,
      description: `Volume ${z.toFixed(1)}σ above ${window}-bar baseline (${bars[i].volume.toLocaleString()})`,
      indicators: { volume: bars[i].volume, volumeZ: z, volumeMean: mean },
      transmissionChain: [],
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Price threshold
// ---------------------------------------------------------------------------

/** Fires when close crosses (either direction) each threshold. */
export function detectPriceThreshold(
  bars: MarketBar[],
  thresholds: number[],
): Signal[] {
  if (bars.length < 2 || thresholds.length === 0) return [];
  const signals: Signal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const curr = bars[i].close;
    for (const t of thresholds) {
      const crossingUp = prev < t && curr >= t;
      const crossingDown = prev > t && curr <= t;
      if (!crossingUp && !crossingDown) continue;
      // Audit I4: direction follows cross direction instead of being
      // hardcoded neutral. Preserves information for F7 composition.
      const direction: Signal["direction"] = crossingUp ? "long" : "short";
      signals.push({
        symbol: bars[i].symbol,
        type: "price_threshold",
        direction,
        strength: 0.5,
        price: curr,
        timestamp: bars[i].timestamp,
        description: `Price crossed threshold ${t} (${prev.toFixed(2)} → ${curr.toFixed(2)})`,
        indicators: { threshold: t, prevClose: prev, close: curr },
        transmissionChain: [],
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export function detectAllSignals(
  bars: MarketBar[],
  opts: DetectOpts = {},
): Signal[] {
  const signals: Signal[] = [
    ...detectMaCrossover(bars, opts.maFast, opts.maSlow),
    ...detectRsiExtremes(bars, opts.rsiOverbought, opts.rsiOversold),
    ...detectMacdCrossover(bars),
    ...detectBollingerBreakout(bars),
    ...detectVolumeSpike(bars, opts.volSigma),
    ...detectPriceThreshold(bars, opts.priceThresholds ?? []),
  ];
  // Sort ascending by timestamp for stable output
  signals.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return signals;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * INSERT each signal into `market_signals`. Returns number of rows inserted
 * (0 for duplicates already logged). Duplicates detected via `(symbol, type, triggered_at)`
 * natural key — we fall back to select-before-insert because the schema doesn't
 * have a UNIQUE constraint (F1 left the table append-only).
 */
export function persistSignals(signals: Signal[]): number {
  if (signals.length === 0) return 0;
  const db = getDatabase();
  const exists = db.prepare(
    "SELECT 1 FROM market_signals WHERE symbol=? AND signal_type=? AND triggered_at=? LIMIT 1",
  );
  const insert = db.prepare(
    `INSERT INTO market_signals (symbol, signal_type, direction, strength, triggered_at, indicators_snapshot, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction((all: Signal[]) => {
    for (const s of all) {
      if (exists.get(s.symbol, s.type, s.timestamp)) continue;
      insert.run(
        s.symbol,
        s.type,
        s.direction,
        s.strength,
        s.timestamp,
        JSON.stringify(s.indicators),
        JSON.stringify({
          description: s.description,
          price: s.price,
          transmissionChain: s.transmissionChain,
        }),
      );
      inserted++;
    }
  });
  tx(signals);
  return inserted;
}
