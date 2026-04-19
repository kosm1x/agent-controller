import { describe, expect, it } from "vitest";
import {
  bestTrialFoldSharpes,
  computeDsr,
  computeOverfitMetrics,
  computePbo,
  rankAscending,
  trialLevelOosSharpes,
} from "./backtest-overfit.js";
import type { CpcvResult, FoldResult, TrialResult } from "./backtest-cpcv.js";

/** Make a synthetic CpcvResult from a matrix isSharpes[t][f] + oosSharpes[t][f]. */
function mkCpcv(
  isMatrix: Array<Array<number | null>>,
  oosMatrix: Array<Array<number | null>>,
): CpcvResult {
  const nTrials = isMatrix.length;
  const nFolds = isMatrix[0]!.length;
  const trials: TrialResult[] = [];
  let nAborted = 0;
  for (let t = 0; t < nTrials; t++) {
    const folds: FoldResult[] = [];
    for (let f = 0; f < nFolds; f++) {
      const is = isMatrix[t]![f]!;
      const oos = oosMatrix[t]![f]!;
      const aborted = is === null && oos === null;
      folds.push({
        foldIndex: f,
        testGroups: [f, f],
        isSharpe: is,
        oosSharpe: oos,
        oosCumReturn: null,
        oosNBars: 0,
        aborted,
        abortReason: aborted ? "synthetic" : null,
      });
      if (aborted) nAborted += 1;
    }
    trials.push({
      trialIndex: t,
      config: { windowM: 10 + t, windowD: 4, correlationThreshold: 0.95 },
      folds,
    });
  }
  const allOos: number[] = [];
  for (const tr of trials)
    for (const f of tr.folds)
      if (f.oosSharpe !== null) allOos.push(f.oosSharpe);
  const mean =
    allOos.length === 0 ? 0 : allOos.reduce((a, b) => a + b, 0) / allOos.length;
  const variance =
    allOos.length < 2
      ? 0
      : allOos.reduce((a, b) => a + (b - mean) ** 2, 0) / (allOos.length - 1);
  return {
    trials,
    nTrialsTotal: nTrials,
    nFoldsPerTrial: nFolds,
    aggregateSharpeMean: mean,
    aggregateSharpeStd: Math.sqrt(variance),
    nAborted,
  };
}

describe("rankAscending", () => {
  it("basic rank", () => {
    expect(rankAscending(3, [1, 2, 3, 4, 5])).toBe(3);
    expect(rankAscending(1, [1, 2, 3, 4, 5])).toBe(1);
    expect(rankAscending(5, [1, 2, 3, 4, 5])).toBe(5);
  });

  it("averages ties", () => {
    expect(rankAscending(5, [1, 5, 5, 9])).toBeCloseTo(2.5, 10);
  });

  it("rank below all", () => {
    expect(rankAscending(0, [1, 2, 3])).toBe(0.5);
  });
});

describe("computePbo", () => {
  it("PBO = 1 when IS winner always loses OOS", () => {
    // 4 trials, 3 folds. IS best is trial 0 every fold; OOS rank of trial 0 is always lowest.
    // IS: each column: trial 0 highest, trial 3 lowest
    const isM = [
      [4, 4, 4],
      [3, 3, 3],
      [2, 2, 2],
      [1, 1, 1],
    ];
    // OOS: reverse — trial 0 lowest
    const oosM = [
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
      [4, 4, 4],
    ];
    const cpcv = mkCpcv(isM, oosM);
    expect(computePbo(cpcv)).toBe(1);
  });

  it("PBO = 0 when IS winner always wins OOS", () => {
    const isM = [
      [4, 4, 4],
      [3, 3, 3],
      [2, 2, 2],
      [1, 1, 1],
    ];
    const oosM = isM;
    const cpcv = mkCpcv(isM, oosM);
    expect(computePbo(cpcv)).toBe(0);
  });

  it("PBO around 0.5 for random pairings", () => {
    // IS ranks randomized via fixed permutation, OOS independent
    const isM = [
      [4, 3, 2, 1],
      [3, 4, 1, 2],
      [2, 1, 4, 3],
      [1, 2, 3, 4],
    ];
    const oosM = [
      [1, 2, 3, 4],
      [2, 1, 4, 3],
      [3, 4, 1, 2],
      [4, 3, 2, 1],
    ];
    const cpcv = mkCpcv(isM, oosM);
    const pbo = computePbo(cpcv);
    expect(pbo).toBeGreaterThanOrEqual(0);
    expect(pbo).toBeLessThanOrEqual(1);
  });

  it("PBO = 1 when IS winner lands at rank just below median (audit W2)", () => {
    // 4 trials × 1 fold. IS: [[4],[3],[2],[1]] → trial 0 wins IS.
    // OOS values: [2, 1, 4, 3]. Trial 0 OOS=2; rank_ascending = 2 among
    // {1,2,3,4}. Median threshold = (4+1)/2 = 2.5. rank 2 < 2.5 → count.
    // Double-logit bug threshold (N+1)/3 ≈ 1.67 would miss rank=2.
    const isM = [[4], [3], [2], [1]];
    const oosM = [[2], [1], [4], [3]];
    const cpcv = mkCpcv(isM, oosM);
    expect(computePbo(cpcv)).toBe(1);
  });

  it("PBO = 0 when IS winner lands at rank just above median", () => {
    // OOS values: [3, 4, 1, 2]. Trial 0 OOS=3; rank = 3 > 2.5. PBO = 0.
    const isM = [[4], [3], [2], [1]];
    const oosM = [[3], [4], [1], [2]];
    const cpcv = mkCpcv(isM, oosM);
    expect(computePbo(cpcv)).toBe(0);
  });

  it("skips folds where all trials are aborted", () => {
    // fold 0 all nulls, fold 1 normal
    const isM = [
      [null, 3],
      [null, 2],
    ];
    const oosM = [
      [null, 1],
      [null, 2],
    ];
    const cpcv = mkCpcv(isM, oosM);
    const pbo = computePbo(cpcv);
    expect(Number.isFinite(pbo)).toBe(true);
  });
});

