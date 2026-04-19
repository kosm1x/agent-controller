import { describe, expect, it } from "vitest";
import {
  simulatePnL,
  type BarReturnRow,
  type WeightsAtBar,
} from "./backtest-sim.js";

describe("simulatePnL", () => {
  it("returns empty result for empty schedule", () => {
    const result = simulatePnL({
      bars: [],
      weightsSchedule: [],
      costBps: 5,
    });
    expect(result.steps).toEqual([]);
    expect(result.finalEquity).toBe(1);
    expect(result.cumReturn).toBe(0);
    expect(result.totalTrades).toBe(0);
  });

  it("holds cash (empty weights) → equity unchanged", () => {
    const bars: BarReturnRow[] = [
      { timestamp: "2024-01-01", symbol: "AAPL", ret: 0.05 },
      { timestamp: "2024-01-08", symbol: "AAPL", ret: -0.03 },
    ];
    const schedule: WeightsAtBar[] = [
      { timestamp: "2024-01-01", weights: {} },
      { timestamp: "2024-01-08", weights: {} },
    ];
    const result = simulatePnL({ bars, weightsSchedule: schedule, costBps: 5 });
    expect(result.finalEquity).toBe(1);
    expect(result.cumReturn).toBe(0);
    expect(result.totalTrades).toBe(0);
    for (const s of result.steps) {
      expect(s.gross).toBe(0);
      expect(s.cost).toBe(0);
      expect(s.net).toBe(0);
    }
  });

  it("single position, cost=0 → P&L = weight × forward return exactly", () => {
    const bars: BarReturnRow[] = [
      { timestamp: "2024-01-01", symbol: "AAPL", ret: 0 },
      { timestamp: "2024-01-08", symbol: "AAPL", ret: 0.1 },
      { timestamp: "2024-01-15", symbol: "AAPL", ret: -0.05 },
    ];
    const schedule: WeightsAtBar[] = [
      { timestamp: "2024-01-01", weights: { AAPL: 0.5 } },
      { timestamp: "2024-01-08", weights: { AAPL: 0.5 } },
      { timestamp: "2024-01-15", weights: { AAPL: 0.5 } },
    ];
    const result = simulatePnL({ bars, weightsSchedule: schedule, costBps: 0 });

    expect(result.steps[0]!.gross).toBe(0);
    expect(result.steps[0]!.cost).toBe(0);
    expect(result.steps[1]!.gross).toBeCloseTo(0.5 * 0.1, 12);
    expect(result.steps[1]!.cost).toBe(0);
    expect(result.steps[2]!.gross).toBeCloseTo(0.5 * -0.05, 12);

    const expectedFinal = 1 * 1 * (1 + 0.5 * 0.1) * (1 + 0.5 * -0.05);
    expect(result.finalEquity).toBeCloseTo(expectedFinal, 12);
  });

  it("position change incurs cost = bps × |Δw|", () => {
    const bars: BarReturnRow[] = [
      { timestamp: "2024-01-01", symbol: "AAPL", ret: 0 },
      { timestamp: "2024-01-08", symbol: "AAPL", ret: 0.02 },
    ];
    const schedule: WeightsAtBar[] = [
      { timestamp: "2024-01-01", weights: { AAPL: 0.3 } },
      { timestamp: "2024-01-08", weights: { AAPL: 0.7 } },
    ];
    const result = simulatePnL({ bars, weightsSchedule: schedule, costBps: 5 });

    // Bar 0: opening, turnover = |0.3 − 0| = 0.3, cost = 5e-4 × 0.3 = 1.5e-4
    expect(result.steps[0]!.gross).toBe(0);
    expect(result.steps[0]!.cost).toBeCloseTo(5e-4 * 0.3, 15);
    expect(result.steps[0]!.net).toBeCloseTo(-1.5e-4, 15);

    // Bar 1: gross = 0.3 × 0.02 = 0.006, turnover = |0.7 − 0.3| = 0.4
    //        cost = 5e-4 × 0.4 = 2e-4
    expect(result.steps[1]!.gross).toBeCloseTo(0.006, 15);
    expect(result.steps[1]!.cost).toBeCloseTo(2e-4, 15);
    expect(result.steps[1]!.net).toBeCloseTo(0.006 - 2e-4, 15);

    expect(result.totalTrades).toBe(2);
  });

  it("hand-computed 3-bar, 2-symbol fixture", () => {
    // AAPL returns: 0.10, -0.05, +0.02
    // MSFT returns: 0.00, +0.03, -0.01
    // weights: bar0 {A:0.4,M:0.4}, bar1 {A:0.2,M:0.6}, bar2 {A:0.2,M:0.6}
    const bars: BarReturnRow[] = [
      { timestamp: "2024-01-01", symbol: "AAPL", ret: 0.1 },
      { timestamp: "2024-01-01", symbol: "MSFT", ret: 0 },
      { timestamp: "2024-01-08", symbol: "AAPL", ret: -0.05 },
      { timestamp: "2024-01-08", symbol: "MSFT", ret: 0.03 },
      { timestamp: "2024-01-15", symbol: "AAPL", ret: 0.02 },
      { timestamp: "2024-01-15", symbol: "MSFT", ret: -0.01 },
    ];
    const schedule: WeightsAtBar[] = [
      { timestamp: "2024-01-01", weights: { AAPL: 0.4, MSFT: 0.4 } },
      { timestamp: "2024-01-08", weights: { AAPL: 0.2, MSFT: 0.6 } },
      { timestamp: "2024-01-15", weights: { AAPL: 0.2, MSFT: 0.6 } },
    ];
    const result = simulatePnL({ bars, weightsSchedule: schedule, costBps: 5 });

    // Bar 0: gross=0, turnover=|0.4|+|0.4|=0.8, cost=0.0008·0.5=4e-4
    expect(result.steps[0]!.gross).toBe(0);
    expect(result.steps[0]!.cost).toBeCloseTo(5e-4 * 0.8, 15);

    // Bar 1: gross = 0.4·(-0.05) + 0.4·0.03 = -0.02 + 0.012 = -0.008
    //        turnover = |0.2-0.4| + |0.6-0.4| = 0.2 + 0.2 = 0.4
    //        cost = 5e-4 · 0.4 = 2e-4
    expect(result.steps[1]!.gross).toBeCloseTo(-0.008, 15);
    expect(result.steps[1]!.cost).toBeCloseTo(2e-4, 15);

    // Bar 2: gross = 0.2·0.02 + 0.6·(-0.01) = 0.004 - 0.006 = -0.002
    //        turnover = 0 (no rebalance), cost = 0
    expect(result.steps[2]!.gross).toBeCloseTo(-0.002, 15);
    expect(result.steps[2]!.cost).toBe(0);

    expect(result.totalTrades).toBe(2);
  });

  it("throws on non-ascending weights schedule", () => {
    expect(() =>
      simulatePnL({
        bars: [],
        weightsSchedule: [
          { timestamp: "2024-01-08", weights: {} },
          { timestamp: "2024-01-01", weights: {} },
        ],
        costBps: 5,
      }),
    ).toThrow(/not strictly ascending/);
  });

  it("throws on missing return for held symbol", () => {
    // Bar 0 opens AAPL; bar 1 rebalances to MSFT but the bars map has no AAPL
    // return at 2024-01-08 → held AAPL can't be priced → throw.
    expect(() =>
      simulatePnL({
        bars: [{ timestamp: "2024-01-08", symbol: "MSFT", ret: 0.05 }],
        weightsSchedule: [
          { timestamp: "2024-01-01", weights: { AAPL: 0.5 } },
          { timestamp: "2024-01-08", weights: { MSFT: 0.5 } },
        ],
        costBps: 5,
      }),
    ).toThrow(/missing return/);
  });

  it("throws on non-finite returns", () => {
    expect(() =>
      simulatePnL({
        bars: [{ timestamp: "2024-01-01", symbol: "AAPL", ret: NaN }],
        weightsSchedule: [{ timestamp: "2024-01-01", weights: { AAPL: 0.5 } }],
        costBps: 5,
      }),
    ).toThrow(/non-finite/);
  });

  it("throws on negative costBps", () => {
    expect(() =>
      simulatePnL({ bars: [], weightsSchedule: [], costBps: -1 }),
    ).toThrow(/costBps must be >= 0/);
  });

  it("throws on non-positive initialEquity", () => {
    expect(() =>
      simulatePnL({
        bars: [],
        weightsSchedule: [],
        costBps: 5,
        initialEquity: 0,
      }),
    ).toThrow(/initialEquity/);
  });

  it("initialEquity scales final equity; cumReturn independent of scale", () => {
    const bars: BarReturnRow[] = [
      { timestamp: "2024-01-01", symbol: "AAPL", ret: 0 },
      { timestamp: "2024-01-08", symbol: "AAPL", ret: 0.1 },
    ];
    const schedule: WeightsAtBar[] = [
      { timestamp: "2024-01-01", weights: { AAPL: 1.0 } },
      { timestamp: "2024-01-08", weights: { AAPL: 1.0 } },
    ];
    const r1 = simulatePnL({
      bars,
      weightsSchedule: schedule,
      costBps: 0,
      initialEquity: 1,
    });
    const r100 = simulatePnL({
      bars,
      weightsSchedule: schedule,
      costBps: 0,
      initialEquity: 100,
    });

    expect(r100.finalEquity).toBeCloseTo(100 * r1.finalEquity, 12);
    expect(r100.cumReturn).toBeCloseTo(r1.cumReturn, 12);
  });

  it("weight dropping to 0 charges cost on exit", () => {
    const bars: BarReturnRow[] = [
      { timestamp: "2024-01-01", symbol: "AAPL", ret: 0 },
      { timestamp: "2024-01-08", symbol: "AAPL", ret: 0.1 },
      { timestamp: "2024-01-15", symbol: "AAPL", ret: 0.1 },
    ];
    const schedule: WeightsAtBar[] = [
      { timestamp: "2024-01-01", weights: { AAPL: 0.5 } },
      { timestamp: "2024-01-08", weights: { AAPL: 0 } },
      { timestamp: "2024-01-15", weights: {} },
    ];
    const result = simulatePnL({
      bars,
      weightsSchedule: schedule,
      costBps: 10,
    });

    // Bar 1: exit position, turnover=0.5, cost=1e-3·0.5=5e-4
    expect(result.steps[1]!.cost).toBeCloseTo(1e-3 * 0.5, 15);
    // Bar 2: no position, no gross, no cost
    expect(result.steps[2]!.gross).toBe(0);
    expect(result.steps[2]!.cost).toBe(0);
  });
});
