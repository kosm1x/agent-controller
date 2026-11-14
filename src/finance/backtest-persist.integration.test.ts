/**
 * Backtest persistence SQL on the real schema (`initDatabase(":memory:")`).
 *
 * The backtest tool tests count rows in the three tables. These cases read
 * back every column the writers bind, and pin which run, which paths (in
 * which order) and which overfit row each reader returns while other runs
 * sit in the same tables and must not be returned instead.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import type { FoldResult, TrialResult } from "./backtest-cpcv.js";
import {
  persistBacktestRun,
  readBacktestRun,
  readLatestBacktest,
  type PersistBacktestInput,
} from "./backtest-persist.js";

function fold(foldIndex: number, base: number, aborted = false): FoldResult {
  return {
    foldIndex,
    testGroups: [0, 1],
    isSharpe: base * 10 + 1,
    oosSharpe: base * 10 + 2,
    oosCumReturn: base * 10 + 3,
    oosNBars: 40 + foldIndex,
    aborted,
    abortReason: aborted ? "too_few_firings" : null,
  };
}

function trial(trialIndex: number, folds: FoldResult[]): TrialResult {
  return {
    trialIndex,
    config: {
      windowM: 26 + trialIndex,
      windowD: 4 + trialIndex,
      correlationThreshold: 0.5 + trialIndex / 8,
    },
    folds,
  };
}

/**
 * Every number differs per run (`k`) and per column of a row, so a swap or a
 * leak shows; integers and binary fractions keep the read-back exact. The
 * trial / fold counts are stored as given, so they are set apart from the
 * other small integers of the row.
 */
