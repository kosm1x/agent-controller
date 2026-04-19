/**
 * F7.5 — persistence + retrieval helpers for backtest runs.
 *
 * Writers:
 *   persistBacktestRun(record)   → inserts one row into backtest_runs,
 *                                   N_trials × N_folds rows into backtest_paths,
 *                                   and one row into backtest_overfit, all in
 *                                   a single better-sqlite3 transaction.
 *
 * Readers:
 *   readBacktestRun(runId)       → run_row + paths + overfit; null if unknown.
 *   readLatestBacktest(strategy?) → most recent run for the given strategy.
 *   listRecentBacktests(limit)    → summary list for admin/audit.
 *
 * Schema: backtest_runs / backtest_paths / backtest_overfit (see schema.sql).
 * All tables additive; no migrations beyond CREATE TABLE IF NOT EXISTS.
 */

import { getDatabase } from "../db/index.js";
import type { CpcvResult } from "./backtest-cpcv.js";
import type { OverfitResult } from "./backtest-overfit.js";
import type { WalkForwardResult } from "./backtest-walkforward.js";

export interface PersistBacktestInput {
  runId: string;
  runTimestamp: string; // ISO 8601 America/New_York
  strategy: string;
  mode: "returns" | "probability";
  windowStart: string; // ISO YYYY-MM-DD
  windowEnd: string; // ISO YYYY-MM-DD
  costBps: number;
  rebalanceBars: number;
  walkForward: WalkForwardResult;
  cpcv: CpcvResult;
  overfit: OverfitResult;
  shipBlocked: boolean;
  overrideShip: boolean;
  regime: string | null;
  durationMs: number;
}

export interface PersistBacktestStats {
  runId: string;
  pathsInserted: number;
}

