/**
 * F8.1a — Prediction-Market Alpha Layer.
 *
 * Simplified analogue to F7 FLAM for Polymarket tokens. Takes active
 * prediction markets + current sentiment readings + whale trade flow and
 * produces per-token Kelly-fraction weights.
 *
 * 3 features (v1):
 *   1. Crowd price (market midpoint)     → baseline probability
 *   2. Sentiment tilt (crypto-only)      → small shift on F&G extremes
 *   3. Whale flow (optional, z-scored)   → signed contribution, tanh-squashed
 *
 * Kelly-fraction sizing for binary outcomes:
 *   edge       = p_estimate - market_price
 *   b          = (1 - market_price) / market_price   ← decimal-odds return
 *   kelly_raw  = edge / b                            ← binary-outcome Kelly
 *   weight     = clip(kelly_scale × kelly_raw, ±max_weight)
 *
 * Two-pass exposure clip:
 *   pass 1: clip per-token |weight| ≤ max_weight_per_token
 *   pass 2: if Σ|weight| > max_total_exposure, scale all down proportionally
 *
 * See plan §2 for design decisions. Deliberately NO IC filter, correlation
 * guard, or firewall integration at v1 — deferred to F8.1c.
 *
 * Pure function. No DB. No I/O. No deps.
 */

import { randomUUID } from "node:crypto";
import type {
  PredictionMarket,
  PredictionMarketOutcome,
} from "./prediction-markets.js";
import type { SentimentReading } from "./sentiment.js";
import type { WhaleTrade } from "./whales.js";

// ---------------------------------------------------------------------------
// Config + defaults
// ---------------------------------------------------------------------------

export const PM_ALPHA_DEFAULTS = {
  whaleWeight: 0.03,
  sentimentWeight: 0.02,
  kellyScale: 0.2,
  maxWeightPerToken: 0.02,
  maxTotalExposure: 0.3,
  minLiquidityUsd: 1000,
  minDaysToResolution: 1,
  maxDaysToResolution: 180,
  minPriceBound: 0.05,
  maxPriceBound: 0.95,
} as const;

export interface PmAlphaConfig {
  whaleWeight?: number;
  sentimentWeight?: number;
  kellyScale?: number;
  maxWeightPerToken?: number;
  maxTotalExposure?: number;
  minLiquidityUsd?: number;
  minDaysToResolution?: number;
  maxDaysToResolution?: number;
  minPriceBound?: number;
  maxPriceBound?: number;
}

export type PmExcludeReason =
  | "extreme_price"
  | "low_liquidity"
  | "unknown_liquidity"
  | "near_resolution"
  | "far_resolution"
  | "unknown_resolution"
  | "already_resolved"
  | "malformed_outcome";

export interface PmTokenResult {
  marketId: string;
  slug: string | null;
  outcome: string;
  tokenId: string | null;
  marketPrice: number;
  pEstimate: number;
  edge: number;
  whaleFlowUsd: number | null;
  sentimentTilt: number;
  kellyRaw: number;
  weight: number;
  liquidityUsd: number | null;
  resolutionDate: string | null;
  excluded: boolean;
  excludeReason: PmExcludeReason | null;
}

export interface PmAlphaInput {
  markets: PredictionMarket[];
  sentimentReadings: SentimentReading[];
  whaleTrades: WhaleTrade[];
  /** ISO 8601 timestamp (NY). */
  asOf: string;
  /** Override defaults. */
  config?: PmAlphaConfig;
  /** Optional UUID for deterministic testing. */
  runId?: string;
}

export interface PmAlphaResult {
  runId: string;
  runTimestamp: string;
  nMarkets: number;
  nActive: number;
  totalExposure: number;
  tokens: PmTokenResult[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a market question is crypto-related AND frames YES as a
 * bullish outcome (price up). Only those markets get sentiment tilt in v1;
 * conservative by design.
 */
function isCryptoUpMarket(question: string): boolean {
  const hasCrypto =
    /\b(btc|eth|xrp|sol|bitcoin|ethereum|crypto|cryptocurrency|altcoin)\b/i.test(
      question,
    );
  if (!hasCrypto) return false;
  // Bullish framing — question contains an up-direction cue. We deliberately
  // skip reach/hit/above without a price anchor because those aren't reliably
  // bullish (e.g. "hit all-time low"). Price anchor + bullish verb combo is
  // the safest v1 heuristic.
  const bullishCues =
    /(hit|reach|above|surpass|exceed|break|new high|all[-\s]?time[-\s]?high|ath|\$\d|moon|pump|rally)/i;
  return bullishCues.test(question);
}

/**
 * Extract the latest fear/greed index from the sentiment readings.
 * Returns null if no reading exists.
 */
function latestFearGreed(readings: SentimentReading[]): number | null {
  const fg = readings
    .filter((r) => r.indicator === "fear_greed")
    .sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? ""));
  if (fg.length === 0) return null;
  const v = fg[fg.length - 1]!.value;
  return Number.isFinite(v) ? v : null;
}