describe("computeDsr", () => {
  it("pvalue decreases as observed Sharpe increases", () => {
    const trialSharpes = [0.5, 0.7, 0.6];
    const observedReturns = Array.from(
      { length: 100 },
      (_, i) => 0.001 * (i % 3),
    );
    const dsrLow = computeDsr({
      observedSharpe: 0.1,
      trialSharpes,
      observedReturns,
      T: 100,
    });
    const dsrHigh = computeDsr({
      observedSharpe: 3.0,
      trialSharpes,
      observedReturns,
      T: 100,
    });
    expect(dsrHigh.pvalue).toBeLessThan(dsrLow.pvalue);
  });

  it("expectedNull > 0 when trials variance > 0 and nTrials > 1", () => {
    const dsr = computeDsr({
      observedSharpe: 2,
      trialSharpes: [0.5, 1.0, 1.5, 2.0],
      observedReturns: [0.01, -0.01, 0.02, -0.005, 0.015],
      T: 5,
    });
    expect(dsr.expectedNullSharpe).toBeGreaterThan(0);
  });

  it("expectedNull === 0 when all trials identical", () => {
    const dsr = computeDsr({
      observedSharpe: 1.5,
      trialSharpes: [1.5, 1.5, 1.5],
      observedReturns: [0.01, 0.01, 0.01],
      T: 3,
    });
    expect(dsr.expectedNullSharpe).toBe(0);
  });

  it("de-annualization: weekly Sharpe ~0.14 (annualized ~1.0) over T=54 → pvalue > 0.05 (audit W3)", () => {
    // Weekly Sharpe ≈ 0.14; annualized = 0.14·√52 ≈ 1.0
    // T=54 observations, periodsPerYear=52 (default). Per de Prado, a Sharpe
    // of 1.0 over ~1 year of weekly data with a handful of trials is NOT
    // statistically significant (p ≳ 0.1). Before the de-annualization fix,
    // the code treated the annualized value directly and produced p ≈ 1e-13.
    const dsr = computeDsr({
      observedSharpe: 1.0,
      trialSharpes: [0.6, 0.8, 1.0, 0.9, 0.7],
      observedReturns: Array.from(
        { length: 54 },
        (_, i) => 0.002 + 0.005 * Math.sin(i),
      ),
      T: 54,
    });
    expect(dsr.pvalue).toBeGreaterThan(0.05);
    expect(dsr.pvalue).toBeLessThan(0.95);
  });

  it("de-annualization: very high annualized Sharpe (SR=5) IS significant", () => {
    // A 5.0 annualized Sharpe on 104 weeks of data SHOULD clear the firewall
    // even after de-annualization. Sanity check on the other side.
    const dsr = computeDsr({
      observedSharpe: 5.0,
      trialSharpes: [1.0, 1.5, 2.0, 5.0],
      observedReturns: Array.from({ length: 104 }, () => 0.01),
      T: 104,
    });
    expect(dsr.pvalue).toBeLessThan(0.05);
  });

  it("periodsPerYear=1 treats inputs as already per-period", () => {
    const annualized = computeDsr({
      observedSharpe: 1.0,
      trialSharpes: [0.5, 0.7, 1.0],
      observedReturns: Array.from({ length: 52 }, () => 0.01),
      T: 52,
    });
    const perPeriod = computeDsr({
      observedSharpe: 1.0 / Math.sqrt(52),
      trialSharpes: [0.5, 0.7, 1.0].map((x) => x / Math.sqrt(52)),
      observedReturns: Array.from({ length: 52 }, () => 0.01),
      T: 52,
      periodsPerYear: 1,
    });
    // Same Z statistic → same pvalue (within floating tolerance)
    expect(perPeriod.pvalue).toBeCloseTo(annualized.pvalue, 6);
  });

  it("pvalue ∈ [0, 1]", () => {
    const dsr = computeDsr({
      observedSharpe: 1.2,
      trialSharpes: [0.5, 1.0, 1.5],
      observedReturns: Array.from(
        { length: 50 },
        (_, i) => 0.001 * Math.sin(i),
      ),
      T: 50,
    });
    expect(dsr.pvalue).toBeGreaterThanOrEqual(0);
    expect(dsr.pvalue).toBeLessThanOrEqual(1);
  });

  it("skewness + kurtosis computed when returns given", () => {
    const dsr = computeDsr({
      observedSharpe: 1,
      trialSharpes: [0.5, 1.0],
      observedReturns: [1, 1, 1, 1, 1, 10], // right-skewed
      T: 6,
    });
    expect(dsr.skewness).not.toBeNull();
    expect(dsr.skewness!).toBeGreaterThan(0);
    expect(dsr.kurtosis).not.toBeNull();
  });
});

