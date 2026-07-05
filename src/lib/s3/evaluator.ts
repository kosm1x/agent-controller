/**
 * v7.7 Spine 2 (S3 substrate) — signal evaluator.
 *
 * For one signal: runs its baseline_query, evaluates the observed value
 * against the tolerance rule, persists a drift_alert row if tripped,
 * updates drift_signals.last_evaluated_at + last_observed_value_json.
 *
 * Query dispatch:
 *   - SQL strings (most signals) → getDatabase().prepare(...).get()
 *   - prom: sentinels → resolve via prom-client registry
 *   - awaiting: sentinels → no-op, signal is disabled by convention
 *
 * Disabled signals are skipped at the loadEnabledSignals layer; the
 * evaluator never sees them.
 */

import client from "prom-client";
import { getDatabase } from "../../db/index.js";
import { recordEvaluation, type DriftSignal } from "./registry.js";
import {
  evaluateTolerance,
  type BaselinePayload,
  type DeviationKind,
  type ToleranceRule,
} from "./tolerance.js";
import { errMsg } from "../err-msg.js";

export interface DriftAlertRecord {
  id: number;
  signal_id: number;
  triggered_at: string;
  observed_value_json: string;
  baseline_value_json: string;
  deviation_kind: DeviationKind;
  severity: "P0" | "P1" | "P2";
}

/**
 * Evaluate one signal end-to-end. Returns the alert id if one was emitted,
 * null if no trip. Errors in the baseline_query layer become P2 alerts
 * with deviation_kind='query_failure' per spec §7 pseudocode.
 */
export async function evaluateSignal(
  signal: DriftSignal,
): Promise<number | null> {
  // Awaiting-source signals are seeded enabled=0; this is a belt-and-suspenders
  // check so a misconfigured enable doesn't trigger query attempts on stubs.
  if (signal.baseline_query.startsWith("awaiting:")) {
    return null;
  }

  let observed: number | string | null;
  let queryFailed = false;
  let queryError: string | undefined;

  try {
    observed = await runBaselineQuery(signal.baseline_query);
  } catch (err) {
    queryFailed = true;
    queryError = errMsg(err);
    observed = null;
  }

  const observedJson = JSON.stringify({ value: observed, error: queryError });

  if (queryFailed) {
    const alertId = emitAlert(
      signal,
      observedJson,
      "query_failure",
      "P2", // query failures are always P2 per spec §7
    );
    recordEvaluation(signal.id, observedJson, alertId);
    return alertId;
  }

  // Parse baseline + tolerance from JSON columns
  let baseline: BaselinePayload;
  let tolerance: ToleranceRule;
  try {
    baseline = JSON.parse(signal.baseline_value_json) as BaselinePayload;
    tolerance = JSON.parse(signal.tolerance_json) as ToleranceRule;
  } catch (err) {
    // Schema-corrupt signal — emit query_failure rather than crash. Operator
    // sees the bad signal in the alerts table; can fix via migration.
    const detail = `bad signal JSON: ${errMsg(err)}`;
    const alertId = emitAlert(
      signal,
      JSON.stringify({ value: observed, error: detail }),
      "query_failure",
      "P2",
    );
    recordEvaluation(signal.id, observedJson, alertId);
    return alertId;
  }

  const result = evaluateTolerance(observed, baseline, tolerance);
  if (!result.tripped) {
    recordEvaluation(signal.id, observedJson, null);
    return null;
  }

  const alertId = emitAlert(
    signal,
    observedJson,
    result.deviationKind ?? "changed",
    signal.alert_priority,
  );
  recordEvaluation(signal.id, observedJson, alertId);
  return alertId;
}

/**
 * Dispatch a baseline_query string to its handler. Three forms:
 *   - "SELECT ..." → SQL through getDatabase().prepare().get(), returns
 *     the first column of the first row (or null when no rows).
 *   - "prom:<metric_name>" → read counter value from prom-client registry.
 *     Returns the SUM across all label combinations (so a counter with
 *     bucketed labels still produces a single scalar). Returns 0 when the
 *     metric is registered but has no samples yet.
 *   - "awaiting:..." → caller should skip; throws as a defensive check.
 */
export async function runBaselineQuery(
  query: string,
): Promise<number | string | null> {
  // R1-I1 trust model: drift_signals.baseline_query is operator-managed
  // (seeded via SEED_SIGNALS or inserted via a future operator-only CLI).
  // No external producer writes to it. Multi-statement injection (e.g.
  // 'SELECT 1; DROP TABLE x;') is rejected by better-sqlite3.prepare() with
  // 'supplied SQL string contains more than one statement'; that throw is
  // caught at the evaluateSignal layer and becomes a P2 query_failure alert.
  if (query.startsWith("awaiting:")) {
    throw new Error(
      `runBaselineQuery called on awaiting-source signal: ${query}`,
    );
  }
  if (query.startsWith("prom:")) {
    const metricName = query.slice("prom:".length).trim();
    const metric = client.register.getSingleMetric(metricName);
    if (!metric) {
      throw new Error(`prom metric not registered: ${metricName}`);
    }
    const metricJson = await metric.get();
    // Sum across all label combinations for a single scalar.
    let total = 0;
    if (Array.isArray(metricJson.values)) {
      for (const v of metricJson.values) {
        if (typeof v.value === "number" && Number.isFinite(v.value)) {
          total += v.value;
        }
      }
    }
    return total;
  }
  // SQL path
  const row = getDatabase().prepare(query).get();
  if (row === undefined || row === null) return null;
  // Return the first column's value
  const firstKey = Object.keys(row)[0];
  if (!firstKey) return null;
  const val = (row as Record<string, unknown>)[firstKey];
  if (val === null || val === undefined) return null;
  if (typeof val === "number" || typeof val === "string") return val;
  return null;
}

function emitAlert(
  signal: DriftSignal,
  observedJson: string,
  deviationKind: DeviationKind,
  severity: "P0" | "P1" | "P2",
): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO drift_alerts
         (signal_id, triggered_at, observed_value_json, baseline_value_json,
          deviation_kind, severity, delivery_status)
       VALUES (?, datetime('now'), ?, ?, ?, ?, 'pending')`,
    )
    .run(
      signal.id,
      observedJson,
      signal.baseline_value_json,
      deviationKind,
      severity,
    );
  return Number(result.lastInsertRowid);
}