/**
 * Recognize the YES / NO sides of a binary market. Used to direct the
 * sentiment tilt and whale flow sign. Audit W4 round 1: on multi-outcome
 * markets (N > 2) this is ambiguous — the caller must gate on a 2-outcome
 * precondition before routing tilt based on `isYes`.
 */
function isYesLabel(outcomeLabel: string): boolean {
  return /^(yes|s[ií]|up|above|higher|true|bull|bullish)/i.test(outcomeLabel);
}

function isNoLabel(outcomeLabel: string): boolean {
  return /^(no|down|below|lower|false|bear|bearish)/i.test(outcomeLabel);
}

function sentimentTilt(
  question: string,
  outcomeLabel: string,
  fearGreed: number | null,
  weight: number,
  nOutcomes: number,
): number {
  if (fearGreed === null) return 0;
  if (!isCryptoUpMarket(question)) return 0;
  // Audit W4 round 1: only binary YES/NO markets get tilt. Multi-outcome
  // markets ("Which month?", "Which candidate?") with N > 2 have labels like
  // "January" that neither YES- nor NO-match, so the tilt would fire with
  // the wrong sign. Restrict to N=2 + the label is clearly YES or NO.
  if (nOutcomes !== 2) return 0;
  const isYes = isYesLabel(outcomeLabel);
  const isNo = isNoLabel(outcomeLabel);
  if (!isYes && !isNo) return 0;
  // < 25 = extreme fear → contrarian bullish on YES (crypto bounces)
  // > 75 = extreme greed → contrarian bearish on YES
  if (fearGreed < 25) return isYes ? weight : -weight;
  if (fearGreed > 75) return isYes ? -weight : weight;
  return 0;
}

function whaleFlowForMarket(
  marketId: string,
  trades: WhaleTrade[],
  outcomeLabel: string,
): number | null {
  if (trades.length === 0) return null;
  const relevant = trades.filter((t) => t.marketId === marketId);
  if (relevant.length === 0) return null;
  const isYes = isYesLabel(outcomeLabel);
  let net = 0;
  for (const t of relevant) {
    const size = t.sizeUsd ?? 0;
    if (!Number.isFinite(size) || size === 0) continue;
    // Buy on YES side = positive; sell on YES side = negative. For NO outcome
    // we flip.
    const sign = t.side === "buy" || t.side === "long" ? 1 : -1;
    net += sign * size * (isYes ? 1 : -1);
  }
  return Number.isFinite(net) ? net : null;
}

function zScore(x: number, values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  if (!(sd > 0)) return 0;
  return (x - mean) / sd;
}

function tanh(x: number): number {
  return Math.tanh(x);
}

