/**
 * Unit tests for F7 linear-algebra primitives.
 */

import { describe, it, expect } from "vitest";
import {
  dot,
  sampleMean,
  sampleVarianceBessel,
  timeMeanMatrix,
  scalarOlsNoIntercept,
  correlation,
  correlationMatrix,
  maxOffDiagonal,
  removeIndex,
  removeRow,
  clamp,
} from "./alpha-linalg.js";

describe("dot", () => {
  it("computes standard dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
  it("returns 0 for empty inputs", () => {
    expect(dot([], [])).toBe(0);
  });
  it("throws on length mismatch", () => {
    expect(() => dot([1, 2], [1])).toThrow(/length mismatch/);
  });
});

describe("sampleMean", () => {
  it("computes arithmetic mean", () => {
    expect(sampleMean([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns 0 for empty input", () => {
    expect(sampleMean([])).toBe(0);
  });
});

describe("sampleVarianceBessel", () => {
  it("uses (n-1) divisor", () => {
    // Variance of [1,2,3,4] with Bessel = ((1.5)²+(0.5)²+(0.5)²+(1.5)²)/3 = 5/3
    expect(sampleVarianceBessel([1, 2, 3, 4])).toBeCloseTo(5 / 3, 10);
  });
  it("returns 0 for n<=1 (no degrees of freedom)", () => {
    expect(sampleVarianceBessel([])).toBe(0);
    expect(sampleVarianceBessel([42])).toBe(0);
  });
  it("returns 0 for flat series", () => {
    expect(sampleVarianceBessel([3, 3, 3, 3])).toBe(0);
  });
});

describe("timeMeanMatrix", () => {
  it("averages each row", () => {
    expect(
      timeMeanMatrix([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual([2, 5]);
  });
  it("handles empty rows", () => {
    expect(timeMeanMatrix([[], [1, 1]])).toEqual([0, 1]);
  });
});

describe("scalarOlsNoIntercept", () => {
  it("matches worked example from 06-f7-math-study.md (M=2 reduces to 1D)", () => {
    // From worked example:
    //   Λ_bar = [4/3, -2/3, -2/3]   (at M=2, only period 0)
    //   E_norm = [8.0, 1/3, 10.0]
    //   expected β = 3.778 / 2.667 ≈ 1.417
    //   expected residuals ≈ [6.111, 1.278, 10.944]
    const x = [4 / 3, -2 / 3, -2 / 3];
    const y = [8.0, 1 / 3, 10.0];
    const { beta, residuals } = scalarOlsNoIntercept(x, y);
    expect(beta).toBeCloseTo(1.4167, 3);
    expect(residuals[0]).toBeCloseTo(6.111, 2);
    expect(residuals[1]).toBeCloseTo(1.278, 2);
    expect(residuals[2]).toBeCloseTo(10.944, 2);
  });

  it("returns β=0 and y passthrough when Σx² is tiny", () => {
    const x = [0, 0, 0];
    const y = [1, 2, 3];
    const { beta, residuals } = scalarOlsNoIntercept(x, y);
    expect(beta).toBe(0);
    expect(residuals).toEqual([1, 2, 3]);
  });

  it("throws on length mismatch", () => {
    expect(() => scalarOlsNoIntercept([1, 2], [1])).toThrow(/length mismatch/);
  });

  it("residuals sum ≈ 0 for no-intercept symmetric case", () => {
    // Perfect fit: y = 2x exactly
    const x = [1, 2, 3, 4];
    const y = [2, 4, 6, 8];
    const { beta, residuals } = scalarOlsNoIntercept(x, y);
    expect(beta).toBeCloseTo(2, 10);
    residuals.forEach((r) => expect(r).toBeCloseTo(0, 10));
  });
});

describe("correlation", () => {
  it("returns 1 for perfectly positive correlation", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
  });
  it("returns -1 for perfectly negative correlation", () => {
    expect(correlation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });
  it("returns 0 for flat vector", () => {
    expect(correlation([1, 2, 3], [5, 5, 5])).toBe(0);
  });
  it("returns 0 for length < 2", () => {
    expect(correlation([1], [1])).toBe(0);
  });
});

describe("correlationMatrix", () => {
  it("produces N×N symmetric matrix with diag=1", () => {
    const rows = [
      [1, 2, 3, 4],
      [2, 4, 6, 8], // perfectly correlated with row 0
      [4, 3, 2, 1], // negatively correlated with row 0
    ];
    const corr = correlationMatrix(rows);
    expect(corr.length).toBe(3);
    expect(corr[0]!.length).toBe(3);
    expect(corr[0]![0]).toBe(1);
    expect(corr[1]![1]).toBe(1);
    expect(corr[2]![2]).toBe(1);
    expect(corr[0]![1]).toBeCloseTo(1, 10);
    expect(corr[1]![0]).toBeCloseTo(1, 10);
    expect(corr[0]![2]).toBeCloseTo(-1, 10);
    expect(corr[2]![0]).toBeCloseTo(-1, 10);
  });

  it("handles flat rows cleanly (zero correlations)", () => {
    const rows = [
      [1, 2, 3],
      [5, 5, 5], // flat
    ];
    const corr = correlationMatrix(rows);
    expect(corr[0]![1]).toBe(0);
    expect(corr[1]![0]).toBe(0);
  });
});

describe("maxOffDiagonal", () => {
  it("picks the largest absolute value off-diagonal entry", () => {
    const m = [
      [1, 0.3, 0.9],
      [0.3, 1, -0.95],
      [0.9, -0.95, 1],
    ];
    const pair = maxOffDiagonal(m);
    expect(pair).not.toBeNull();
    expect(pair!.i).toBe(1);
    expect(pair!.j).toBe(2);
    expect(pair!.value).toBeCloseTo(-0.95, 10);
  });
  it("returns null for 1×1 or empty", () => {
    expect(maxOffDiagonal([])).toBeNull();
    expect(maxOffDiagonal([[1]])).toBeNull();
  });
  it("ties broken by lower (i,j)", () => {
    const m = [
      [1, 0.5, 0.5],
      [0.5, 1, 0.1],
      [0.5, 0.1, 1],
    ];
    const pair = maxOffDiagonal(m);
    expect(pair).toEqual({ i: 0, j: 1, value: 0.5 });
  });
});

describe("removeIndex", () => {
  it("removes the index and returns a new array", () => {
    const orig = [1, 2, 3, 4];
    const out = removeIndex(orig, 2);
    expect(out).toEqual([1, 2, 4]);
    expect(orig).toEqual([1, 2, 3, 4]); // input unmodified
  });
  it("throws on out-of-bounds", () => {
    expect(() => removeIndex([1, 2], 5)).toThrow(/out of bounds/);
    expect(() => removeIndex([], 0)).toThrow(/out of bounds/);
  });
});

describe("removeRow", () => {
  it("removes a row cleanly", () => {
    const m = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    const out = removeRow(m, 1);
    expect(out).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });
});

describe("clamp", () => {
  it("clamps below lo", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
  });
  it("clamps above hi", () => {
    expect(clamp(2, 0, 1)).toBe(1);
  });
  it("passes through in-range", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
