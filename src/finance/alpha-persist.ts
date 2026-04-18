/**
 * F7 — persistence + retrieval helpers for alpha runs.
 *
 * Writers:
 *   persistAlphaRun(result)   → inserts signal_weights + signal_isq rows
 *                               for a completed AlphaRunResult, all in one
 *                               better-sqlite3 transaction.
 *
 * Readers:
 *   readAlphaRunByRunId(runId)→ reconstructs AlphaRunResult from DB rows
 *   readLatestAlphaRun()      → returns most-recent completed run or null
 *   listRecentAlphaRuns(limit)→ summary list of recent run_ids
 *
 * Schema: see signal_weights + signal_isq in src/db/schema.sql. Additive
 * tables added for F7 (session 77).
 */

import { getDatabase } from "../db/index.js";
import type {
  AlphaRunResult,
  AlphaRunSignalResult,
} from "./alpha-combination.js";
import type { IsqDimensions } from "./alpha-isq.js";

interface WeightRow {
  run_id: string;
  run_timestamp: string;
  mode: "returns" | "probability";
  signal_key: string;
  signal_name: string;
  weight: number;
  epsilon: number | null;
  sigma: number | null;
  e_norm: number | null;
  ic_30d: number | null;
  regime: string | null;
  n_effective: number | null;
  excluded: number;
  exclude_reason: string | null;
}

interface IsqRow {
  run_id: string;
  signal_key: string;
  efficiency: number;
  timeliness: number;
  coverage: number;
  stability: number;
  forward_ic: number;
}

interface PersistStats {
  runId: string;
  weightsInserted: number;
  isqInserted: number;
}

/**
 * Persist an AlphaRunResult to signal_weights + signal_isq. Returns the
 * count of rows written. All inserts happen in a single transaction; if
 * any row fails (e.g., duplicate run_id + signal_key), the whole batch
 * rolls back.
 */
export function persistAlphaRun(result: AlphaRunResult): PersistStats {
  const db = getDatabase();
  const insertWeight = db.prepare(
    `INSERT INTO signal_weights
      (run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma, e_norm, ic_30d, regime, n_effective, excluded, exclude_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertIsq = db.prepare(
    `INSERT INTO signal_isq
      (run_id, signal_key, efficiency, timeliness, coverage, stability, forward_ic)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let weightsInserted = 0;
  let isqInserted = 0;
  const tx = db.transaction((signals: AlphaRunSignalResult[]) => {
    for (const s of signals) {
      insertWeight.run(
        result.runId,
        result.runTimestamp,
        result.mode,
        s.signalKey,
        `${s.signalType} on ${s.symbol}`,
        s.weight,
        s.epsilon,
        s.sigma,
        s.eNorm,
        s.ic30d,
        result.regime,
        result.NEffective,
        s.excluded ? 1 : 0,
        s.excludeReason,
      );
      weightsInserted++;
      if (s.isq) {
        insertIsq.run(
          result.runId,
          s.signalKey,
          s.isq.efficiency,
          s.isq.timeliness,
          s.isq.coverage,
          s.isq.stability,
          s.isq.forward_ic,
        );
        isqInserted++;
      }
    }
  });
  tx(result.signals);

  return { runId: result.runId, weightsInserted, isqInserted };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Load the most recently persisted run (ordered by run_timestamp DESC).
 * Returns null if no runs exist.
 */
export function readLatestAlphaRun(): AlphaRunResult | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT run_id FROM signal_weights ORDER BY run_timestamp DESC, id DESC LIMIT 1`,
    )
    .get() as { run_id?: string } | undefined;
  if (!row?.run_id) return null;
  return readAlphaRunByRunId(row.run_id);
}

/**
 * Reconstruct an AlphaRunResult from persisted rows. Returns null if no
 * rows match the runId. Note: `flags` and `durationMs` are not persisted,
 * so the reconstructed object has empty flags and durationMs=0.
 */
export function readAlphaRunByRunId(runId: string): AlphaRunResult | null {
  const db = getDatabase();
  const weights = db
    .prepare(
      `SELECT run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma, e_norm, ic_30d, regime, n_effective, excluded, exclude_reason
         FROM signal_weights
         WHERE run_id = ?
         ORDER BY id`,
    )
    .all(runId) as WeightRow[];
  if (weights.length === 0) return null;

  const isqRows = db
    .prepare(
      `SELECT run_id, signal_key, efficiency, timeliness, coverage, stability, forward_ic
         FROM signal_isq
         WHERE run_id = ?`,
    )
    .all(runId) as IsqRow[];
  const isqByKey = new Map<string, IsqDimensions>();
  for (const r of isqRows) {
    isqByKey.set(r.signal_key, {
      efficiency: r.efficiency,
      timeliness: r.timeliness,
      coverage: r.coverage,
      stability: r.stability,
      forward_ic: r.forward_ic,
    });
  }

  const first = weights[0]!;
  const signals: AlphaRunSignalResult[] = weights.map((w) => {
    const idx = w.signal_key.indexOf(":");
    const signalType = idx >= 0 ? w.signal_key.slice(0, idx) : w.signal_key;
    const symbol = idx >= 0 ? w.signal_key.slice(idx + 1) : "";
    return {
      signalKey: w.signal_key,
      signalType,
      symbol,
      weight: w.weight,
      epsilon: w.epsilon,
      sigma: w.sigma,
      eNorm: w.e_norm,
      ic30d: w.ic_30d,
      excluded: !!w.excluded,
      excludeReason:
        (w.exclude_reason as AlphaRunSignalResult["excludeReason"]) ?? null,
      isq: isqByKey.get(w.signal_key) ?? null,
    };
  });

  const excludedCount = signals.reduce((n, s) => n + (s.excluded ? 1 : 0), 0);

  return {
    runId: first.run_id,
    runTimestamp: first.run_timestamp,
    mode: first.mode,
    regime: first.regime,
    N: signals.length,
    NExcluded: excludedCount,
    NEffective: first.n_effective ?? 0,
    signals,
    flags: [],
    durationMs: 0,
  };
}

export interface RunSummary {
  runId: string;
  runTimestamp: string;
  mode: "returns" | "probability";
  regime: string | null;
  N: number;
  NExcluded: number;
  NEffective: number;
}

/**
 * Return summary rows for the most-recent `limit` runs (DESC by timestamp).
 */
export function listRecentAlphaRuns(limit = 10): RunSummary[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT run_id, run_timestamp, mode, regime, n_effective,
              COUNT(*)                               AS total,
              SUM(CASE WHEN excluded=1 THEN 1 ELSE 0 END) AS excluded,
              MAX(id)                                AS max_id
         FROM signal_weights
         GROUP BY run_id
         ORDER BY run_timestamp DESC, max_id DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
    run_id: string;
    run_timestamp: string;
    mode: "returns" | "probability";
    regime: string | null;
    n_effective: number | null;
    total: number;
    excluded: number;
    max_id: number;
  }>;
  return rows.map((r) => ({
    runId: r.run_id,
    runTimestamp: r.run_timestamp,
    mode: r.mode,
    regime: r.regime,
    N: r.total,
    NExcluded: r.excluded,
    NEffective: r.n_effective ?? 0,
  }));
}
