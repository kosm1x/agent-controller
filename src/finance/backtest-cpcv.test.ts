import { describe, expect, it } from "vitest";
import {
  F75_DEFAULT_GRID,
  combinations,
  partitionGroups,
  runCpcv,
} from "./backtest-cpcv.js";
import type { AlphaRunResult } from "./alpha-combination.js";
import { F7CorrelatedSignalsError } from "./alpha-combination.js";
import type { BarRow } from "./alpha-matrix.js";

function makeBars(
  symbols: string[],
  weeks: number,
  returnFn: (symbol: string, weekIdx: number) => number,
): BarRow[] {
  const bars: BarRow[] = [];
  const startDate = new Date("2023-01-06T16:00:00Z");
  for (const sym of symbols) {
    let close = 100;
    for (let i = 0; i < weeks; i++) {
      if (i > 0) close = close * (1 + returnFn(sym, i));
      const d = new Date(startDate);
      d.setUTCDate(d.getUTCDate() + i * 7);
      bars.push({
        symbol: sym,
        timestamp: d.toISOString().slice(0, 10),
        close,
      });
    }
  }
  return bars;
}

function fakeAlpha(weights: Record<string, number>): AlphaRunResult {
  return {
    runId: "r",
    runTimestamp: "t",
    mode: "returns",
    regime: null,
    N: Object.keys(weights).length,
    NExcluded: 0,
    NEffective: Object.keys(weights).length,
    signals: Object.entries(weights).map(([sym, w]) => ({
      signalKey: `test:${sym}`,
      signalType: "test",
      symbol: sym,
      weight: w,
      epsilon: 0,
      sigma: 1,
      eNorm: 0,
      ic30d: null,
      excluded: false,
      excludeReason: null,
      isq: null,
    })),
    flags: [],
    durationMs: 1,
  };
}

describe("combinations(n, k)", () => {
  it("C(6, 2) = 15 pairs", () => {
    const combos = combinations(6, 2);
    expect(combos.length).toBe(15);
    // first and last
    expect(combos[0]).toEqual([0, 1]);
    expect(combos[14]).toEqual([4, 5]);
  });

  it("C(5, 3) = 10 triples, all strictly ascending", () => {
    const combos = combinations(5, 3);
    expect(combos.length).toBe(10);
    for (const c of combos) {
      for (let i = 1; i < c.length; i++) {
        expect(c[i]!).toBeGreaterThan(c[i - 1]!);
      }
    }
  });

  it("C(3, 0) = [[]]; C(3, 3) = [[0,1,2]]; C(3, 4) = []", () => {
    expect(combinations(3, 0)).toEqual([[]]);
    expect(combinations(3, 3)).toEqual([[0, 1, 2]]);
    expect(combinations(3, 4)).toEqual([]);
  });
});

describe("partitionGroups", () => {
  it("partitions 12 dates into 6 groups of 2", () => {
    const dates = Array.from({ length: 12 }, (_, i) => `2024-01-${i + 1}`);
    const groups = partitionGroups(dates, 6);
    expect(groups.length).toBe(6);
    expect(groups.every((g) => g.length === 2)).toBe(true);
    expect(groups[0]).toEqual([0, 1]);
    expect(groups[5]).toEqual([10, 11]);
  });

  it("distributes remainder to earliest groups", () => {
    // 13 dates into 6 groups → 3,2,2,2,2,2 (extras=1 assigned to group 0)
    const dates = Array.from({ length: 13 }, (_, i) => `d${i}`);
    const groups = partitionGroups(dates, 6);
    expect(groups.map((g) => g.length)).toEqual([3, 2, 2, 2, 2, 2]);
  });

  it("throws on non-positive n", () => {
    expect(() => partitionGroups([], 0)).toThrow();
  });

  it("handles n > L → empty groups at the end", () => {
    const groups = partitionGroups(["a", "b"], 5);
    expect(groups.length).toBe(5);
    expect(groups.filter((g) => g.length > 0).length).toBe(2);
  });
});