describe("trialLevelOosSharpes", () => {
  it("averages per-trial OOS over non-aborted folds only", () => {
    const cpcv = mkCpcv([[1, 2, 3]], [[2, 4, 6]]);
    const sharpes = trialLevelOosSharpes(cpcv);
    expect(sharpes.length).toBe(1);
    expect(sharpes[0]!).toBeCloseTo(4, 10);
  });

  it("drops trials with all folds aborted", () => {
    const cpcv = mkCpcv(
      [
        [1, 2],
        [null, null],
      ],
      [
        [3, 4],
        [null, null],
      ],
    );
    const sharpes = trialLevelOosSharpes(cpcv);
    expect(sharpes.length).toBe(1);
    expect(sharpes[0]!).toBeCloseTo(3.5, 10);
  });
});

describe("bestTrialFoldSharpes", () => {
  it("picks the trial with highest OOS mean", () => {
    const cpcv = mkCpcv(
      [
        [1, 1, 1],
        [1, 1, 1],
      ],
      [
        [0.1, 0.2, 0.3],
        [1, 1, 1],
      ],
    );
    const folds = bestTrialFoldSharpes(cpcv);
    expect(folds).toEqual([1, 1, 1]);
  });
});

describe("NaN ship-gate path (audit W3 round 2)", () => {
  it("computePbo returns NaN when all folds lack valid sharpes", () => {
    const cpcv = mkCpcv([[null, null]], [[null, null]]);
    expect(Number.isNaN(computePbo(cpcv))).toBe(true);
  });

  it("computeDsr pvalue is finite even with near-zero trial variance", () => {
    const dsr = computeDsr({
      observedSharpe: 1,
      trialSharpes: [1, 1, 1],
      observedReturns: [0.01, 0.02, -0.01],
      T: 3,
    });
    // With identical trials, expectedNull=0 → pvalue stays finite and near 0
    // (Z-stat nonzero). Important: no NaN propagates.
    expect(Number.isFinite(dsr.pvalue)).toBe(true);
  });
});

describe("computeOverfitMetrics", () => {
  it("produces PBO and DSR both in valid ranges", () => {
    const cpcv = mkCpcv(
      [
        [0.5, 0.6, 0.4, 0.3],
        [0.4, 0.5, 0.5, 0.4],
        [0.3, 0.4, 0.6, 0.5],
      ],
      [
        [0.2, 0.3, 0.1, 0.0],
        [0.3, 0.4, 0.3, 0.2],
        [0.4, 0.5, 0.5, 0.4],
      ],
    );
    const overfit = computeOverfitMetrics(cpcv);
    expect(overfit.pbo).toBeGreaterThanOrEqual(0);
    expect(overfit.pbo).toBeLessThanOrEqual(1);
    expect(overfit.dsr.pvalue).toBeGreaterThanOrEqual(0);
    expect(overfit.dsr.pvalue).toBeLessThanOrEqual(1);
  });

  it("observed Sharpe equals best trial mean OOS", () => {
    const cpcv = mkCpcv(
      [
        [0.5, 0.6],
        [0.4, 0.5],
      ],
      [
        [0.2, 0.4], // mean 0.3
        [0.8, 1.2], // mean 1.0 (best)
      ],
    );
    const overfit = computeOverfitMetrics(cpcv);
    expect(overfit.dsr.observedSharpe).toBeCloseTo(1.0, 10);
  });
});
