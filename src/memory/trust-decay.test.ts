/**
 * Trust tier decay scoring tests.
 *
 * Validates the exponential decay model:
 * - T1 (verified): 365d half-life, base weight 1.0
 * - T2 (inferred): 180d half-life, base weight 0.8
 * - T3 (provisional): 90d half-life, base weight 0.6
 * - T4 (unverified): 30d half-life, base weight 0.4
 */

import { describe, it, expect } from "vitest";
import { computeDecayWeight } from "./sqlite-backend.js";

describe("computeDecayWeight", () => {
  it("returns base weight for age=0", () => {
    expect(computeDecayWeight(1, 0)).toBeCloseTo(1.0);
    expect(computeDecayWeight(2, 0)).toBeCloseTo(0.8);
    expect(computeDecayWeight(3, 0)).toBeCloseTo(0.6);
    expect(computeDecayWeight(4, 0)).toBeCloseTo(0.4);
  });

  it("returns half base weight at the half-life", () => {
    expect(computeDecayWeight(1, 365)).toBeCloseTo(0.5);
    expect(computeDecayWeight(2, 180)).toBeCloseTo(0.4);
    expect(computeDecayWeight(3, 90)).toBeCloseTo(0.3);
    expect(computeDecayWeight(4, 30)).toBeCloseTo(0.2);
  });

  it("T1 memory at 30 days barely decays", () => {
    const weight = computeDecayWeight(1, 30);
    // 30/365 ≈ 0.082, so decay ≈ 0.5^0.082 ≈ 0.944
    expect(weight).toBeGreaterThan(0.9);
  });

  it("T4 memory at 30 days loses half its weight", () => {
    const weight = computeDecayWeight(4, 30);
    expect(weight).toBeCloseTo(0.2); // 0.4 * 0.5
  });

  it("T4 memory at 90 days is nearly worthless", () => {
    const weight = computeDecayWeight(4, 90);
    // 0.4 * 0.5^3 = 0.05
    expect(weight).toBeCloseTo(0.05);
  });

  it("verified memories always outrank provisional at same age", () => {
    for (const days of [0, 30, 60, 90, 180, 365]) {
      const t1 = computeDecayWeight(1, days);
      const t3 = computeDecayWeight(3, days);
      expect(t1).toBeGreaterThan(t3);
    }
  });

  it("old verified beats recent unverified", () => {
    const oldVerified = computeDecayWeight(1, 300);
    const recentUnverified = computeDecayWeight(4, 5);
    expect(oldVerified).toBeGreaterThan(recentUnverified);
  });
});
