/**
 * Intelligence Depot types.
 *
 * Shared interfaces for the signal collection, delta computation,
 * and alerting pipeline (v5.0 S6–S8).
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface Signal {
  source: string;
  domain: string;
  signalType: "numeric" | "event" | "article" | "alert";
  key: string;
  valueNumeric?: number;
  valueText?: string;
  metadata?: Record<string, unknown>;
  geoLat?: number;
  geoLon?: number;
  contentHash?: string;
  sourceTimestamp?: string;
}

export interface SignalRow {
  id: number;
  source: string;
  domain: string;
  signal_type: string;
  key: string;
  value_numeric: number | null;
  value_text: string | null;
  metadata: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
  content_hash: string | null;
  collected_at: string;
  source_timestamp: string | null;
}

export interface SnapshotRow {
  source: string;
  key: string;
  last_value_numeric: number | null;
  last_value_text: string | null;
  last_hash: string | null;
  snapshot_at: string;
  run_count: number;
}

// ---------------------------------------------------------------------------
// Collector adapters
// ---------------------------------------------------------------------------

export interface CollectorAdapter {
  readonly source: string;
  readonly domain: string;
  readonly defaultInterval: number; // ms between polls (0 = stream-based)
  collect(): Promise<Signal[]>;
}

// ---------------------------------------------------------------------------
// Delta engine
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "moderate" | "normal";

export interface Delta {
  source: string;
  key: string;
  previous: number | null;
  current: number;
  changeRatio: number;
  severity: Severity;
}

export interface MetricDefinition {
  source: string;
  key: string;
  type: "numeric" | "count";
  threshold: number;
  riskSensitive: boolean;
  direction?: "up_is_bad" | "down_is_bad" | "any_change";
}

// ---------------------------------------------------------------------------
// Collector health
// ---------------------------------------------------------------------------

export interface CollectorHealth {
  source: string;
  lastSuccess: string | null;
  lastAttempt: string | null;
  consecutiveFailures: number;
  totalSignals: number;
}
