/**
 * Statistical baselines — rolling mean/stddev for numeric signals.
 * Used for anomaly detection via z-scores.
 *
 * Windows: 24h and 7d (1h/6h/30d deferred — insufficient data volume).
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { METRICS } from "./delta-engine.js";
import { errMsg } from "../lib/err-msg.js";

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

  // Statements prepared once, reused across the windows loop.
  // Algebraic identity: STDDEV = SQRT(E[x^2] - E[x]^2) — avoids correlated subqueries.
  // The variance is clamped at 0: for a constant series floating-point rounding
  // can make it slightly negative, and SQRT of a negative is NULL.
  const selectStmt = db.prepare(
    `SELECT
       AVG(value_numeric) as mean,
       CASE WHEN COUNT(*) > 1
         THEN SQRT(MAX(0,
           (SUM(value_numeric * value_numeric) - SUM(value_numeric) * SUM(value_numeric) / COUNT(*))
           / (COUNT(*) - 1)
         ))
         ELSE 0
       END as stddev,
       MIN(value_numeric) as min_val,
       MAX(value_numeric) as max_val,
       COUNT(*) as sample_count
     FROM signals
     WHERE source = ? AND key = ? AND value_numeric IS NOT NULL
       AND collected_at >= datetime('now', '-' || ? || ' hours')`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO signal_baselines (source, key, window, mean, stddev, min_val, max_val, sample_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, key, window) DO UPDATE SET
       mean = excluded.mean,
       stddev = excluded.stddev,
       min_val = excluded.min_val,
       max_val = excluded.max_val,
       sample_count = excluded.sample_count,
       computed_at = datetime('now')`,
  );

  for (const w of WINDOWS) {
    const row = selectStmt.get(source, key, w.hours) as {
      mean: number | null;
      stddev: number;
      min_val: number | null;
      max_val: number | null;
      sample_count: number;
    };

    if (!row || row.sample_count < 2 || row.mean === null) continue;

    writeWithRetry(() =>
      upsertStmt.run(
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

/**
 * Compute baselines for all known metrics. A failing metric is logged and
 * counted; it does not stop the others. `ok` counts metrics whose compute did
 * not throw, including those with too few samples to write a row.
 */
export function computeAllBaselines(): { ok: number; failed: number } {
  let failed = 0;
  for (const m of METRICS) {
    try {
      computeBaseline(m.source, m.key);
    } catch (err) {
      failed++;
      console.warn(`[intel] baseline ${m.source}/${m.key} failed: ${errMsg(err)}`);
    }
  }
  return { ok: METRICS.length - failed, failed };
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
