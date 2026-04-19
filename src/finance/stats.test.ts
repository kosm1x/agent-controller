import { describe, expect, it } from "vitest";
import {
  EULER,
  erf,
  normCdf,
  normInv,
  sampleExcessKurtosis,
  sampleMean,
  sampleSkewness,
  sampleStd,
  sampleVariance,
} from "./stats.js";

describe("normCdf", () => {
  it("Φ(0) = 0.5", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 10);
  });

  it("Φ(1.96) ≈ 0.975", () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 4);
  });

  it("Φ(-1.96) ≈ 0.025", () => {
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it("Φ(3) ≈ 0.99865", () => {
    expect(normCdf(3)).toBeCloseTo(0.99865, 5);
  });

  it("handles ±Infinity", () => {
    expect(normCdf(Infinity)).toBe(1);
    expect(normCdf(-Infinity)).toBe(0);
  });

  it("matches known table values to 1e-6", () => {
    // (x, Φ(x)) reference table
    const refs: Array<[number, number]> = [
      [0.5, 0.691462461],
      [1.0, 0.841344746],
      [2.0, 0.977249868],
      [2.5, 0.993790335],
      [-0.5, 0.308537539],
      [-1.0, 0.158655254],
    ];
    for (const [x, expected] of refs) {
      expect(normCdf(x)).toBeCloseTo(expected, 6);
    }
  });
});

describe("erf", () => {
  it("erf(0) = 0, erf(inf) = 1", () => {
    expect(erf(0)).toBe(0);
    expect(erf(Infinity)).toBe(1);
    expect(erf(-Infinity)).toBe(-1);
  });

  it("erf(1) ≈ 0.8427", () => {
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
  });
});

describe("normInv", () => {
  it("inverse of CDF roundtrips to 1e-6 across tails + center", () => {
    // A&S normCdf has ~7.5e-8 abs error; roundtrip through normInv preserves
    // that level. Loosest tolerance is at p=0.001 (tail).
    const ps = [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999];
    for (const p of ps) {
      const x = normInv(p);
      expect(normCdf(x)).toBeCloseTo(p, 6);
    }
  });

  it("normInv(0.5) = 0", () => {
    expect(normInv(0.5)).toBeCloseTo(0, 10);
  });

  it("normInv(0.975) ≈ 1.95996", () => {
    expect(normInv(0.975)).toBeCloseTo(1.9599639845, 6);
  });

  it("throws outside (0, 1)", () => {
    expect(() => normInv(0)).toThrow();
    expect(() => normInv(1)).toThrow();
    expect(() => normInv(-0.1)).toThrow();
    expect(() => normInv(1.1)).toThrow();
  });
});

describe("sampleMean / sampleVariance / sampleStd", () => {
  it("mean of empty is 0", () => {
    expect(sampleMean([])).toBe(0);
  });

  it("variance of n<2 is 0", () => {
    expect(sampleVariance([])).toBe(0);
    expect(sampleVariance([5])).toBe(0);
  });

  it("variance of [1,2,3,4,5] = 2.5 (Bessel)", () => {
    // mean=3, sum_sq_dev = 4+1+0+1+4 = 10, /(n-1)=4 → 2.5
    expect(sampleVariance([1, 2, 3, 4, 5])).toBeCloseTo(2.5, 12);
    expect(sampleStd([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 12);
  });
});

describe("sampleSkewness", () => {
  it("zero for symmetric sample", () => {
    // [-2,-1,0,1,2] is perfectly symmetric
    expect(sampleSkewness([-2, -1, 0, 1, 2])).toBeCloseTo(0, 10);
  });

  it("positive for right-skewed sample", () => {
    // most mass below mean, few large values on right
    const xs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 10];
    expect(sampleSkewness(xs)).toBeGreaterThan(1);
  });

  it("negative for left-skewed sample", () => {
    const xs = [1, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    expect(sampleSkewness(xs)).toBeLessThan(-1);
  });

  it("zero for n<3", () => {
    expect(sampleSkewness([1, 2])).toBe(0);
    expect(sampleSkewness([])).toBe(0);
  });

  it("G1 formula — hand-verified on right-skewed sample [1,2,3,4,5,6,100]", () => {
    // mean=17.286, m2=1142.74, m3=78477.57, g1=2.031, G1 = 2.031·√42/5 ≈ 2.632
    const xs = [1, 2, 3, 4, 5, 6, 100];
    expect(sampleSkewness(xs)).toBeCloseTo(2.632, 2);
  });
});

describe("sampleExcessKurtosis", () => {
  it("zero for n<4", () => {
    expect(sampleExcessKurtosis([1, 2, 3])).toBe(0);
  });

  it("near zero for ~normal sample (deterministic)", () => {
    // Quasi-normal: standardized normal quantiles for a 101-point grid
    const xs: number[] = [];
    for (let i = 1; i <= 100; i++) {
      xs.push(normInv(i / 101));
    }
    // Excess kurtosis of a normal sample → 0; tolerate ±0.5 for n=100.
    expect(Math.abs(sampleExcessKurtosis(xs))).toBeLessThan(0.5);
  });

  it("strongly positive for heavy-tailed sample", () => {
    // A few large outliers
    const xs = Array.from({ length: 20 }, (_, i) => (i < 18 ? 0 : 20));
    expect(sampleExcessKurtosis(xs)).toBeGreaterThan(5);
  });
});

describe("EULER constant", () => {
  it("equals Euler-Mascheroni constant to 1e-13", () => {
    expect(EULER).toBeCloseTo(0.5772156649015329, 13);
  });
});
