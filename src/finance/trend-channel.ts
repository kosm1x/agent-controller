/**
 * Trend channel fitting — pure numerics, no LLM, no external deps.
 *
 * Adopts the methodology from QuantAgent's Trend Agent (arXiv 2509.09995):
 * 1. Pivot detection on recent highs/lows with a lookback window
 * 2. Least-squares regression through pivot highs (upper line) and lows (lower line)
 * 3. Slope quantification classified against the bar ATR to label uptrend/downtrend/sideways
 * 4. Consolidation-zone detection when channel width < k * ATR over the last N bars
 *
 * See `reference_quantagent.md` (methodology piece #1).
 */

import type { MarketBar } from "./types.js";
import { atr } from "./indicators.js";

export interface Pivot {
  index: number;
  value: number;
}

export interface ChannelLine {
  slope: number; // price units per bar
  intercept: number; // price at index 0
  r2: number; // coefficient of determination, [0,1]
  pivots: Pivot[]; // pivots used in the fit
}

export type TrendDirection = "uptrend" | "downtrend" | "sideways";

export interface TrendChannel {
  upper: ChannelLine;
  lower: ChannelLine;
  direction: TrendDirection;
  slopePerBar: number; // midline slope (average of upper+lower)
  consolidation: boolean;
  channelWidthAtLast: number | null; // upper - lower at last bar
  avgATR: number | null; // mean ATR over the last `atrWindow` bars (for reference)
}

export interface TrendChannelOptions {
  /** Pivot half-window: a pivot requires being extremum vs ±window neighbors. Default 3. */
  pivotWindow?: number;
  /** Bars used for ATR + consolidation width test. Default 20. */
  atrWindow?: number;
  /** Consolidation fires when channel width at last bar < k * avgATR. Default 2.0. */
  consolidationK?: number;
  /**
   * Slope / avgATR ratio below which direction is "sideways". Default 0.05
   * (i.e., midline moves less than 5% of an ATR per bar on average).
   */
  sidewaysThreshold?: number;
}

const DEFAULTS: Required<TrendChannelOptions> = {
  pivotWindow: 3,
  atrWindow: 20,
  consolidationK: 2.0,
  sidewaysThreshold: 0.05,
};

/**
 * Detect local high/low pivots. A pivot high is strictly greater than its
 * `window` neighbors on each side; a pivot low is strictly lower.
 */
export function detectPivots(
  bars: readonly MarketBar[],
  window = DEFAULTS.pivotWindow,
): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  if (window < 1 || bars.length < 2 * window + 1) return { highs, lows };

  for (let i = window; i < bars.length - window; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= window; j++) {
      if (bars[i - j].high >= h || bars[i + j].high >= h) isHigh = false;
      if (bars[i - j].low <= l || bars[i + j].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, value: h });
    if (isLow) lows.push({ index: i, value: l });
  }
  return { highs, lows };
}

/** Least-squares fit y = slope*x + intercept plus r² (0 when n<2 or zero variance). */
function leastSquares(pivots: Pivot[]): Omit<ChannelLine, "pivots"> {
  if (pivots.length < 2) return { slope: 0, intercept: 0, r2: 0 };
  const n = pivots.length;
  let sx = 0,
    sy = 0;
  for (const p of pivots) {
    sx += p.index;
    sy += p.value;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0,
    den = 0,
    totalSS = 0;
  for (const p of pivots) {
    const dx = p.index - mx;
    const dy = p.value - my;
    num += dx * dy;
    den += dx * dx;
    totalSS += dy * dy;
  }
  if (den === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = num / den;
  const intercept = my - slope * mx;
  let resSS = 0;
  for (const p of pivots) {
    const predicted = slope * p.index + intercept;
    const resid = p.value - predicted;
    resSS += resid * resid;
  }
  const r2 = totalSS > 0 ? Math.max(0, 1 - resSS / totalSS) : 0;
  return { slope, intercept, r2 };
}

function lineValueAt(line: ChannelLine, index: number): number {
  return line.slope * index + line.intercept;
}

/**
 * Fit a trend channel through the bar range. Uses detected pivots — if
 * fewer than 2 pivots per side exist, falls back to regressing the full
 * high/low series so the function always produces a line.
 */
export function fitTrendChannel(
  bars: readonly MarketBar[],
  opts: TrendChannelOptions = {},
): TrendChannel {
  const cfg = { ...DEFAULTS, ...opts };
  const { highs, lows } = detectPivots(bars, cfg.pivotWindow);

  const highSeries: Pivot[] =
    highs.length >= 2
      ? highs
      : bars.map((b, i) => ({ index: i, value: b.high }));
  const lowSeries: Pivot[] =
    lows.length >= 2 ? lows : bars.map((b, i) => ({ index: i, value: b.low }));

  const upperFit = leastSquares(highSeries);
  const lowerFit = leastSquares(lowSeries);
  const upper: ChannelLine = { ...upperFit, pivots: highSeries };
  const lower: ChannelLine = { ...lowerFit, pivots: lowSeries };

  const slopePerBar = (upper.slope + lower.slope) / 2;

  // ATR reference (last N bars). Pulled from F2 pure-math indicator set.
  const atrPeriod = Math.min(cfg.atrWindow, Math.max(2, bars.length - 1));
  const atrSeries = atr(
    bars.map((b) => b.high),
    bars.map((b) => b.low),
    bars.map((b) => b.close),
    atrPeriod,
  );
  const tailAtr = atrSeries
    .slice(-cfg.atrWindow)
    .filter((v): v is number => v !== null);
  const avgATR =
    tailAtr.length > 0
      ? tailAtr.reduce((a, b) => a + b, 0) / tailAtr.length
      : null;

  let direction: TrendDirection = "sideways";
  if (avgATR !== null && avgATR > 0) {
    const ratio = slopePerBar / avgATR;
    if (ratio > cfg.sidewaysThreshold) direction = "uptrend";
    else if (ratio < -cfg.sidewaysThreshold) direction = "downtrend";
  }

  const lastIndex = bars.length - 1;
  const channelWidthAtLast =
    bars.length > 0
      ? lineValueAt(upper, lastIndex) - lineValueAt(lower, lastIndex)
      : null;

  // Consolidation = narrow channel AND sideways drift. A narrow channel alone
  // is not consolidation — a tight uptrending channel (e.g., a bull flag) has
  // clear directional intent and should not be labeled range-bound.
  const consolidation =
    direction === "sideways" &&
    avgATR !== null &&
    avgATR > 0 &&
    channelWidthAtLast !== null &&
    channelWidthAtLast < cfg.consolidationK * avgATR;

  return {
    upper,
    lower,
    direction,
    slopePerBar,
    consolidation,
    channelWidthAtLast,
    avgATR,
  };
}

/** Convenience — just the consolidation flag. */
export function detectConsolidation(
  bars: readonly MarketBar[],
  opts: TrendChannelOptions = {},
): boolean {
  return fitTrendChannel(bars, opts).consolidation;
}
