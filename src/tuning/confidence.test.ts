import { describe, it, expect } from "vitest";
import { computeConfidenceProxy } from "./confidence.js";
import type { CaseScore } from "./types.js";

function mk(score: number, id = "c"): CaseScore {
  return { caseId: id, category: "tool_selection", score, details: {} };
}

describe("computeConfidenceProxy", () => {
  it("returns 1.0 for empty input", () => {
    expect(computeConfidenceProxy([])).toBe(1.0);
  });

  it("returns 1.0 for single-case input", () => {
    expect(computeConfidenceProxy([mk(0.5)])).toBe(1.0);
  });

  it("returns 1.0 for fully consistent scores", () => {
    expect(computeConfidenceProxy([mk(1.0), mk(1.0), mk(1.0)])).toBe(1.0);
    expect(computeConfidenceProxy([mk(0.5), mk(0.5)])).toBe(1.0);
  });

  it("returns 0.0 for maximum variance (half 0s half 1s)", () => {
    expect(computeConfidenceProxy([mk(1.0), mk(0.0)])).toBe(0.0);
  });

  it("returns intermediate value for moderate spread", () => {
    const conf = computeConfidenceProxy([mk(0.8), mk(0.4)]);
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThan(1);
  });

  it("is monotonically non-increasing as variance grows", () => {
    const tight = computeConfidenceProxy([mk(0.5), mk(0.6)]);
    const spread = computeConfidenceProxy([mk(0.2), mk(0.9)]);
    expect(tight).toBeGreaterThan(spread);
  });
});