function clip(x: number, min: number, max: number): number {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function daysBetween(fromIso: string, toIso: string | null): number | null {
  if (!toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the PM alpha pipeline. Pure function.
 *
 * Returns one PmTokenResult per (market, outcome) pair — including excluded
 * rows so the caller can audit why a market was skipped. `weight` is 0 on
 * excluded rows.
 */
export function runPmAlpha(input: PmAlphaInput): PmAlphaResult {
  const t0 = Date.now();
  const cfg = { ...PM_ALPHA_DEFAULTS, ...input.config };
  const runId = input.runId ?? randomUUID();
  const runTimestamp = input.asOf;

  const fearGreed = latestFearGreed(input.sentimentReadings);

  // Pass 0: build raw per-token rows + collect whale flows for z-score.
  interface RawRow {
    market: PredictionMarket;
    outcome: PredictionMarketOutcome;
    price: number;
    whaleFlow: number | null;
    liquidityUsd: number | null;
    daysToRes: number | null;
    excluded: boolean;
    excludeReason: PmExcludeReason | null;
  }
  const rawRows: RawRow[] = [];
  const whaleFlows: number[] = [];

  for (const m of input.markets) {
    const outcomes = m.outcomes;
    if (!outcomes || outcomes.length === 0) {
      rawRows.push({
        market: m,
        outcome: { id: "", label: "UNKNOWN", price: 0 },
        price: 0,
        whaleFlow: null,
        liquidityUsd: m.liquidityUsd ?? null,
        daysToRes: daysBetween(runTimestamp, m.resolutionDate ?? null),
        excluded: true,
        excludeReason: "malformed_outcome",
      });
      continue;
    }

    const days = daysBetween(runTimestamp, m.resolutionDate ?? null);

    for (const o of outcomes) {
      let excluded = false;
      let reason: PmExcludeReason | null = null;
      if (!(o.price >= cfg.minPriceBound && o.price <= cfg.maxPriceBound)) {
        excluded = true;
        reason = "extreme_price";
      } else if (m.liquidityUsd === null || m.liquidityUsd === undefined) {
        // Audit W2 round 1: null liquidity no longer passes through. Thin /
        // unknown markets exclude by default — conservative until the operator
        // opts in explicitly via a separate config flag.
        excluded = true;
        reason = "unknown_liquidity";
      } else if (m.liquidityUsd < cfg.minLiquidityUsd) {
        excluded = true;
        reason = "low_liquidity";
      } else if (days === null) {
        // Audit W3 round 1: null resolution date no longer passes through.
        excluded = true;
        reason = "unknown_resolution";
      } else if (days < 0) {
        // Audit W6 round 1: market already resolved (date in the past).
        // Distinct reason so audits don't confuse with upcoming-resolution.
        excluded = true;
        reason = "already_resolved";
      } else if (days < cfg.minDaysToResolution) {
        excluded = true;
        reason = "near_resolution";
      } else if (days > cfg.maxDaysToResolution) {
        excluded = true;
        reason = "far_resolution";
      }

      const whaleFlow = whaleFlowForMarket(
        m.marketId,
        input.whaleTrades,
        o.label,
      );
      if (!excluded && whaleFlow !== null) whaleFlows.push(whaleFlow);

      rawRows.push({
        market: m,
        outcome: o,
        price: o.price,
        whaleFlow,
        liquidityUsd: m.liquidityUsd ?? null,
        daysToRes: days,
        excluded,
        excludeReason: reason,
      });
    }
  }

  // Pass 1: compute per-token weights on active rows; excluded rows get 0.
  const tokens: PmTokenResult[] = [];
  for (const r of rawRows) {
    if (r.excluded) {
      tokens.push({
        marketId: r.market.marketId,
        slug: r.market.slug ?? null,
        outcome: r.outcome.label,
        tokenId: r.outcome.id || null,
        marketPrice: r.price,
        pEstimate: r.price,
        edge: 0,
        whaleFlowUsd: r.whaleFlow,
        sentimentTilt: 0,
        kellyRaw: 0,
        weight: 0,
        liquidityUsd: r.liquidityUsd,
        resolutionDate: r.market.resolutionDate ?? null,
        excluded: true,
        excludeReason: r.excludeReason,
      });
      continue;
    }

    // Whale tilt — z-score across active rows with whale data; 0 otherwise.
    let whaleContribution = 0;
    if (r.whaleFlow !== null && whaleFlows.length >= 2) {
      const z = zScore(r.whaleFlow, whaleFlows);
      whaleContribution = cfg.whaleWeight * tanh(z);
    }

    // Sentiment tilt — crypto-up markets only, binary only.
    const tilt = sentimentTilt(
      r.market.question,
      r.outcome.label,
      fearGreed,
      cfg.sentimentWeight,
      r.market.outcomes.length,
    );

    const pEstimate = clip(
      r.price + whaleContribution + tilt,
      cfg.minPriceBound,
      cfg.maxPriceBound,
    );
    const edge = pEstimate - r.price;
    const b = (1 - r.price) / r.price; // decimal-odds return
    const kellyRaw = b > 0 ? edge / b : 0;
    let weight = cfg.kellyScale * kellyRaw;
    weight = clip(weight, -cfg.maxWeightPerToken, cfg.maxWeightPerToken);

    tokens.push({
      marketId: r.market.marketId,
      slug: r.market.slug ?? null,
      outcome: r.outcome.label,
      tokenId: r.outcome.id || null,
      marketPrice: r.price,
      pEstimate,
      edge,
      whaleFlowUsd: r.whaleFlow,
      sentimentTilt: tilt,
      kellyRaw,
      weight,
      liquidityUsd: r.liquidityUsd,
      resolutionDate: r.market.resolutionDate ?? null,
      excluded: false,
      excludeReason: null,
    });
  }

  // Pass 2: scale all weights down proportionally if total exposure exceeded.
  const totalAbs = tokens.reduce((s, t) => s + Math.abs(t.weight), 0);
  if (totalAbs > cfg.maxTotalExposure && totalAbs > 0) {
    const scale = cfg.maxTotalExposure / totalAbs;
    for (const t of tokens) {
      t.weight = t.weight * scale;
    }
  }

  const finalExposure = tokens.reduce((s, t) => s + Math.abs(t.weight), 0);
  const nActive = tokens.filter((t) => !t.excluded).length;

  return {
    runId,
    runTimestamp,
    nMarkets: input.markets.length,
    nActive,
    totalExposure: finalExposure,
    tokens,
    durationMs: Date.now() - t0,
  };
}
