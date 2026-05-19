/**
 * v7.7 Spine 2 (S3 substrate) — drift_signals registry CRUD.
 *
 * Thin wrapper over the drift_signals table. The registry is mostly read-heavy
 * (evaluator + cron walks enabled signals); writes happen at seed time + when
 * an operator enables/disables a signal or updates its baseline.
 *
 * Signal updates that change baseline_value_json also write a baseline_history
 * row per spec §6 (audit trail).
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";

export type Cadence = "hourly" | "every_4h" | "nightly" | "weekly" | "on_event";
export type AlertPriority = "P0" | "P1" | "P2";

export interface DriftSignal {
  id: number;
  signal_name: string;
  signal_kind: string;
  source_substrate: string;
  baseline_query: string;
  baseline_value_json: string;
  tolerance_json: string;
  cadence: Cadence;
  alert_priority: AlertPriority;
  enabled: number;
  established_at: string;
  established_by: string;
  notes: string | null;
  last_evaluated_at: string | null;
  last_observed_value_json: string | null;
  last_alert_id: number | null;
}

export interface NewDriftSignal {
  signal_name: string;
  signal_kind: string;
  source_substrate: string;
  baseline_query: string;
  baseline_value_json: string;
  tolerance_json: string;
  cadence: Cadence;
  alert_priority: AlertPriority;
  enabled?: number;
  established_at: string;
  established_by: string;
  notes?: string;
}

/**
 * Insert a signal if its signal_name doesn't already exist. Returns the
 * resulting row's id. Used by seed-signals on first boot — idempotent so
 * re-runs of the seed are safe (boot of fresh `:memory:` test DBs, etc.).
 */
export function insertSignalIfMissing(s: NewDriftSignal): number {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM drift_signals WHERE signal_name = ?")
    .get(s.signal_name) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare(
      `INSERT INTO drift_signals
         (signal_name, signal_kind, source_substrate, baseline_query,
          baseline_value_json, tolerance_json, cadence, alert_priority,
          enabled, established_at, established_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.signal_name,
      s.signal_kind,
      s.source_substrate,
      s.baseline_query,
      s.baseline_value_json,
      s.tolerance_json,
      s.cadence,
      s.alert_priority,
      s.enabled ?? 1,
      s.established_at,
      s.established_by,
      s.notes ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Load all enabled signals for the given cadence. Used by the scheduler to
 * walk per-cadence cron jobs.
 */
export function loadEnabledSignalsByCadence(cadence: Cadence): DriftSignal[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM drift_signals WHERE enabled = 1 AND cadence = ? ORDER BY alert_priority, signal_name",
    )
    .all(cadence) as DriftSignal[];
}

/** Load every enabled signal regardless of cadence. */
export function loadAllEnabledSignals(): DriftSignal[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM drift_signals WHERE enabled = 1 ORDER BY cadence, alert_priority, signal_name",
    )
    .all() as DriftSignal[];
}

/**
 * Load every signal regardless of enabled state — used for the registry-
 * inventory CLI / dashboard endpoint, NOT for evaluation.
 */
export function loadAllSignals(): DriftSignal[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM drift_signals ORDER BY cadence, alert_priority, signal_name",
    )
    .all() as DriftSignal[];
}

/** Record an evaluation result (idempotent per call — just updates the row). */
export function recordEvaluation(
  signalId: number,
  observedValueJson: string,
  alertId: number | null,
): void {
  getDatabase()
    .prepare(
      `UPDATE drift_signals
       SET last_evaluated_at = datetime('now'),
           last_observed_value_json = ?,
           last_alert_id = COALESCE(?, last_alert_id)
       WHERE id = ?`,
    )
    .run(observedValueJson, alertId, signalId);
}

/** Helper for tests — accepts an injected DB so tests don't need getDatabase singleton. */
export function loadAllEnabledSignalsFromDb(
  db: Database.Database,
): DriftSignal[] {
  return db
    .prepare(
      "SELECT * FROM drift_signals WHERE enabled = 1 ORDER BY cadence, alert_priority, signal_name",
    )
    .all() as DriftSignal[];
}
