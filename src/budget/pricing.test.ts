/**
 * Model pricing tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { calculateCost, getPricing, loadPricingOverride } from "./pricing.js";

describe("pricing", () => {
  describe("getPricing", () => {
    it("should return exact match for known model", () => {
      const p = getPricing("qwen3.5-plus");
      expect(p.promptCostPer1k).toBe(0.0008);
      expect(p.completionCostPer1k).toBe(0.002);
    });

    it("should match prefix for model variants", () => {
      const p = getPricing("deepseek-v3.2-0624");
      expect(p.promptCostPer1k).toBe(0.0014);
    });

    it("should return fallback for unknown model", () => {
      const p = getPricing("totally-unknown-model");
      expect(p.promptCostPer1k).toBe(0.001);
      expect(p.completionCostPer1k).toBe(0.003);
    });
  });

  describe("loadPricingOverride", () => {
    beforeEach(() => {
      // Reset overrides by loading empty
      loadPricingOverride("{}");
    });

    it("should override pricing for specific model", () => {
      loadPricingOverride(
        JSON.stringify({
          "custom-model": { promptCostPer1k: 0.01, completionCostPer1k: 0.02 },
        }),
      );

      const p = getPricing("custom-model");
      expect(p.promptCostPer1k).toBe(0.01);
      expect(p.completionCostPer1k).toBe(0.02);
    });

    it("should fall back to defaults if override parse fails", () => {
      loadPricingOverride("not valid json{{{");
      const p = getPricing("qwen3.5-plus");
      expect(p.promptCostPer1k).toBe(0.0008);
    });
  });

  describe("calculateCost", () => {
    it("should calculate correct cost for known model", () => {
      // 10,000 prompt tokens at $0.0008/1k = $0.008
      // 2,000 completion tokens at $0.002/1k = $0.004
      const cost = calculateCost("qwen3.5-plus", 10_000, 2_000);
      expect(cost).toBeCloseTo(0.012, 6);
    });

    it("should return 0 for zero tokens", () => {
      expect(calculateCost("qwen3.5-plus", 0, 0)).toBe(0);
    });

    it("should use fallback pricing for unknown model", () => {
      // 1,000 prompt at $0.001/1k = $0.001
      // 1,000 completion at $0.003/1k = $0.003
      const cost = calculateCost("unknown-model", 1_000, 1_000);
      expect(cost).toBeCloseTo(0.004, 6);
    });
  });
});
