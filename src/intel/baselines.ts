/**
 * Statistical baselines — rolling mean/stddev for numeric signals.
 * Used for anomaly detection via z-scores.
 *
 * Windows: 24h and 7d (1h/6h/30d deferred — insufficient data volume).
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { METRICS } from "./delta-engine.js";

export interface BaselineRow {
  source: string;
  key: string;
  window: string;
  mean: number;
  stddev: number;
  min_val: number | null;
  max_val: number | null;
  sample_count: number;
  computed_at: string;
}

const WINDOWS: Array<{ name: string; hours: number }> = [
  { name: "24h", hours: 24 },
  { name: "7d", hours: 168 },
];

/**
 * Compute baselines for a single metric (source+key) across all windows.
 * Reads from signals table, UPSERTs into signal_baselines.
 */
export function computeBaseline(source: string, key: string): void {
  const db = getDatabase();

  for (const w of WINDOWS) {
    // Algebraic identity: STDDEV = SQRT(E[x^2] - E[x]^2) — avoids correlated subqueries
    const row = db
      .prepare(
        `SELECT
           AVG(value_numeric) as mean,
           CASE WHEN COUNT(*) > 1
             THEN SQRT(
               (SUM(value_numeric * value_numeric) - SUM(value_numeric) * SUM(value_numeric) / COUNT(*))
               / (COUNT(*) - 1)
             )
             ELSE 0
           END as stddev,
           MIN(value_numeric) as min_val,
           MAX(value_numeric) as max_val,
           COUNT(*) as sample_count
         FROM signals
         WHERE source = ?1 AND key = ?2 AND value_numeric IS NOT NULL
           AND collected_at >= datetime('now', '-' || ?3 || ' hours')`,
      )
      .get(source, key, w.hours) as {
      mean: number | null;
      stddev: number;
      min_val: number | null;
      max_val: number | null;
      sample_count: number;
    };

    if (!row || row.sample_count < 2 || row.mean === null) continue;

    writeWithRetry(() =>
      db
        .prepare(
          `INSERT INTO signal_baselines (source, key, window, mean, stddev, min_val, max_val, sample_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, key, window) DO UPDATE SET
             mean = excluded.mean,
             stddev = excluded.stddev,
             min_val = excluded.min_val,
             max_val = excluded.max_val,
             sample_count = excluded.sample_count,
             computed_at = datetime('now')`,
        )
        .run(
          source,
          key,
          w.name,
          row.mean,
          row.stddev,
          row.min_val,
          row.max_val,
          row.sample_count,
        ),
    );
  }
}

/** Compute baselines for all known metrics. */
export function computeAllBaselines(): void {
  for (const m of METRICS) {
    try {
      computeBaseline(m.source, m.key);
    } catch {
      // Non-fatal — individual metric failure shouldn't block others
    }
  }
}

/** Get baseline for a specific metric and window. */
export function getBaseline(
  source: string,
  key: string,
  window: string = "24h",
): BaselineRow | undefined {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM signal_baselines WHERE source = ? AND key = ? AND window = ?",
    )
    .get(source, key, window) as BaselineRow | undefined;
}

/** Get all baselines for a metric across all windows. */
export function getBaselines(source: string, key: string): BaselineRow[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM signal_baselines WHERE source = ? AND key = ? ORDER BY window",
    )
    .all(source, key) as BaselineRow[];
}

/**
 * Compute z-score of a value against a baseline.
 * Returns 0 if stddev is 0 (no variation).
 */
export function computeZScore(current: number, baseline: BaselineRow): number {
  if (baseline.stddev === 0) return 0;
  return Math.round(((current - baseline.mean) / baseline.stddev) * 100) / 100;
}
