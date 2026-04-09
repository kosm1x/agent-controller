/**
 * Drift Detection (Hermes H2) — rolling baseline comparison.
 *
 * Stores last N reflection scores per task type. Alerts when current
 * score deviates below rolling_avg - 1 stddev.
 *
 * Runs AFTER reflection — zero hot-path latency.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

const BASELINE_WINDOW = 20;
const MAX_STORED = 60; // Keep 3x window for pruning

export interface DriftResult {
  taskType: string;
  currentScore: number;
  rollingAvg: number;
  stdDev: number;
  drifting: boolean;
}

/**
 * Record a reflection score and check for drift.
 */
export function checkAndRecordDrift(
  taskType: string,
  currentScore: number,
): DriftResult {
  const db = getDatabase();

  // Query BEFORE inserting to avoid self-contamination (audit C1)
  const rows = db
    .prepare(
      `SELECT score FROM reflection_baselines
       WHERE task_type = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(taskType, BASELINE_WINDOW) as Array<{ score: number }>;

  writeWithRetry(() =>
    db
      .prepare(
        "INSERT INTO reflection_baselines (task_type, score) VALUES (?, ?)",
      )
      .run(taskType, currentScore),
  );

  if (rows.length < 5) {
    return {
      taskType,
      currentScore,
      rollingAvg: currentScore,
      stdDev: 0,
      drifting: false,
    };
  }

  const scores = rows.map((r) => r.score);
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance =
    scores.reduce((s, v) => s + (v - avg) ** 2, 0) / scores.length;
  const stdDev = Math.sqrt(variance);

  return {
    taskType,
    currentScore,
    rollingAvg: avg,
    stdDev,
    drifting: currentScore < avg - stdDev,
  };
}

/**
 * Prune old baselines — keep only the last MAX_STORED per type.
 */
export function pruneBaselines(taskType: string): void {
  const db = getDatabase();
  try {
    db.prepare(
      `DELETE FROM reflection_baselines
       WHERE task_type = ? AND id NOT IN (
         SELECT id FROM reflection_baselines
         WHERE task_type = ?
         ORDER BY created_at DESC
         LIMIT ?
       )`,
    ).run(taskType, taskType, MAX_STORED);
  } catch {
    // Non-fatal
  }
}