describe("F75_DEFAULT_GRID", () => {
  it("has 24 configs (4 × 3 × 2)", () => {
    expect(F75_DEFAULT_GRID.length).toBe(24);
  });

  it("all entries have unique (windowM, windowD, correlationThreshold)", () => {
    const seen = new Set<string>();
    for (const c of F75_DEFAULT_GRID) {
      const k = `${c.windowM}_${c.windowD}_${c.correlationThreshold}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("windowM in {52,78,104,156}", () => {
    const ms = new Set(F75_DEFAULT_GRID.map((c) => c.windowM));
    expect(ms).toEqual(new Set([52, 78, 104, 156]));
  });
});

describe("runCpcv", () => {
  it("produces exactly C(6,2)=15 folds × trials rows", () => {
    const bars = makeBars(["AAPL", "MSFT"], 60, () => 0.01);
    const result = runCpcv({
      bars,
      firings: [],
      watchlistSize: 2,
      trialGrid: [{ windowM: 10, windowD: 4, correlationThreshold: 0.95 }],
      alphaRunner: () => fakeAlpha({ AAPL: 0.5, MSFT: 0.5 }),
    });
    expect(result.nTrialsTotal).toBe(1);
    expect(result.nFoldsPerTrial).toBe(15);
    expect(result.trials[0]!.folds.length).toBe(15);
  });

  it("embargo purges train bars within `embargoBars` of test boundaries", () => {
    // 12 dates, 6 groups of 2. test groups=[0,1] → test indices [0,1,2,3].
    // embargo=1 → train bars that are idx 4 (adj to test group idx 3) get purged.
    // But test group [0,1] = indices 0-3 inclusive. Train groups [2..5] = indices 4-11.
    // Embargo=1 → purge train indices in [0-1, 3+1] → [4]. So train should exclude idx 4.
    const bars = makeBars(["A"], 12, () => 0.01);
    let seenTrainBars: number | undefined;
    const trackingRunner = (input: { bars: BarRow[] }): AlphaRunResult => {
      seenTrainBars = new Set(input.bars.map((b) => b.timestamp.slice(0, 10)))
        .size;
      return fakeAlpha({ A: 1 });
    };
    runCpcv({
      bars,
      firings: [],
      watchlistSize: 1,
      trialGrid: [{ windowM: 5, windowD: 2, correlationThreshold: 0.95 }],
      nGroups: 6,
      kTestGroups: 2,
      embargoBars: 1,
      alphaRunner: trackingRunner as Parameters<
        typeof runCpcv
      >[0]["alphaRunner"],
    });
    // Without embargo, train = 8 indices; with embargo=1, at least one purged
    expect(seenTrainBars).toBeDefined();
    expect(seenTrainBars!).toBeLessThan(8);
  });

  it("aborted folds set aborted=true + reason; not counted in aggregate", () => {
    const bars = makeBars(["X"], 60, () => 0.01);
    let call = 0;
    const flakeyRunner = (): AlphaRunResult => {
      call += 1;
      // abort every 3rd call
      if (call % 3 === 0) throw new F7CorrelatedSignalsError(["test:X"]);
      return fakeAlpha({ X: 1 });
    };
    const result = runCpcv({
      bars,
      firings: [],
      watchlistSize: 1,
      trialGrid: [{ windowM: 10, windowD: 4, correlationThreshold: 0.95 }],
      alphaRunner: flakeyRunner,
    });
    const abortedFolds = result.trials[0]!.folds.filter((f) => f.aborted);
    expect(abortedFolds.length).toBeGreaterThan(0);
    for (const f of abortedFolds) {
      expect(f.abortReason).toBe("correlated_signals");
      expect(f.oosSharpe).toBeNull();
      expect(f.isSharpe).toBeNull();
    }
    expect(result.nAborted).toBe(abortedFolds.length);
  });

  it("aggregate mean/std computed over non-aborted OOS Sharpes only", () => {
    const bars = makeBars(["A", "B"], 60, (_s, i) =>
      i % 2 === 0 ? 0.02 : -0.01,
    );
    const result = runCpcv({
      bars,
      firings: [],
      watchlistSize: 2,
      trialGrid: [{ windowM: 10, windowD: 4, correlationThreshold: 0.95 }],
      alphaRunner: () => fakeAlpha({ A: 0.5, B: 0.5 }),
    });
    // With identical returns across all folds, the mean should be a finite number
    expect(Number.isFinite(result.aggregateSharpeMean)).toBe(true);
    expect(result.nAborted).toBe(0);
  });

  it("rejects invalid k", () => {
    expect(() =>
      runCpcv({
        bars: makeBars(["A"], 10, () => 0),
        firings: [],
        watchlistSize: 1,
        trialGrid: [{ windowM: 5, windowD: 2, correlationThreshold: 0.95 }],
        kTestGroups: 6,
        nGroups: 6,
      }),
    ).toThrow(/kTestGroups/);
  });

  it("rejects empty trial grid", () => {
    expect(() =>
      runCpcv({
        bars: makeBars(["A"], 10, () => 0),
        firings: [],
        watchlistSize: 1,
        trialGrid: [],
      }),
    ).toThrow(/trialGrid/);
  });

  it("24-trial grid × 15 folds = 360 path rows", () => {
    const bars = makeBars(["A", "B", "C"], 80, (_s, i) =>
      i % 3 === 0 ? 0.01 : 0,
    );
    const result = runCpcv({
      bars,
      firings: [],
      watchlistSize: 3,
      trialGrid: F75_DEFAULT_GRID,
      alphaRunner: () => fakeAlpha({ A: 0.3, B: 0.3, C: 0.3 }),
    });
    expect(result.nTrialsTotal).toBe(24);
    expect(result.nFoldsPerTrial).toBe(15);
    const totalFoldRows = result.trials.reduce((n, t) => n + t.folds.length, 0);
    expect(totalFoldRows).toBe(360);
  });
});