function input(
  runId: string,
  runTimestamp: string,
  strategy: string,
  k: number,
  trials: TrialResult[] = [trial(0, [fold(0, k)])],
): PersistBacktestInput {
  return {
    runId,
    runTimestamp,
    strategy,
    mode: "returns",
    windowStart: "2025-01-03",
    windowEnd: "2026-03-06",
    costBps: 5 + k,
    rebalanceBars: 4,
    walkForward: {
      equityCurve: [],
      sharpe: k * 100 + 1,
      cumReturn: k * 100 + 2,
      maxDrawdown: k * 100 + 3,
      calmar: k * 100 + 4,
      winRate: k * 100 + 5,
      totalTrades: 900 + k,
      nWarmupBars: 0,
      nTestBars: 0,
      nAbortedRuns: 0,
    },
    cpcv: {
      trials,
      nTrialsTotal: 3,
      nFoldsPerTrial: 2,
      aggregateSharpeMean: k * 100 + 6,
      aggregateSharpeStd: k * 100 + 7,
      nAborted: 50 + k,
    },
    overfit: {
      pbo: k / 8,
      dsr: {
        observedSharpe: k * 100 + 11,
        expectedNullSharpe: k * 100 + 12,
        trialsSharpeVariance: k * 100 + 13,
        skewness: k * 100 + 14,
        kurtosis: k * 100 + 15,
        ratio: k * 100 + 16,
        pvalue: k / 16,
      },
    },
    shipBlocked: k % 2 === 1,
    overrideShip: false,
    regime: `regime-${k}`,
    durationMs: 1000 + k,
  };
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("persistBacktestRun on the real backtest tables", () => {
  it("writes each bound value to its own column in runs, paths and overfit", () => {
    const stats = persistBacktestRun(
      input("bt-one", "2026-03-06T16:00:00-05:00", "flam", 1, [
        trial(6, [fold(2, 1), fold(3, 2, true)]),
      ]),
    );
    expect(stats).toEqual({ runId: "bt-one", pathsInserted: 2 });

    const db = getDatabase();
    expect(
      db
        .prepare(
          `SELECT run_id, run_timestamp, strategy, mode, window_start, window_end, cost_bps,
                  rebalance_bars, wf_sharpe, wf_cum_return, wf_max_drawdown, wf_calmar,
                  wf_win_rate, wf_total_trades, cpcv_n_trials, cpcv_n_folds, cpcv_sharpe_mean,
                  cpcv_sharpe_std, cpcv_n_aborted, pbo, dsr_ratio, dsr_pvalue, ship_blocked,
                  override_ship, regime, duration_ms
             FROM backtest_runs`,
        )
        .all(),
    ).toEqual([
      {
        run_id: "bt-one",
        run_timestamp: "2026-03-06T16:00:00-05:00",
        strategy: "flam",
        mode: "returns",
        window_start: "2025-01-03",
        window_end: "2026-03-06",
        cost_bps: 6,
        rebalance_bars: 4,
        wf_sharpe: 101,
        wf_cum_return: 102,
        wf_max_drawdown: 103,
        wf_calmar: 104,
        wf_win_rate: 105,
        wf_total_trades: 901,
        cpcv_n_trials: 3,
        cpcv_n_folds: 2,
        cpcv_sharpe_mean: 106,
        cpcv_sharpe_std: 107,
        cpcv_n_aborted: 51,
        pbo: 0.125,
        dsr_ratio: 116,
        dsr_pvalue: 0.0625,
        ship_blocked: 1,
        override_ship: 0,
        regime: "regime-1",
        duration_ms: 1001,
      },
    ]);

    expect(
      db
        .prepare(
          `SELECT run_id, trial_index, fold_index, window_m, window_d, corr_threshold,
                  is_sharpe, oos_sharpe, oos_cum_return, oos_n_bars, aborted, abort_reason
             FROM backtest_paths ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        run_id: "bt-one",
        trial_index: 6,
        fold_index: 2,
        window_m: 32,
        window_d: 10,
        corr_threshold: 1.25,
        is_sharpe: 11,
        oos_sharpe: 12,
        oos_cum_return: 13,
        oos_n_bars: 42,
        aborted: 0,
        abort_reason: null,
      },
      {
        run_id: "bt-one",
        trial_index: 6,
        fold_index: 3,
        window_m: 32,
        window_d: 10,
        corr_threshold: 1.25,
        is_sharpe: 21,
        oos_sharpe: 22,
        oos_cum_return: 23,
        oos_n_bars: 43,
        aborted: 1,
        abort_reason: "too_few_firings",
      },
    ]);

    expect(
      db
        .prepare(
          `SELECT run_id, pbo, pbo_threshold, dsr_observed_sharpe, dsr_expected_null,
                  dsr_sharpe_variance, dsr_skewness, dsr_kurtosis, dsr_ratio, dsr_pvalue
             FROM backtest_overfit`,
        )
        .all(),
    ).toEqual([
      {
        run_id: "bt-one",
        pbo: 0.125,
        pbo_threshold: 0.5,
        dsr_observed_sharpe: 111,
        dsr_expected_null: 112,
        dsr_sharpe_variance: 113,
        dsr_skewness: 114,
        dsr_kurtosis: 115,
        dsr_ratio: 116,
        dsr_pvalue: 0.0625,
      },
    ]);
  });
});

describe("backtest readers on the real tables", () => {
  beforeEach(() => {
    // Run ids sort bt-eq < bt-flam-new < bt-flam-old < bt-vol and strategies
    // sort equal_weight < flam < vol_target, so the run and the strategy read
    // below each have a neighbour on both sides. Timestamps sort
    // bt-flam-old < bt-flam-new < bt-vol < bt-eq = bt-dup, which matches
    // neither the id order nor the insertion order. bt-dup ties bt-eq on the
    // greatest timestamp, in the same strategy, and is persisted after it
    // with a lower run id: on a tie the later persisted run is the latest.
    persistBacktestRun(
      input("bt-flam-new", "2026-03-13T16:00:00-05:00", "flam", 2),
    );
    persistBacktestRun(
      input("bt-eq", "2026-03-20T16:00:00-05:00", "equal_weight", 3),
    );
    persistBacktestRun(
      input("bt-vol", "2026-03-16T16:00:00-05:00", "vol_target", 5),
    );
    persistBacktestRun(
      input("bt-flam-old", "2026-03-06T16:00:00-05:00", "flam", 4, [
        // Grid order on purpose out of index order: the reader sorts.
        trial(1, [fold(1, 7), fold(0, 6)]),
        trial(0, [fold(1, 5), fold(0, 4)]),
      ]),
    );
    persistBacktestRun(
      input("bt-dup", "2026-03-20T16:00:00-05:00", "equal_weight", 6),
    );
  });

  it("readBacktestRun returns that run's row, its paths sorted by trial then fold, and its overfit row", () => {
    const read = readBacktestRun("bt-flam-old");
    expect(read?.run).toMatchObject({
      run_id: "bt-flam-old",
      strategy: "flam",
      wf_sharpe: 401,
      cost_bps: 9,
    });
    expect(
      read?.paths.map((p) => [
        p.run_id,
        p.trial_index,
        p.fold_index,
        p.is_sharpe,
      ]),
    ).toEqual([
      ["bt-flam-old", 0, 0, 41],
      ["bt-flam-old", 0, 1, 51],
      ["bt-flam-old", 1, 0, 61],
      ["bt-flam-old", 1, 1, 71],
    ]);
    expect(read?.overfit).toMatchObject({
      run_id: "bt-flam-old",
      dsr_observed_sharpe: 411,
    });
  });

  it("readBacktestRun returns null for an unknown run, including one below the lowest id", () => {
    expect(readBacktestRun("bt-0")).toBeNull();
    expect(readBacktestRun("bt-flam-older")).toBeNull();
  });

  it("readLatestBacktest(strategy) picks the newest run of that strategy only, not of a neighbouring strategy", () => {
    expect(readLatestBacktest("flam")?.run.run_id).toBe("bt-flam-new");
    expect(readLatestBacktest("equal_weight")?.run.run_id).toBe("bt-dup");
    expect(readLatestBacktest("vol_target")?.run.run_id).toBe("bt-vol");
    expect(readLatestBacktest("aaa")).toBeNull();
    expect(readLatestBacktest("unknown")).toBeNull();
  });

  it("readLatestBacktest() picks the newest run of any strategy", () => {
    expect(readLatestBacktest()?.run.run_id).toBe("bt-dup");
  });

  it("readBacktestRun returns the run with overfit null when its overfit row is absent", () => {
    getDatabase()
      .prepare(`DELETE FROM backtest_overfit WHERE run_id = ?`)
      .run("bt-flam-new");
    const read = readBacktestRun("bt-flam-new");
    expect(read?.run.run_id).toBe("bt-flam-new");
    expect(read?.paths.map((p) => p.run_id)).toEqual(["bt-flam-new"]);
    expect(read?.overfit).toBeNull();
  });
});
