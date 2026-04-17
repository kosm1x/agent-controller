/**
 * F5 Macro Regime Classifier — rules-based, deterministic.
 *
 * Consumes MacroPoint series from DataLayer.getMacro() (FRED + Alpha Vantage)
 * and produces a regime label with confidence + the why-list.
 *
 * Regimes:
 *   expansion      — yield curve positive, unemployment falling, low vol (VIX<20)
 *   tightening     — fed funds rising, M2 contracting
 *   recession_risk — yield curve inverted AND unemployment rising
 *   recovery       — yield curve normalizing, unemployment peaking
 *   mixed          — conflicting signals (none fire cleanly, or multiple tie)
 *
 * Every rule evaluates hard (all conditions) vs soft (most conditions) and
 * attaches a confidence (0.85 hard, 0.55 soft, 0.3 mixed). Caller reads
 * `reasons[]` for the why-list and `confidence` for the strength.
 */

import type { MacroPoint } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Regime =
  | "expansion"
  | "tightening"
  | "recession_risk"
  | "recovery"
  | "mixed";

export type Trend = "rising" | "falling" | "flat" | "normalizing";

export interface MacroSeriesBundle {
  fedFunds: MacroPoint[];
  treasury2y: MacroPoint[];
  treasury10y: MacroPoint[];
  cpi: MacroPoint[];
  unemployment: MacroPoint[];
  m2: MacroPoint[];
  vixcls: MacroPoint[];
  icsa: MacroPoint[];
}

