import { describe, it, expect } from "vitest";
import {
  equalWeight,
  inverseVolatility,
  varianceVector,
} from "./allocators.js";

const sumClose = (w: number[]): number => w.reduce((a, b) => a + b, 0);

describe("equalWeight", () => {
  it("returns N copies of 1/N", () => {
    expect(equalWeight(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
  it("sums to 1.0 exactly for N=1", () => {
    expect(equalWeight(1)).toEqual([1]);
  });
  it("rejects non-positive integer N", () => {
    expect(() => equalWeight(0)).toThrow();
    expect(() => equalWeight(-1)).toThrow();
    expect(() => equalWeight(1.5)).toThrow();
  });
});

describe("varianceVector", () => {
  it("computes Bessel-corrected sample variance per column", () => {
    // Two assets, T=4. Asset 0 = [1,2,3,4] (var = 5/3), Asset 1 = [10,20,30,40] (var = 500/3).
    const ret = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ];
    const v = varianceVector(ret);
    expect(v[0]).toBeCloseTo(5 / 3, 6);
    expect(v[1]).toBeCloseTo(500 / 3, 6);
  });

  it("returns 0 for a flat (constant) column", () => {
    const ret = [
      [1, 5],
      [2, 5],
      [3, 5],
    ];
    expect(varianceVector(ret)[1]).toBe(0);
  });

  it("throws on empty / ragged matrices", () => {
    expect(() => varianceVector([])).toThrow();
    expect(() => varianceVector([[1, 2], [3]])).toThrow();
    expect(() => varianceVector([[]])).toThrow();
  });
});

describe("inverseVolatility", () => {
  it("allocates proportional to 1/sigma — low-vol asset gets more", () => {
    // Asset 0: low vol; Asset 1: high vol.
    const ret = [
      [0.001, 0.1],
      [-0.001, -0.1],
      [0.001, 0.1],
      [-0.001, -0.1],
    ];
    const w = inverseVolatility(ret);
    expect(w[0]).toBeGreaterThan(w[1]);
    expect(sumClose(w)).toBeCloseTo(1, 12);
  });

  it("matches the closed-form 1/sigma share for two uncorrelated assets", () => {
    // Asset 0 has roughly 5x the volatility of Asset 1.
    const ret = [
      [5, 1],
      [-5, -1],
      [5, 1],
      [-5, -1],
    ];
    const w = inverseVolatility(ret);
    // 1/sigma for asset0 = 1/sqrt(var0); same for 1. Ratio = sigma1/sigma0.
    // sigma0/sigma1 = 5 → w0/w1 should be ~ 1/5 → w0 ≈ 0.1667, w1 ≈ 0.8333.
    expect(w[0]).toBeCloseTo(1 / 6, 4);
    expect(w[1]).toBeCloseTo(5 / 6, 4);
  });

  it("returns sum-exactly-1 weights (last-asset absorbs rounding)", () => {
    const ret = [
      [1, 2, 3],
      [-1, -2, -3],
      [1, 2, 3],
      [-1, -2, -3],
    ];
    const w = inverseVolatility(ret);
    expect(w.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("falls back to equal-weight when all assets have zero variance", () => {
    const ret = [
      [5, 5, 5],
      [5, 5, 5],
      [5, 5, 5],
    ];
    expect(inverseVolatility(ret)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("substitutes zero-variance assets with median variance (no NaN, no zero weight)", () => {
    // Asset 0 flat, asset 1 normal vol, asset 2 normal vol.
    const ret = [
      [5, 0.1, 0.1],
      [5, -0.1, -0.1],
      [5, 0.1, 0.1],
      [5, -0.1, -0.1],
    ];
    const w = inverseVolatility(ret);
    // Flat asset gets weight ≈ same as the normal-vol assets (median substitution).
    expect(w[0]).toBeGreaterThan(0);
    expect(Number.isFinite(w[0])).toBe(true);
    expect(sumClose(w)).toBeCloseTo(1, 12);
    // All three should be roughly equal (within 1%).
    for (const wi of w) {
      expect(wi).toBeGreaterThan(0.32);
      expect(wi).toBeLessThan(0.34);
    }
  });

  it("throws on empty input", () => {
    expect(() => inverseVolatility([])).toThrow();
    expect(() => inverseVolatility([[]])).toThrow();
  });
});
