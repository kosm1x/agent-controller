/**
 * Unit tests for the model-swap eval gate verdict math.
 * Pure arithmetic — no LLM, no DB, no I/O.
 */

import { describe, it, expect } from "vitest";
import { compareToBaseline, resolveEpsilon, DEFAULT_EPSILON } from "./gate.js";

describe("compareToBaseline", () => {
  it("PASSes when the candidate exactly matches the incumbent", () => {
    const r = compareToBaseline(63.35, 63.35, 2.0);
    expect(r.verdict).toBe("PASS");
    expect(r.regressed).toBe(false);
    expect(r.delta).toBeCloseTo(0, 10);
    expect(r.threshold).toBeCloseTo(61.35, 10);
  });

  it("PASSes when the candidate beats the incumbent", () => {
    const r = compareToBaseline(70, 63.35, 2.0);
    expect(r.verdict).toBe("PASS");
    expect(r.delta).toBeCloseTo(6.65, 10);
  });

  it("PASSes on a small regression WITHIN tolerance", () => {
    const r = compareToBaseline(62.0, 63.35, 2.0); // down 1.35, tol 2.0
    expect(r.verdict).toBe("PASS");
    expect(r.regressed).toBe(false);
    expect(r.delta).toBeCloseTo(-1.35, 10);
  });

  it("PASSes at the exact threshold (inclusive boundary)", () => {
    const r = compareToBaseline(61.35, 63.35, 2.0); // exactly incumbent - epsilon
    expect(r.verdict).toBe("PASS");
    expect(r.regressed).toBe(false);
    expect(r.overall).toBe(r.threshold);
  });

  it("FAILs just below the threshold", () => {
    const r = compareToBaseline(61.34, 63.35, 2.0);
    expect(r.verdict).toBe("FAIL");
    expect(r.regressed).toBe(true);
  });

  it("FAILs on a gross tool-adherence collapse (Sonnet-5 failure mode)", () => {
    const r = compareToBaseline(48.0, 63.35, 2.0);
    expect(r.verdict).toBe("FAIL");
    expect(r.regressed).toBe(true);
    expect(r.delta).toBeCloseTo(-15.35, 10);
  });

  it("applies DEFAULT_EPSILON when epsilon is omitted", () => {
    const r = compareToBaseline(63.35 - DEFAULT_EPSILON, 63.35);
    expect(r.epsilon).toBe(DEFAULT_EPSILON);
    expect(r.verdict).toBe("PASS"); // exactly on the default threshold
  });

  it("rejects a negative epsilon and falls back to DEFAULT_EPSILON", () => {
    const r = compareToBaseline(62, 63.35, -5);
    expect(r.epsilon).toBe(DEFAULT_EPSILON);
    expect(r.verdict).toBe("PASS");
  });

  it("supports epsilon = 0 (zero tolerance: any regression FAILs)", () => {
    expect(compareToBaseline(63.35, 63.35, 0).verdict).toBe("PASS");
    expect(compareToBaseline(63.34, 63.35, 0).verdict).toBe("FAIL");
  });

  it("throws on non-finite inputs (never silently PASS on NaN)", () => {
    expect(() => compareToBaseline(NaN, 63.35, 2)).toThrow();
    expect(() => compareToBaseline(63, Infinity, 2)).toThrow();
  });
});

describe("resolveEpsilon", () => {
  it("prefers the CLI flag over the file value", () => {
    expect(resolveEpsilon(2.0, 5.0)).toBe(5.0);
  });

  it("falls back to the file value when no flag is given", () => {
    expect(resolveEpsilon(3.5, undefined)).toBe(3.5);
  });

  it("falls back to DEFAULT_EPSILON when neither is valid", () => {
    expect(resolveEpsilon(undefined, undefined)).toBe(DEFAULT_EPSILON);
    expect(resolveEpsilon(-1, NaN)).toBe(DEFAULT_EPSILON);
  });

  it("accepts a zero-tolerance override", () => {
    expect(resolveEpsilon(2.0, 0)).toBe(0);
  });
});