export interface MacroRegime {
  regime: Regime;
  confidence: number;
  yieldCurve: number | null; // 10Y - 2Y
  fedRate: number | null;
  vix: number | null;
  unemployment: number | null;
  inflationYoY: number | null;
  m2GrowthYoY: number | null;
  initialClaims: number | null;
  reasons: string[];
  staleness: string[]; // series whose latest value is > 60 days old
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Return the most recent value of a series, or null if empty. */
export function latestMacroValue(series: MacroPoint[]): number | null {
  if (series.length === 0) return null;
  return series[series.length - 1].value;
}

/** Year-over-year percentage change vs the value nearest-to 365d ago. */
export function yoyChange(series: MacroPoint[]): number | null {
  if (series.length === 0) return null;
  const latest = series[series.length - 1];
  const latestTs = Date.parse(latest.date + "T00:00:00Z");
  const target = latestTs - 365 * 24 * 60 * 60 * 1000;
  // Find closest earlier point
  let best: MacroPoint | null = null;
  let bestDelta = Infinity;
  for (const p of series) {
    const pts = Date.parse(p.date + "T00:00:00Z");
    if (pts > latestTs) continue;
    const delta = Math.abs(pts - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  if (!best || best.value === 0) return null;
  return ((latest.value - best.value) / best.value) * 100;
}

/**
 * Classify the trend of a series using the last N points.
 *   rising:      slope over last 3 > 0 AND latest > mean(prior 6)
 *   falling:     slope over last 3 < 0 AND latest < mean(prior 6)
 *   flat:        neither
 *   normalizing: sign change in slope over the last 6 periods (rising-then-flat or falling-then-flat)
 */
export function classifyTrend(series: MacroPoint[]): Trend {
  if (series.length < 4) return "flat";
  const values = series.map((p) => p.value);
  const n = values.length;
  // Short-term slope: last 3 points
  const shortSlope = linearSlope(values.slice(-3));
  // Priors: average of values[n-9 ... n-4] if available, else what we have
  const priorStart = Math.max(0, n - 9);
  const priorEnd = Math.max(1, n - 3);
  const priors = values.slice(priorStart, priorEnd);
  const priorMean =
    priors.length > 0
      ? priors.reduce((a, b) => a + b, 0) / priors.length
      : values[0];
  const latest = values[n - 1];

  // Normalization detection: scale threshold to series magnitude so a slope
  // of 0.05 on M2 (~20000) doesn't get treated as "strong" but 0.05 on fed
  // funds (~5) does. Audit W1.
  if (n >= 6) {
    const earlier = linearSlope(values.slice(-6, -3));
    const later = shortSlope;
    const magnitudeFloor =
      Math.max(Math.abs(priorMean), Math.abs(latest), 1) * 0.001;
    if (
      Math.abs(earlier) > magnitudeFloor &&
      Math.sign(earlier) !== Math.sign(later)
    ) {
      return "normalizing";
    }
    if (
      Math.abs(earlier) > magnitudeFloor &&
      Math.abs(later) < Math.abs(earlier) * 0.3
    ) {
      return "normalizing";
    }
  }

  if (shortSlope > 0 && latest > priorMean) return "rising";
  if (shortSlope < 0 && latest < priorMean) return "falling";
  return "flat";
}

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  // Simple least-squares slope against indices 0..n-1
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Days between the series' latest observation and today. Used to flag
 * staleness in `reasons[]` so the LLM knows which macro inputs are recent.
 */
export function seriesStalenessDays(series: MacroPoint[]): number {
  if (series.length === 0) return Infinity;
  const latestTs = Date.parse(series[series.length - 1].date + "T00:00:00Z");
  return Math.floor((Date.now() - latestTs) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

interface RuleMatch {
  regime: Regime;
  confidence: number;
  reasons: string[];
  matched: number; // count of conditions met
  required: number; // total conditions
}

/**
 * Main entrypoint. Consumers pass in the whole bundle; missing series
 * are tolerated (classifier will note in reasons which were unavailable).
 */
export function classifyRegime(series: MacroSeriesBundle): MacroRegime {
  const t10 = latestMacroValue(series.treasury10y);
  const t2 = latestMacroValue(series.treasury2y);
  const yieldCurve = t10 !== null && t2 !== null ? t10 - t2 : null;

  const fedRate = latestMacroValue(series.fedFunds);
  const vix = latestMacroValue(series.vixcls);
  const unemployment = latestMacroValue(series.unemployment);
  const inflationYoY = yoyChange(series.cpi);
  const m2GrowthYoY = yoyChange(series.m2);
  const initialClaims = latestMacroValue(series.icsa);

  const unemploymentTrend = classifyTrend(series.unemployment);
  const fedTrend = classifyTrend(series.fedFunds);
  const m2Trend = classifyTrend(series.m2);
  const yieldCurveTrend =
    yieldCurve === null ? "flat" : classifyYieldCurve(series);

  const reasons: string[] = [];
  const staleness: string[] = [];

  // Staleness check
  for (const [name, s] of Object.entries(series) as [
    keyof MacroSeriesBundle,
    MacroPoint[],
  ][]) {
    const days = seriesStalenessDays(s);
    if (days > 60 && Number.isFinite(days)) {
      staleness.push(`${name}:${days}d`);
    }
  }

  const rules: RuleMatch[] = [];

  // Rule 1: recession_risk — yield curve inverted AND unemployment rising
  {
    let matched = 0;
    const required = 2;
    const why: string[] = [];
    if (yieldCurve !== null && yieldCurve < 0) {
      matched++;
      why.push(`yield curve inverted (${yieldCurve.toFixed(2)})`);
    }
    if (unemploymentTrend === "rising") {
      matched++;
      why.push("unemployment rising");
    }
    if (matched === required) {
      rules.push({
        regime: "recession_risk",
        confidence: 0.85,
        reasons: why,
        matched,
        required,
      });
    } else if (matched === 1) {
      rules.push({
        regime: "recession_risk",
        confidence: 0.55,
        reasons: why,
        matched,
        required,
      });
    }
  }

  // Rule 2: tightening — fed rate rising AND M2 falling
  {
    let matched = 0;
    const required = 2;
    const why: string[] = [];
    if (fedTrend === "rising") {
      matched++;
      why.push("fed funds rising");
    }
    if (m2Trend === "falling") {
      matched++;
      why.push("M2 contracting");
    }
    if (matched === required) {
      rules.push({
        regime: "tightening",
        confidence: 0.85,
        reasons: why,
        matched,
        required,
      });
    } else if (matched === 1) {
      rules.push({
        regime: "tightening",
        confidence: 0.55,
        reasons: why,
        matched,
        required,
      });
    }
  }

  // Rule 3: expansion — yield curve positive > 0.5 AND unemployment falling AND VIX < 20
  {
    let matched = 0;
    const required = 3;
    const why: string[] = [];
    if (yieldCurve !== null && yieldCurve > 0.5) {
      matched++;
      why.push(`yield curve positive (+${yieldCurve.toFixed(2)})`);
    }
    if (unemploymentTrend === "falling") {
      matched++;
      why.push("unemployment falling");
    }
    if (vix !== null && vix < 20) {
      matched++;
      why.push(`VIX low (${vix.toFixed(1)})`);
    }
    if (matched === required) {
      rules.push({
        regime: "expansion",
        confidence: 0.85,
        reasons: why,
        matched,
        required,
      });
    } else if (matched === required - 1) {
      rules.push({
        regime: "expansion",
        confidence: 0.55,
        reasons: why,
        matched,
        required,
      });
    }
  }

  // Rule 4: recovery — yield curve normalizing AND unemployment normalizing.
  // Requires explicit normalizing sign-change on both sides. A bare "flat"
  // series doesn't count — it fires spuriously when the data is missing.
  {
    let matched = 0;
    const required = 2;
    const why: string[] = [];
    if (yieldCurveTrend === "normalizing") {
      matched++;
      why.push("yield curve normalizing");
    }
    if (unemploymentTrend === "normalizing") {
      matched++;
      why.push("unemployment normalizing");
    }
    if (matched === required) {
      rules.push({
        regime: "recovery",
        confidence: 0.85,
        reasons: why,
        matched,
        required,
      });
    } else if (matched === 1) {
      rules.push({
        regime: "recovery",
        confidence: 0.55,
        reasons: why,
        matched,
        required,
      });
    }
  }

  // Conflict resolution. Audit W3: when multiple hard rules fire, order by
  // downside-asymmetry severity (recession_risk > tightening > expansion >
  // recovery) — classic pattern like "fed hiking into a yield-curve inversion"
  // should surface as recession_risk, not mixed. Loser regimes fold into reasons[].
  const severity: Record<Regime, number> = {
    recession_risk: 4,
    tightening: 3,
    expansion: 2,
    recovery: 1,
    mixed: 0,
  };
  const hard = rules.filter((r) => r.confidence === 0.85);
  let chosen: RuleMatch;
  if (hard.length === 1) {
    chosen = hard[0];
  } else if (hard.length > 1) {
    hard.sort((a, b) => severity[b.regime] - severity[a.regime]);
    chosen = {
      ...hard[0],
      reasons: [
        ...hard[0].reasons,
        `also fired hard: ${hard
          .slice(1)
          .map((h) => h.regime)
          .join(", ")}`,
      ],
    };
  } else {
    // No hard match — pick soft match with most-matched conditions
    const soft = rules.filter((r) => r.confidence === 0.55);
    if (soft.length > 0) {
      soft.sort((a, b) => b.matched / b.required - a.matched / a.required);
      chosen = soft[0];
    } else {
      chosen = {
        regime: "mixed",
        confidence: 0.3,
        reasons: ["no rule conditions met cleanly"],
        matched: 0,
        required: 0,
      };
    }
  }

  reasons.push(...chosen.reasons);
  if (staleness.length > 0) {
    reasons.push(`stale series: ${staleness.join(", ")}`);
  }

  return {
    regime: chosen.regime,
    confidence: chosen.confidence,
    yieldCurve,
    fedRate,
    vix,
    unemployment,
    inflationYoY,
    m2GrowthYoY,
    initialClaims,
    reasons,
    staleness,
  };
}

/**
 * Yield-curve trend computed over date-aligned pairs. Uses nearest-earlier
 * t2 for each t10 observation rather than exact-date Map join — t2 and t10
 * series may arrive on different cadences (daily vs monthly) and exact-match
 * would collapse the aligned set to 0-12 points over a year, silently
 * forcing classifyTrend → "flat". Audit C1.
 */
function classifyYieldCurve(series: MacroSeriesBundle): Trend {
  if (series.treasury10y.length === 0 || series.treasury2y.length === 0) {
    return "flat";
  }
  // Sort both by date ascending (they arrive sorted from adapters but be safe)
  const t2Sorted = [...series.treasury2y].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );
  const curve: MacroPoint[] = [];
  for (const t10 of series.treasury10y) {
    // Find the latest t2 observation at or before t10.date
    let best: MacroPoint | null = null;
    for (const t2 of t2Sorted) {
      if (t2.date <= t10.date) best = t2;
      else break;
    }
    if (best !== null) {
      curve.push({
        series: "YIELD_CURVE",
        date: t10.date,
        value: t10.value - best.value,
        provider: t10.provider,
      });
    }
  }
  return classifyTrend(curve);
}