export function persistBacktestRun(
  input: PersistBacktestInput,
): PersistBacktestStats {
  const db = getDatabase();

  const insertRun = db.prepare(
    `INSERT INTO backtest_runs
      (run_id, run_timestamp, strategy, mode, window_start, window_end,
       cost_bps, rebalance_bars,
       wf_sharpe, wf_cum_return, wf_max_drawdown, wf_calmar, wf_win_rate, wf_total_trades,
       cpcv_n_trials, cpcv_n_folds, cpcv_sharpe_mean, cpcv_sharpe_std, cpcv_n_aborted,
       pbo, dsr_ratio, dsr_pvalue, ship_blocked, override_ship, regime, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?,
             ?, ?,
             ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertPath = db.prepare(
    `INSERT INTO backtest_paths
      (run_id, trial_index, fold_index, window_m, window_d, corr_threshold,
       is_sharpe, oos_sharpe, oos_cum_return, oos_n_bars, aborted, abort_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertOverfit = db.prepare(
    `INSERT INTO backtest_overfit
      (run_id, pbo, pbo_threshold, dsr_observed_sharpe, dsr_expected_null,
       dsr_sharpe_variance, dsr_skewness, dsr_kurtosis, dsr_ratio, dsr_pvalue)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let pathsInserted = 0;

  // Degenerate-run sanitization: when CPCV produces no eligible folds (all
  // aborted, insufficient bars, etc.) PBO / DSR come back as NaN. Schema
  // NOT-NULLs these, and the semantic is "strategy is not shippable" anyway —
  // pin both to maximum-block values (pbo=1, pvalue=1) so downstream reads
  // surface the degenerate run correctly instead of the INSERT crashing.
  const finite = (x: number, fallback: number): number =>
    Number.isFinite(x) ? x : fallback;

  const tx = db.transaction((data: PersistBacktestInput) => {
    const wf = data.walkForward;
    const cpcv = data.cpcv;
    const overfit = data.overfit;
    const pboSafe = finite(overfit.pbo, 1);
    const dsrRatioSafe = finite(overfit.dsr.ratio, 0);
    const dsrPvalueSafe = finite(overfit.dsr.pvalue, 1);
    const dsrObsSafe = finite(overfit.dsr.observedSharpe, 0);
    const dsrNullSafe = finite(overfit.dsr.expectedNullSharpe, 0);
    const dsrVarSafe = finite(overfit.dsr.trialsSharpeVariance, 0);

    insertRun.run(
      data.runId,
      data.runTimestamp,
      data.strategy,
      data.mode,
      data.windowStart,
      data.windowEnd,
      data.costBps,
      data.rebalanceBars,
      wf.sharpe,
      wf.cumReturn,
      wf.maxDrawdown,
      wf.calmar,
      wf.winRate,
      wf.totalTrades,
      cpcv.nTrialsTotal,
      cpcv.nFoldsPerTrial,
      cpcv.aggregateSharpeMean,
      cpcv.aggregateSharpeStd,
      cpcv.nAborted,
      pboSafe,
      dsrRatioSafe,
      dsrPvalueSafe,
      data.shipBlocked ? 1 : 0,
      data.overrideShip ? 1 : 0,
      data.regime,
      data.durationMs,
    );

    for (const trial of cpcv.trials) {
      for (const fold of trial.folds) {
        insertPath.run(
          data.runId,
          trial.trialIndex,
          fold.foldIndex,
          trial.config.windowM,
          trial.config.windowD,
          trial.config.correlationThreshold,
          fold.isSharpe,
          fold.oosSharpe,
          fold.oosCumReturn,
          fold.oosNBars,
          fold.aborted ? 1 : 0,
          fold.abortReason,
        );
        pathsInserted += 1;
      }
    }

    insertOverfit.run(
      data.runId,
      pboSafe,
      0.5,
      dsrObsSafe,
      dsrNullSafe,
      dsrVarSafe,
      overfit.dsr.skewness,
      overfit.dsr.kurtosis,
      dsrRatioSafe,
      dsrPvalueSafe,
    );
  });

  tx(input);

  return { runId: input.runId, pathsInserted };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export interface BacktestRunRow {
  run_id: string;
  run_timestamp: string;
  strategy: string;
  mode: "returns" | "probability";
  window_start: string;
  window_end: string;
  cost_bps: number;
  rebalance_bars: number;
  wf_sharpe: number | null;
  wf_cum_return: number | null;
  wf_max_drawdown: number | null;
  wf_calmar: number | null;
  wf_win_rate: number | null;
  wf_total_trades: number | null;
  cpcv_n_trials: number | null;
  cpcv_n_folds: number | null;
  cpcv_sharpe_mean: number | null;
  cpcv_sharpe_std: number | null;
  cpcv_n_aborted: number;
  pbo: number | null;
  dsr_ratio: number | null;
  dsr_pvalue: number | null;
  ship_blocked: number;
  override_ship: number;
  regime: string | null;
  duration_ms: number | null;
}

export interface BacktestPathRow {
  run_id: string;
  trial_index: number;
  fold_index: number;
  window_m: number;
  window_d: number;
  corr_threshold: number;
  is_sharpe: number | null;
  oos_sharpe: number | null;
  oos_cum_return: number | null;
  oos_n_bars: number;
  aborted: number;
  abort_reason: string | null;
}

export interface BacktestOverfitRow {
  run_id: string;
  pbo: number;
  pbo_threshold: number;
  dsr_observed_sharpe: number;
  dsr_expected_null: number;
  dsr_sharpe_variance: number;
  dsr_skewness: number | null;
  dsr_kurtosis: number | null;
  dsr_ratio: number;
  dsr_pvalue: number;
}

export interface BacktestRead {
  run: BacktestRunRow;
  paths: BacktestPathRow[];
  overfit: BacktestOverfitRow | null;
}

export function readBacktestRun(runId: string): BacktestRead | null {
  const db = getDatabase();
  const run = db
    .prepare(`SELECT * FROM backtest_runs WHERE run_id = ?`)
    .get(runId) as BacktestRunRow | undefined;
  if (!run) return null;

  const paths = db
    .prepare(
      `SELECT * FROM backtest_paths WHERE run_id = ? ORDER BY trial_index, fold_index`,
    )
    .all(runId) as BacktestPathRow[];

  const overfit = db
    .prepare(`SELECT * FROM backtest_overfit WHERE run_id = ?`)
    .get(runId) as BacktestOverfitRow | undefined;

  return { run, paths, overfit: overfit ?? null };
}

export function readLatestBacktest(strategy?: string): BacktestRead | null {
  const db = getDatabase();
  const row = strategy
    ? (db
        .prepare(
          `SELECT run_id FROM backtest_runs WHERE strategy = ? ORDER BY run_timestamp DESC, id DESC LIMIT 1`,
        )
        .get(strategy) as { run_id?: string } | undefined)
    : (db
        .prepare(
          `SELECT run_id FROM backtest_runs ORDER BY run_timestamp DESC, id DESC LIMIT 1`,
        )
        .get() as { run_id?: string } | undefined);
  if (!row?.run_id) return null;
  return readBacktestRun(row.run_id);
}

export interface BacktestSummary {
  runId: string;
  runTimestamp: string;
  strategy: string;
  wfSharpe: number | null;
  pbo: number | null;
  dsrPvalue: number | null;
  shipBlocked: boolean;
}

export function listRecentBacktests(limit = 10): BacktestSummary[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT run_id, run_timestamp, strategy, wf_sharpe, pbo, dsr_pvalue, ship_blocked
         FROM backtest_runs
         ORDER BY run_timestamp DESC, id DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
    run_id: string;
    run_timestamp: string;
    strategy: string;
    wf_sharpe: number | null;
    pbo: number | null;
    dsr_pvalue: number | null;
    ship_blocked: number;
  }>;
  return rows.map((r) => ({
    runId: r.run_id,
    runTimestamp: r.run_timestamp,
    strategy: r.strategy,
    wfSharpe: r.wf_sharpe,
    pbo: r.pbo,
    dsrPvalue: r.dsr_pvalue,
    shipBlocked: r.ship_blocked === 1,
  }));
}
