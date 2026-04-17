/**
 * F1 validation layer — sanity-check every OHLCV bar before it reaches
 * the market_data table. Bad data never reaches the indicator engine.
 *
 * Rules:
 *   1. Price sanity: low <= open/close <= high, nothing NaN/Infinity
 *   2. Volume sanity: non-negative, integer
 *   3. Timestamp sanity: parseable, within [1990-01-01, now+7d]
 *   4. Continuity (when previous bar provided): |close_n / close_n-1| within 10x
 *      — catches data glitches (wrong decimal place, field swap)
 *   5. Volume continuity: |vol_n / avg(prev 5 bars)| within 100x
 *      — flags anomalies for logging but does NOT reject (real spikes exist)
 */

import { isReasonableTimestamp } from "./timezone.js";
import type { MarketBar } from "./types.js";

export type ValidationOutcome =
  | { valid: true; warnings?: string[] }
  | { valid: false; reason: string };

export interface ValidationContext {
  /** Previous bar (chronologically) for continuity checks. Undefined on first bar. */
  previousBar?: MarketBar;
  /** Rolling prev 5 volumes for volume-continuity check. */
  previousVolumes?: number[];
}

/**
 * Validate a single OHLCV bar. Returns structured outcome; caller decides
 * whether to persist, skip, or log.
 */
export function validateMarketBar(
  bar: MarketBar,
  context: ValidationContext = {},
): ValidationOutcome {
  const warnings: string[] = [];

  // 1. Price sanity
  for (const [name, value] of [
    ["open", bar.open],
    ["high", bar.high],
    ["low", bar.low],
    ["close", bar.close],
  ] as const) {
    if (!Number.isFinite(value)) {
      return { valid: false, reason: `${name} is not finite: ${value}` };
    }
    if (value < 0) {
      return { valid: false, reason: `${name} is negative: ${value}` };
    }
  }
  if (bar.low > bar.open) {
    return {
      valid: false,
      reason: `low (${bar.low}) > open (${bar.open})`,
    };
  }
  if (bar.low > bar.close) {
    return {
      valid: false,
      reason: `low (${bar.low}) > close (${bar.close})`,
    };
  }
  if (bar.high < bar.open) {
    return {
      valid: false,
      reason: `high (${bar.high}) < open (${bar.open})`,
    };
  }
  if (bar.high < bar.close) {
    return {
      valid: false,
      reason: `high (${bar.high}) < close (${bar.close})`,
    };
  }

  // 2. Volume sanity
  if (!Number.isFinite(bar.volume) || bar.volume < 0) {
    return { valid: false, reason: `volume invalid: ${bar.volume}` };
  }
  if (!Number.isInteger(bar.volume)) {
    return { valid: false, reason: `volume not integer: ${bar.volume}` };
  }

  // 3. Timestamp sanity
  if (!isReasonableTimestamp(bar.timestamp)) {
    return {
      valid: false,
      reason: `timestamp out of acceptable range: ${bar.timestamp}`,
    };
  }

  // 4. Price continuity vs previous bar
  if (context.previousBar && context.previousBar.close > 0) {
    const ratio = bar.close / context.previousBar.close;
    if (ratio > 10 || ratio < 0.1) {
      return {
        valid: false,
        reason: `close-to-close ratio ${ratio.toFixed(3)}x exceeds 10x sanity threshold (prev=${context.previousBar.close}, curr=${bar.close})`,
      };
    }
  }

  // 5. Volume continuity (warn only)
  if (context.previousVolumes && context.previousVolumes.length >= 5) {
    const avg =
      context.previousVolumes.reduce((a, b) => a + b, 0) /
      context.previousVolumes.length;
    if (avg > 0) {
      const volRatio = bar.volume / avg;
      if (volRatio > 100 || (volRatio < 0.01 && bar.volume > 0)) {
        warnings.push(
          `volume ${volRatio.toFixed(1)}x vs 5-bar avg (${avg.toFixed(0)})`,
        );
      }
    }
  }

  return warnings.length ? { valid: true, warnings } : { valid: true };
}
