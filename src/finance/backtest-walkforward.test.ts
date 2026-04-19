import { describe, expect, it } from "vitest";
import {
  computeBarReturns,
  runWalkForward,
  type WalkForwardOpts,
} from "./backtest-walkforward.js";
import type { AlphaRunResult } from "./alpha-combination.js";
import { F7CorrelatedSignalsError } from "./alpha-combination.js";
import type { BarRow } from "./alpha-matrix.js";

/** Build a synthetic bar series with deterministic returns. */
function makeBars(
  symbols: string[],
  weeks: number,
  returnFn: (symbol: string, weekIdx: number) => number,
): BarRow[] {
  const bars: BarRow[] = [];
  const startDate = new Date("2023-01-06T16:00:00Z"); // a Friday
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

/** Synthetic alpha runner that always returns the given weights. */
function constantAlphaRunner(weights: Record<string, number>) {
  return (): AlphaRunResult => ({
    runId: "test-run",
    runTimestamp: new Date().toISOString(),
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
  });
}

describe("computeBarReturns", () => {
  it("computes simple returns per symbol", () => {
    const bars: BarRow[] = [
      { symbol: "AAPL", timestamp: "2024-01-05", close: 100 },
      { symbol: "AAPL", timestamp: "2024-01-12", close: 110 },
      { symbol: "AAPL", timestamp: "2024-01-19", close: 99 },
      { symbol: "MSFT", timestamp: "2024-01-05", close: 200 },
      { symbol: "MSFT", timestamp: "2024-01-12", close: 210 },
    ];
    const returns = computeBarReturns(bars);
    const aapl = returns.filter((r) => r.symbol === "AAPL");
    expect(aapl).toHaveLength(2);
    expect(aapl[0]!.ret).toBeCloseTo(0.1, 12);
    expect(aapl[1]!.ret).toBeCloseTo(99 / 110 - 1, 12);
    const msft = returns.filter((r) => r.symbol === "MSFT");
    expect(msft).toHaveLength(1);
    expect(msft[0]!.ret).toBeCloseTo(0.05, 12);
  });

  it("skips invalid closes", () => {
    const bars: BarRow[] = [
      { symbol: "A", timestamp: "2024-01-05", close: 100 },
      { symbol: "A", timestamp: "2024-01-12", close: 0 },
      { symbol: "A", timestamp: "2024-01-19", close: 110 },
    ];
    const returns = computeBarReturns(bars);
    // 0 close → skip both the transition to and from it
    expect(returns).toHaveLength(0);
  });

  it("sorts bars within symbol before computing returns", () => {
    const bars: BarRow[] = [
      { symbol: "X", timestamp: "2024-01-19", close: 99 },
      { symbol: "X", timestamp: "2024-01-05", close: 100 },
      { symbol: "X", timestamp: "2024-01-12", close: 110 },
    ];
    const returns = computeBarReturns(bars);
    expect(returns.map((r) => r.timestamp)).toEqual([
      "2024-01-12",
      "2024-01-19",
    ]);
  });
});

describe("runWalkForward", () => {
  it("returns empty result if history <= warmup", () => {
    const bars = makeBars(["AAPL"], 5, () => 0);
    const result = runWalkForward({
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      alphaRunner: constantAlphaRunner({ AAPL: 1 }),
    });
    expect(result.equityCurve).toEqual([]);
    expect(result.nTestBars).toBe(0);
    expect(result.nWarmupBars).toBe(10);
  });

  it("applies constant weights and tracks equity", () => {
    // 20 weekly bars, windowM=10 → 10 test bars. AAPL returns +1% every week.
    const bars = makeBars(["AAPL"], 20, () => 0.01);
    const opts: WalkForwardOpts = {
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      costBps: 0,
      rebalanceBars: 1,
      alphaRunner: constantAlphaRunner({ AAPL: 1.0 }),
    };
    const result = runWalkForward(opts);
    expect(result.nTestBars).toBe(10);
    // Walk-forward convention: first test bar has no P&L (prevWeights = {} at
    // bar boundary). 10 schedule entries → 9 compounding 1% returns.
    expect(result.cumReturn).toBeCloseTo(Math.pow(1.01, 9) - 1, 8);
    // First bar's 0 with 9 nonzero 0.01s → nonzero stdev → nonzero Sharpe
    expect(result.maxDrawdown).toBe(0);
    // 9 of 10 bars have positive return
    expect(result.winRate).toBeCloseTo(0.9, 6);
  });

  it("annualizes Sharpe by √52 for weekly rebalancing", () => {
    // Alternating +2% / -1% weekly returns → mean 0.005, stdev ≈ 0.015
    const bars = makeBars(["A"], 30, (_s, i) => (i % 2 === 0 ? 0.02 : -0.01));
    const result = runWalkForward({
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      costBps: 0,
      rebalanceBars: 1,
      alphaRunner: constantAlphaRunner({ A: 1.0 }),
    });
    // Hand-check: 20 test bars, first = 0 (no prev weights), remaining 19
    // alternating -0.01, +0.02, ..., -0.01 (10 negs + 9 pos). mean≈0.004,
    // std≈0.015 → Sharpe ≈ 0.004/0.015 × √52 ≈ 1.92.
    expect(result.sharpe).toBeGreaterThan(1);
    expect(result.sharpe).toBeLessThan(3);
    expect(result.winRate).toBeCloseTo(9 / 20, 3);
  });

  it("drawdown is positive magnitude and ≤ 1", () => {
    // Weeks 11-15: -5% each; weeks 16+: 0%
    const bars = makeBars(["B"], 30, (_s, i) =>
      i >= 11 && i <= 15 ? -0.05 : 0,
    );
    const result = runWalkForward({
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      costBps: 0,
      rebalanceBars: 1,
      alphaRunner: constantAlphaRunner({ B: 1.0 }),
    });
    expect(result.maxDrawdown).toBeGreaterThan(0);
    expect(result.maxDrawdown).toBeLessThan(1);
    // 5 weeks of -5%: (1-0.05)^5 - 1 = -0.22622 → drawdown ≈ 0.2262
    expect(result.maxDrawdown).toBeCloseTo(1 - Math.pow(0.95, 5), 6);
  });

  it("holds prior weights when F7 aborts with correlated signals", () => {
    const bars = makeBars(["AAPL"], 20, () => 0.01);
    let call = 0;
    const flakeyRunner = (): AlphaRunResult => {
      call += 1;
      if (call >= 5) throw new F7CorrelatedSignalsError(["test:AAPL"]);
      return constantAlphaRunner({ AAPL: 0.5 })();
    };
    const result = runWalkForward({
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      costBps: 0,
      rebalanceBars: 1,
      alphaRunner: flakeyRunner,
    });
    // Aborts from call 5 onward — should record nAbortedRuns > 0 but not throw.
    expect(result.nAbortedRuns).toBeGreaterThan(0);
    expect(result.nTestBars).toBe(10);
  });

  it("non-F7 errors propagate", () => {
    const bars = makeBars(["AAPL"], 20, () => 0.01);
    const boomRunner = () => {
      throw new Error("unexpected boom");
    };
    expect(() =>
      runWalkForward({
        bars,
        firings: [],
        watchlistSize: 1,
        windowM: 10,
        alphaRunner: boomRunner as WalkForwardOpts["alphaRunner"],
      }),
    ).toThrow(/unexpected boom/);
  });

  it("respects rebalanceBars: refreshes every N bars", () => {
    // With rebalanceBars=4, weights update on bar 0, 4, 8, ...
    const bars = makeBars(["X"], 30, () => 0.01);
    let refreshCount = 0;
    const countingRunner = (): AlphaRunResult => {
      refreshCount += 1;
      return constantAlphaRunner({ X: 1.0 })();
    };
    const result = runWalkForward({
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      rebalanceBars: 4,
      costBps: 0,
      alphaRunner: countingRunner,
    });
    // 20 test bars, refresh every 4 → 5 refreshes (bars 0,4,8,12,16)
    expect(refreshCount).toBe(5);
    // equity curve covers all test bars regardless
    expect(result.nTestBars).toBe(20);
  });

  it("aggregates multi-signal same-symbol weights", () => {
    const bars = makeBars(["Y"], 15, (_s, _i) => 0.01);
    const multiSignalRunner = (): AlphaRunResult => ({
      runId: "r",
      runTimestamp: "t",
      mode: "returns",
      regime: null,
      N: 2,
      NExcluded: 0,
      NEffective: 2,
      signals: [
        {
          signalKey: "macd:Y",
          signalType: "macd",
          symbol: "Y",
          weight: 0.3,
          epsilon: 0,
          sigma: 1,
          eNorm: 0,
          ic30d: null,
          excluded: false,
          excludeReason: null,
          isq: null,
        },
        {
          signalKey: "rsi:Y",
          signalType: "rsi",
          symbol: "Y",
          weight: 0.2,
          epsilon: 0,
          sigma: 1,
          eNorm: 0,
          ic30d: null,
          excluded: false,
          excludeReason: null,
          isq: null,
        },
      ],
      flags: [],
      durationMs: 1,
    });
    const result = runWalkForward({
      bars,
      firings: [],
      watchlistSize: 1,
      windowM: 10,
      costBps: 0,
      rebalanceBars: 1,
      alphaRunner: multiSignalRunner,
    });
    // Effective per-symbol weight = 0.5. 5 test bars → 4 compounding 0.5% returns.
    expect(result.cumReturn).toBeCloseTo(Math.pow(1.005, 4) - 1, 8);
  });
});
