/**
 * Delta engine — compares current signals against snapshots,
 * computes severity based on metric thresholds.
 *
 * Adapted from Crucix pattern: metric definitions with thresholds,
 * change_ratio = abs(current - previous) / threshold,
 * severity = critical > high > moderate > normal.
 */

import type { MetricDefinition, Signal, Delta, Severity } from "./types.js";
import { getSnapshot, upsertSnapshot } from "./signal-store.js";

// ---------------------------------------------------------------------------
// Metric definitions (from V5-INTELLIGENCE-DEPOT.md)
// ---------------------------------------------------------------------------

export const METRICS: MetricDefinition[] = [
  // Financial (finnhub/oilprice adapters planned for when API keys are configured)
  {
    source: "finnhub",
    key: "VIX",
    type: "numeric",
    threshold: 10,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  {
    source: "finnhub",
    key: "SPY",
    type: "numeric",
    threshold: 2,
    riskSensitive: true,
    direction: "down_is_bad",
  },
  {
    source: "finnhub",
    key: "DXY",
    type: "numeric",
    threshold: 1,
    riskSensitive: true,
    direction: "any_change",
  },
  {
    source: "coingecko",
    key: "bitcoin",
    type: "numeric",
    threshold: 5,
    riskSensitive: false,
    direction: "any_change",
  },
  {
    source: "frankfurter",
    key: "MXN",
    type: "numeric",
    threshold: 2,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  {
    source: "treasury",
    key: "10Y",
    type: "numeric",
    threshold: 5,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  {
    source: "oilprice",
    key: "WTI",
    type: "numeric",
    threshold: 5,
    riskSensitive: true,
    direction: "up_is_bad",
  },
  // Geopolitical
  {
    source: "gdelt",
    key: "conflict_articles",
    type: "count",
    threshold: 50,
    riskSensitive: true,
  },
  {
    source: "gdelt",
    key: "goldstein_avg",
    type: "numeric",
    threshold: 15,
    riskSensitive: true,
    direction: "down_is_bad",
  },
  // Cyber
  {
    source: "cisa_kev",
    key: "new_vulns",
    type: "count",
    threshold: 3,
    riskSensitive: false,
  },
  {
    // placeholder — nvd adapter planned (needs free API key)
    source: "nvd",
    key: "critical_cves_24h",
    type: "count",
    threshold: 5,
    riskSensitive: false,
  },
  // Natural
  {
    source: "usgs",
    key: "quakes_5plus",
    type: "count",
    threshold: 2,
    riskSensitive: false,
  },
  {
    source: "nws",
    key: "active_warnings",
    type: "count",
    threshold: 10,
    riskSensitive: false,
  },
  // Health (who adapter planned — no auth, 6h polling)
  {
    source: "who",
    key: "new_outbreaks",
    type: "count",
    threshold: 2,
    riskSensitive: false,
  },
  // Infrastructure (cloudflare needs API key, ioda is free)
  {
    source: "cloudflare",
    key: "anomalies_24h",
    type: "count",
    threshold: 5,
    riskSensitive: false,
  },
  {
    source: "ioda",
    key: "outage_events",
    type: "count",
    threshold: 3,
    riskSensitive: false,
  },
];

// Build lookup for O(1) metric access
const METRIC_MAP = new Map<string, MetricDefinition>();
for (const m of METRICS) {
  METRIC_MAP.set(`${m.source}:${m.key}`, m);
}

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

export function classifySeverity(changeRatio: number): Severity {
  if (changeRatio > 3.0) return "critical";
  if (changeRatio > 2.0) return "high";
  if (changeRatio > 1.0) return "moderate";
  return "normal";
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Compute delta for a single metric.
 * Returns null if no metric definition exists for this source+key.
 */
export function computeDelta(
  source: string,
  key: string,
  current: number,
  previous: number | null,
): Delta | null {
  const metric = METRIC_MAP.get(`${source}:${key}`);
  if (!metric) return null;

  // First observation — no previous data
  if (previous === null || previous === undefined) {
    return {
      source,
      key,
      previous: null,
      current,
      changeRatio: 0,
      severity: "normal",
    };
  }

  // Guard: avoid division by zero when threshold is 0
  if (metric.threshold === 0) {
    return {
      source,
      key,
      previous,
      current,
      changeRatio: 0,
      severity: "normal",
    };
  }

  let changeRatio: number;
  if (metric.type === "numeric") {
    // Percentage change relative to threshold
    if (previous === 0) {
      changeRatio = current !== 0 ? metric.threshold : 0;
    } else {
      const pctChange = Math.abs((current - previous) / previous) * 100;
      changeRatio = pctChange / metric.threshold;
    }
  } else {
    // Count: absolute change relative to threshold
    changeRatio = Math.abs(current - previous) / metric.threshold;
  }

  return {
    source,
    key,
    previous,
    current,
    changeRatio: Math.round(changeRatio * 100) / 100,
    severity: classifySeverity(changeRatio),
  };
}

/**
 * Process a batch of signals: compute deltas against snapshots, update snapshots.
 * Returns only deltas above "normal" severity.
 */
export function processSignals(signals: Signal[]): Delta[] {
  const deltas: Delta[] = [];

  for (const signal of signals) {
    if (signal.valueNumeric === undefined) continue;

    const snapshot = getSnapshot(signal.source, signal.key);
    const previous = snapshot?.last_value_numeric ?? null;

    const delta = computeDelta(
      signal.source,
      signal.key,
      signal.valueNumeric,
      previous,
    );

    // Update snapshot regardless of delta result
    upsertSnapshot(
      signal.source,
      signal.key,
      signal.valueNumeric,
      signal.valueText ?? null,
      signal.contentHash ?? null,
    );

    if (delta && delta.severity !== "normal") {
      deltas.push(delta);
    }
  }

  return deltas;
}

/** Get the metric definition for a source+key, if it exists. */
export function getMetric(
  source: string,
  key: string,
): MetricDefinition | undefined {
  return METRIC_MAP.get(`${source}:${key}`);
}
