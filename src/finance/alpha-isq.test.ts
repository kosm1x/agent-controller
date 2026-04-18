/**
 * Unit tests for F7 ISQ dimensions + IC computation.
 */

import { describe, it, expect } from "vitest";
import {
  todayInNewYork,
  computePerSignalIC,
  computeIsqAll,
  type IsqInputs,
} from "./alpha-isq.js";

describe("todayInNewYork", () => {
  it("returns YYYY-MM-DD format", () => {
    const day = todayInNewYork();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles a fixed instant deterministically", () => {
    // 2026-04-17 15:00 UTC → NY is EDT (UTC-4) → 11:00 NY → same calendar day
    const d = new Date("2026-04-17T15:00:00Z");
    expect(todayInNewYork(d)).toBe("2026-04-17");
  });

  it("correctly handles midnight-UTC rollover to previous NY day", () => {
    // 2026-04-17 02:00 UTC → NY is EDT (UTC-4) → previous day 22:00 NY
    const d = new Date("2026-04-17T02:00:00Z");
    expect(todayInNewYork(d)).toBe("2026-04-16");
  });
});

describe("computePerSignalIC", () => {
  it("returns null for signals below minFirings threshold", () => {
    const R = new Float64Array(10);
    R.fill(0.01);
    const firingPeriods = [new Set<number>([0, 1, 2])];
    const ic = computePerSignalIC({
      R,
      N: 1,
      M: 10,
      firingPeriods,
      minFirings: 30,
    });
    expect(ic[0]).toBeNull();
  });

  it("computes mean direction-adjusted return over firing periods", () => {
    const M = 5;
    const R = new Float64Array(M);
    R[0] = 0.01;
    R[1] = 0.02;
    R[2] = -0.01;
    R[3] = 0.0;
    R[4] = 0.03;
    // 5 firings
    const firingPeriods = [new Set<number>([0, 1, 2, 3, 4])];
    const ic = computePerSignalIC({
      R,
      N: 1,
      M,
      firingPeriods,
      minFirings: 3,
    });
    expect(ic[0]).toBeCloseTo(0.01, 10);
  });

  it("returns null when valid-firing count is below minFirings (NaN fill)", () => {
    // Audit W8 round 1: flagged/NaN cells are skipped; if the remaining valid
    // count falls below minFirings, IC returns null (benefit of the doubt).
    const M = 5;
    const R = new Float64Array(M);
    R.fill(NaN);
    const firingPeriods = [new Set<number>([0, 1, 2, 3, 4])];
    const ic = computePerSignalIC({
      R,
      N: 1,
      M,
      firingPeriods,
      minFirings: 3,
    });
    expect(ic[0]).toBeNull();
  });

  it("skips flagged periods (W8)", () => {
    // 5 firings with valid returns [0.01..0.05], but 2 are flagged.
    // Remaining 3 valid values: [0.01, 0.04, 0.05] → mean = 0.0333.
    const M = 5;
    const R = new Float64Array([0.01, 0.02, 0.03, 0.04, 0.05]);
    const firingPeriods = [new Set<number>([0, 1, 2, 3, 4])];
    const flaggedPeriods = [new Set<number>([1, 2])]; // flag indices 1 and 2
    const ic = computePerSignalIC({
      R,
      N: 1,
      M,
      firingPeriods,
      flaggedPeriods,
      minFirings: 3,
    });
    expect(ic[0]).toBeCloseTo((0.01 + 0.04 + 0.05) / 3, 10);
  });
});

// ---------------------------------------------------------------------------
// ISQ dimensions
// ---------------------------------------------------------------------------

function makeIsqInput(over: Partial<IsqInputs> = {}): IsqInputs {
  const M = 12;
  const N = 2;
  const R = new Float64Array(N * M);
  return {
    N,
    R,
    M,
    epsilon: [0.02, 0.01],
    sigma: [0.05, 0.05],
    ic: [0.05, -0.08],
    firingPeriods: [new Set<number>([0, 4, 8]), new Set<number>([2, 6, 10])],
    firedToday: [true, false],
    typeSymbolCounts: new Map([
      ["rsi_extreme", 3],
      ["macd_crossover", 1],
    ]),
    typeOfSignal: ["rsi_extreme", "macd_crossover"],
    watchlistSize: 10,
    ...over,
  };
}

describe("computeIsqAll", () => {
  it("returns N dimension bags with all values in [0,1]", () => {
    const dims = computeIsqAll(makeIsqInput());
    expect(dims.length).toBe(2);
    for (const d of dims) {
      for (const v of [
        d.efficiency,
        d.timeliness,
        d.coverage,
        d.stability,
        d.forward_ic,
      ]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("timeliness = 1 when firedToday, 0.5 otherwise", () => {
    const dims = computeIsqAll(makeIsqInput());
    expect(dims[0]!.timeliness).toBe(1.0);
    expect(dims[1]!.timeliness).toBe(0.5);
  });

  it("coverage = symbols / watchlistSize per signal type", () => {
    const dims = computeIsqAll(makeIsqInput());
    expect(dims[0]!.coverage).toBe(0.3); // 3/10
    expect(dims[1]!.coverage).toBe(0.1); // 1/10
  });

  it("forward_ic remaps [-0.15, +0.15] → [0, 1]", () => {
    const dims = computeIsqAll(makeIsqInput());
    // ic=0.05 → (0.05 + 0.15)/0.30 ≈ 0.667
    expect(dims[0]!.forward_ic).toBeCloseTo(0.667, 2);
    // ic=-0.08 → (-0.08 + 0.15)/0.30 ≈ 0.233
    expect(dims[1]!.forward_ic).toBeCloseTo(0.233, 2);
  });

  it("forward_ic clamps at the boundaries", () => {
    const dims = computeIsqAll(
      makeIsqInput({ ic: [0.5, -0.5] }), // way outside window
    );
    expect(dims[0]!.forward_ic).toBe(1);
    expect(dims[1]!.forward_ic).toBe(0);
  });

  it("forward_ic = 0.5 when ic is null (benefit of the doubt)", () => {
    const dims = computeIsqAll(makeIsqInput({ ic: [null, null] }));
    expect(dims[0]!.forward_ic).toBe(0.5);
    expect(dims[1]!.forward_ic).toBe(0.5);
  });

  it("efficiency is 0 when sumAbsEpsilon is 0", () => {
    const dims = computeIsqAll(
      makeIsqInput({ epsilon: [0, 0], sigma: [0.1, 0.1] }),
    );
    expect(dims[0]!.efficiency).toBe(0);
    expect(dims[1]!.efficiency).toBe(0);
  });

  it("stability is 0.5 when firings < 3 per sub-window", () => {
    const dims = computeIsqAll(
      makeIsqInput({
        firingPeriods: [new Set<number>([0]), new Set<number>([1])],
      }),
    );
    expect(dims[0]!.stability).toBe(0.5);
    expect(dims[1]!.stability).toBe(0.5);
  });
});
