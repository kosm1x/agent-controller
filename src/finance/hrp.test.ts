import { describe, it, expect } from "vitest";
import {
  hierarchicalRiskParity,
  distanceFromCorrelation,
  singleLinkage,
  quasiDiag,
  recursiveBisection,
  corrMatrixFromCols,
} from "./hrp.js";

const sumClose = (w: number[]): number => w.reduce((a, b) => a + b, 0);

describe("distanceFromCorrelation", () => {
  it("maps perfect positive correlation to 0", () => {
    const d = distanceFromCorrelation([
      [1, 1],
      [1, 1],
    ]);
    expect(d[0]![1]).toBeCloseTo(0, 12);
  });

  it("maps perfect negative correlation to 1", () => {
    const d = distanceFromCorrelation([
      [1, -1],
      [-1, 1],
    ]);
    expect(d[0]![1]).toBeCloseTo(1, 12);
  });

  it("maps zero correlation to sqrt(0.5) ≈ 0.7071", () => {
    const d = distanceFromCorrelation([
      [1, 0],
      [0, 1],
    ]);
    expect(d[0]![1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("collapses non-finite correlations to 1 (no NaN propagation)", () => {
    const d = distanceFromCorrelation([
      [1, NaN],
      [NaN, 1],
    ]);
    expect(d[0]![1]).toBe(1);
  });

  it("zeros the diagonal", () => {
    const d = distanceFromCorrelation([
      [1, 0.5],
      [0.5, 1],
    ]);
    expect(d[0]![0]).toBe(0);
    expect(d[1]![1]).toBe(0);
  });

  it("clamps overshoot above 1.0 (floating-point) to 0 instead of NaN", () => {
    // Empirical correlations on perfectly-correlated synthetic data can
    // land at 1 + 7e-16. Without the Math.max(0, ...) clamp this would
    // produce NaN and break the linkage step downstream.
    const c = 1.0000000000000007;
    const d = distanceFromCorrelation([
      [1, c],
      [c, 1],
    ]);
    expect(d[0]![1]).toBe(0);
    expect(Number.isNaN(d[0]![1])).toBe(false);
  });
});

describe("singleLinkage", () => {
  it("merges the closest pair first, then chains by min-distance", () => {
    // 3 points on a line: A=0, B=0.1, C=10. Distances (symmetric):
    //   A-B = 0.1, A-C = 10, B-C = 9.9.
    // Single-linkage merges A+B first (dist 0.1), then merges that
    // cluster with C (min(A-C, B-C) = 9.9).
    const dist = [
      [0, 0.1, 10],
      [0.1, 0, 9.9],
      [10, 9.9, 0],
    ];
    const steps = singleLinkage(dist);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.distance).toBeCloseTo(0.1, 12);
    // First merge involves leaves 0 and 1.
    expect(new Set([steps[0]!.leftId, steps[0]!.rightId])).toEqual(
      new Set([0, 1]),
    );
    expect(steps[1]!.distance).toBeCloseTo(9.9, 12);
    expect(steps[1]!.size).toBe(3);
  });

  it("returns empty steps for N <= 1", () => {
    expect(singleLinkage([])).toEqual([]);
    expect(singleLinkage([[0]])).toEqual([]);
  });

  it("is deterministic on tie-broken distances (stable order)", () => {
    // All-ones distance: every pair tied. Output must be deterministic.
    const dist = [
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
    ];
    const a = singleLinkage(dist);
    const b = singleLinkage(dist);
    expect(a).toEqual(b);
  });

  it("tie-break picks (min-id, max-id) lexicographic order on equal distances", () => {
    // 4 leaves all 1 unit apart — fully tied at every step.
    // Tie-break promises lowest (min,max) pair wins each iteration.
    // Step 1: cheapest pair is (0,1).                          → newId=4
    // Step 2: among {2,3,4} all pairs tied at d=1 (single-link
    //         from 4 to 2/3 = min(d04,d14)=1). Lowest (min,max)
    //         is (2,3).                                          → newId=5
    // Step 3: only {4,5} left.                                  → newId=6
    const dist = [
      [0, 1, 1, 1],
      [1, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 1, 1, 0],
    ];
    const steps = singleLinkage(dist);
    expect(steps).toHaveLength(3);
    // Step 1: (0,1)
    expect(steps[0]!.leftId).toBe(0);
    expect(steps[0]!.rightId).toBe(1);
    expect(steps[0]!.size).toBe(2);
    // Step 2: (2,3) — lower-id pair beats anything involving the new cluster id 4
    expect(steps[1]!.leftId).toBe(2);
    expect(steps[1]!.rightId).toBe(3);
    expect(steps[1]!.size).toBe(2);
    // Step 3: (4,5)
    expect(steps[2]!.leftId).toBe(4);
    expect(steps[2]!.rightId).toBe(5);
    expect(steps[2]!.size).toBe(4);
  });
});

describe("quasiDiag", () => {
  it("returns leaves in left-then-right walk order", () => {
    // 3 leaves: merge 0+1 first (id=3), then 3+2 (id=4).
    const steps = [
      { leftId: 0, rightId: 1, distance: 0.1, size: 2 },
      { leftId: 3, rightId: 2, distance: 0.9, size: 3 },
    ];
    expect(quasiDiag(steps, 3)).toEqual([0, 1, 2]);
  });

  it("returns [0] for N=1 with no steps", () => {
    expect(quasiDiag([], 1)).toEqual([0]);
  });

  it("returns [] for N=0", () => {
    expect(quasiDiag([], 0)).toEqual([]);
  });
});

describe("recursiveBisection", () => {
  it("splits two assets by inverse-variance ratio", () => {
    // Asset 0 var=1, Asset 1 var=4 → IVP weights ∝ 1/var → 0.8 / 0.2.
    const w = recursiveBisection([1, 4], [0, 1]);
    expect(w[0]).toBeCloseTo(0.8, 6);
    expect(w[1]).toBeCloseTo(0.2, 6);
    expect(sumClose(w)).toBe(1);
  });

  it("returns equal weights for equal-variance assets", () => {
    const w = recursiveBisection([1, 1, 1, 1], [0, 1, 2, 3]);
    for (const wi of w) expect(wi).toBeCloseTo(0.25, 6);
    expect(sumClose(w)).toBe(1);
  });

  it("respects the order argument when allocating bisection halves", () => {
    // Variances [1, 4, 1, 4]. With order [0,2,1,3] the split puts the
    // two low-var assets together vs the two high-var assets together,
    // giving (low-half, high-half) variance shares 0.5/0.125 → α≈0.8.
    const w = recursiveBisection([1, 4, 1, 4], [0, 2, 1, 3]);
    // Low-var assets (0, 2) should get >25%; high-var (1, 3) should get <25%.
    expect(w[0]).toBeGreaterThan(0.25);
    expect(w[2]).toBeGreaterThan(0.25);
    expect(w[1]).toBeLessThan(0.25);
    expect(w[3]).toBeLessThan(0.25);
    expect(sumClose(w)).toBe(1);
  });

  it("handles single-asset case", () => {
    expect(recursiveBisection([1], [0])).toEqual([1]);
  });

  it("returns empty for zero assets", () => {
    expect(recursiveBisection([], [])).toEqual([]);
  });

  it("falls back to equal split when both halves have zero variance", () => {
    // Two flat assets: each cluster variance 0 → alpha = 0.5.
    const w = recursiveBisection([0, 0], [0, 1]);
    expect(w[0]).toBeCloseTo(0.5, 6);
    expect(w[1]).toBeCloseTo(0.5, 6);
  });
});

describe("hierarchicalRiskParity (end-to-end)", () => {
  it("returns a single weight for N=1", () => {
    expect(hierarchicalRiskParity([[0.1], [0.2]])).toEqual([1]);
  });

  it("returns weights summing to exactly 1.0 (long-only)", () => {
    const ret = [
      [0.01, -0.005, 0.02, 0.0],
      [-0.005, 0.01, -0.01, 0.005],
      [0.015, 0.0, 0.005, -0.01],
      [-0.01, 0.005, -0.005, 0.01],
      [0.0, 0.015, 0.0, -0.005],
    ];
    const w = hierarchicalRiskParity(ret);
    expect(w).toHaveLength(4);
    for (const wi of w) expect(wi).toBeGreaterThanOrEqual(0);
    expect(sumClose(w)).toBe(1);
  });

  it("low-volatility asset receives a higher weight than a high-volatility uncorrelated asset", () => {
    // Asset 0: tiny vol; Asset 1: large vol. Uncorrelated.
    const ret: number[][] = [];
    for (let t = 0; t < 60; t++) {
      ret.push([t % 2 === 0 ? 0.001 : -0.001, t % 2 === 0 ? 0.05 : -0.05]);
    }
    const w = hierarchicalRiskParity(ret);
    expect(w[0]).toBeGreaterThan(w[1]);
  });

  it("falls back to equal weight when all assets are flat", () => {
    const ret = [
      [5, 5, 5],
      [5, 5, 5],
      [5, 5, 5],
    ];
    const w = hierarchicalRiskParity(ret);
    expect(w).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("rejects unimplemented linkage methods explicitly", () => {
    expect(() =>
      hierarchicalRiskParity(
        [
          [0.01, 0.02],
          [-0.01, -0.02],
        ],
        // @ts-expect-error — testing the runtime guard for an unsupported value.
        { linkage: "ward" },
      ),
    ).toThrow(/not implemented/i);
  });

  it("throws on empty / zero-column input", () => {
    expect(() => hierarchicalRiskParity([])).toThrow();
    expect(() => hierarchicalRiskParity([[]])).toThrow();
  });
});

describe("corrMatrixFromCols (sanity)", () => {
  it("identity for orthogonal-looking inputs", () => {
    const cols = [
      [1, -1, 1, -1],
      [1, 1, -1, -1],
    ];
    const m = corrMatrixFromCols(cols);
    expect(m[0]![0]).toBe(1);
    expect(m[1]![1]).toBe(1);
    expect(m[0]![1]).toBeCloseTo(0, 6);
    expect(m[0]![1]).toBe(m[1]![0]); // symmetric
  });
});
