/**
 * Alpha-run persistence SQL on the real schema (`initDatabase(":memory:")`).
 *
 * The alpha tool tests count rows. These cases read back every column the
 * writers bind, and pin which run, which weight rows and which ISQ
 * dimensions each reader returns while a second run with the same signal
 * keys sits in the same tables and must not leak in.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import type {
  AlphaRunResult,
  AlphaRunSignalResult,
} from "./alpha-combination.js";
import {
  persistAlphaRun,
  readAlphaRunByRunId,
  readLatestAlphaRun,
} from "./alpha-persist.js";

const AAPL: AlphaRunSignalResult = {
  signalKey: "ma_crossover:AAPL",
  signalType: "ma_crossover",
  symbol: "AAPL",
  weight: 0.6,
  epsilon: 0.011,
  sigma: 0.022,
  eNorm: 0.033,
  ic30d: 0.044,
  excluded: false,
  excludeReason: null,
  isq: {
    efficiency: 0.1,
    timeliness: 0.2,
    coverage: 0.3,
    stability: 0.4,
    forward_ic: 0.5,
  },
};

const MSFT: AlphaRunSignalResult = {
  signalKey: "rsi_extreme:MSFT",
  signalType: "rsi_extreme",
  symbol: "MSFT",
  weight: 0,
  epsilon: null,
  sigma: null,
  eNorm: null,
  ic30d: null,
  excluded: true,
  excludeReason: "ic_le_zero",
  isq: null,
};

function run(
  runId: string,
  runTimestamp: string,
  signals: AlphaRunSignalResult[],
): AlphaRunResult {
  return {
    runId,
    runTimestamp,
    mode: "returns",
    regime: `regime-${runId}`,
    N: signals.length,
    NExcluded: signals.filter((s) => s.excluded).length,
    NEffective: 1.5,
    signals,
    flags: [],
    durationMs: 0,
  };
}

/**
 * The same two signal keys with other values and an ISQ row on BOTH keys:
 * a neighbour run's weight row or ISQ row leaking into a read shows, also
 * as an ISQ appearing on the key that has none in the run being read.
 */
function neighbour(offset: number): AlphaRunSignalResult[] {
  const isq = (b: number) => ({
    efficiency: b + 0.01,
    timeliness: b + 0.02,
    coverage: b + 0.03,
    stability: b + 0.04,
    forward_ic: b + 0.05,
  });
  return [
    {
      ...AAPL,
      weight: offset + 0.1,
      epsilon: offset + 0.2,
      sigma: offset + 0.3,
      eNorm: offset + 0.4,
      ic30d: offset + 0.5,
      isq: isq(offset),
    },
    {
      ...MSFT,
      weight: offset + 0.6,
      epsilon: offset + 0.7,
      sigma: offset + 0.8,
      eNorm: offset + 0.9,
      ic30d: offset + 0.15,
      excluded: false,
      excludeReason: null,
      isq: isq(offset + 0.5),
    },
  ];
}

const NEWER = run("run-newer", "2026-03-13T16:00:00-05:00", [AAPL, MSFT]);

// Run ids sort run-a < run-b < run-c; timestamps sort run-b < run-c < run-a;
// insertion order is run-b, run-a, run-c. No order agrees with another.
// run-b's signals are persisted with the higher signal key first, so the
// read order is insertion order, not key order.
const RUN_A = run("run-a", "2026-03-13T16:00:00-05:00", neighbour(1));
const RUN_B = run("run-b", "2026-03-06T16:00:00-05:00", [MSFT, AAPL]);
const RUN_C = run("run-c", "2026-03-09T16:00:00-05:00", neighbour(2));
// Ties run-a on the greatest timestamp and is persisted after it: the
// later persisted run is the latest.
const RUN_TIE = run("run-0a", "2026-03-13T16:00:00-05:00", neighbour(3));

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("persistAlphaRun on the real signal_weights / signal_isq tables", () => {
  it("writes each bound value to its own column; a signal without ISQ writes no ISQ row", () => {
    expect(persistAlphaRun(NEWER)).toEqual({
      runId: "run-newer",
      weightsInserted: 2,
      isqInserted: 1,
    });
    const weights = getDatabase()
      .prepare(
        `SELECT run_id, run_timestamp, mode, signal_key, signal_name, weight, epsilon, sigma,
                e_norm, ic_30d, regime, n_effective, excluded, exclude_reason
           FROM signal_weights ORDER BY id`,
      )
      .all();
    expect(weights).toEqual([
      {
        run_id: "run-newer",
        run_timestamp: "2026-03-13T16:00:00-05:00",
        mode: "returns",
        signal_key: "ma_crossover:AAPL",
        signal_name: "ma_crossover on AAPL",
        weight: 0.6,
        epsilon: 0.011,
        sigma: 0.022,
        e_norm: 0.033,
        ic_30d: 0.044,
        regime: "regime-run-newer",
        n_effective: 1.5,
        excluded: 0,
        exclude_reason: null,
      },
      {
        run_id: "run-newer",
        run_timestamp: "2026-03-13T16:00:00-05:00",
        mode: "returns",
        signal_key: "rsi_extreme:MSFT",
        signal_name: "rsi_extreme on MSFT",
        weight: 0,
        epsilon: null,
        sigma: null,
        e_norm: null,
        ic_30d: null,
        regime: "regime-run-newer",
        n_effective: 1.5,
        excluded: 1,
        exclude_reason: "ic_le_zero",
      },
    ]);
    const isq = getDatabase()
      .prepare(
        `SELECT run_id, signal_key, efficiency, timeliness, coverage, stability, forward_ic
           FROM signal_isq ORDER BY id`,
      )
      .all();
    expect(isq).toEqual([
      {
        run_id: "run-newer",
        signal_key: "ma_crossover:AAPL",
        efficiency: 0.1,
        timeliness: 0.2,
        coverage: 0.3,
        stability: 0.4,
        forward_ic: 0.5,
      },
    ]);
  });
});

describe("alpha-run readers on the real tables", () => {
  beforeEach(() => {
    persistAlphaRun(RUN_B);
    persistAlphaRun(RUN_A);
    persistAlphaRun(RUN_C);
    persistAlphaRun(RUN_TIE);
  });

  it("readAlphaRunByRunId returns only that run's weight rows and ISQ rows, not a neighbour's on either side", () => {
    expect(readAlphaRunByRunId("run-b")).toEqual(RUN_B);
    expect(readAlphaRunByRunId("run-a")).toEqual(RUN_A);
    expect(readAlphaRunByRunId("run-c")).toEqual(RUN_C);
  });

  it("readAlphaRunByRunId returns null for an unknown run, including one below the lowest id", () => {
    expect(readAlphaRunByRunId("run-0")).toBeNull();
    expect(readAlphaRunByRunId("run-bb")).toBeNull();
  });

  it("readLatestAlphaRun picks the greatest run_timestamp, and on a tie the later persisted run", () => {
    expect(readLatestAlphaRun()).toEqual(RUN_TIE);
  });
});
