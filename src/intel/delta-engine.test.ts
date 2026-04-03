/**
 * Delta engine tests — severity classification and delta computation.
 */

import { describe, it, expect } from "vitest";
import { classifySeverity, computeDelta, METRICS } from "./delta-engine.js";

describe("classifySeverity", () => {
  it("returns critical for ratio > 3.0", () => {
    expect(classifySeverity(3.5)).toBe("critical");
    expect(classifySeverity(10)).toBe("critical");
  });

  it("returns high for ratio > 2.0", () => {
    expect(classifySeverity(2.5)).toBe("high");
    expect(classifySeverity(2.01)).toBe("high");
  });

  it("returns moderate for ratio > 1.0", () => {
    expect(classifySeverity(1.5)).toBe("moderate");
    expect(classifySeverity(1.01)).toBe("moderate");
  });

  it("returns normal for ratio <= 1.0", () => {
    expect(classifySeverity(1.0)).toBe("normal");
    expect(classifySeverity(0.5)).toBe("normal");
    expect(classifySeverity(0)).toBe("normal");
  });
});

describe("computeDelta", () => {
  it("returns normal for first observation (no previous)", () => {
    const delta = computeDelta("usgs", "quakes_5plus", 3, null);
    expect(delta).not.toBeNull();
    expect(delta!.severity).toBe("normal");
    expect(delta!.changeRatio).toBe(0);
    expect(delta!.previous).toBeNull();
  });

  it("returns null for unknown source+key (no metric)", () => {
    const delta = computeDelta("unknown_source", "unknown_key", 42, 10);
    expect(delta).toBeNull();
  });

  it("computes correct severity for count metric", () => {
    // usgs quakes_5plus: threshold = 2 (count)
    // previous=1, current=8 → abs change=7, ratio=7/2=3.5 → critical
    const delta = computeDelta("usgs", "quakes_5plus", 8, 1);
    expect(delta).not.toBeNull();
    expect(delta!.severity).toBe("critical");
    expect(delta!.changeRatio).toBe(3.5);
  });

  it("computes correct severity for numeric metric", () => {
    // frankfurter MXN: threshold = 2% (numeric)
    // previous=17.0, current=17.85 → pct change = 5% → ratio = 5/2 = 2.5 → high
    const delta = computeDelta("frankfurter", "MXN", 17.85, 17.0);
    expect(delta).not.toBeNull();
    expect(delta!.severity).toBe("high");
    expect(delta!.changeRatio).toBe(2.5);
  });

  it("returns normal for small change", () => {
    // frankfurter MXN: threshold = 2%
    // previous=17.0, current=17.1 → pct change ≈ 0.59% → ratio ≈ 0.29 → normal
    const delta = computeDelta("frankfurter", "MXN", 17.1, 17.0);
    expect(delta).not.toBeNull();
    expect(delta!.severity).toBe("normal");
    expect(delta!.changeRatio).toBeLessThan(1);
  });

  it("handles previous=0 for numeric metrics", () => {
    // When previous is 0, use threshold as fallback ratio
    const delta = computeDelta("frankfurter", "MXN", 17.0, 0);
    expect(delta).not.toBeNull();
    expect(delta!.severity).not.toBe("normal"); // threshold itself is the ratio
  });

  it("handles current=previous (no change)", () => {
    const delta = computeDelta("usgs", "quakes_5plus", 3, 3);
    expect(delta).not.toBeNull();
    expect(delta!.changeRatio).toBe(0);
    expect(delta!.severity).toBe("normal");
  });
});

describe("METRICS", () => {
  it("has expected number of metric definitions", () => {
    expect(METRICS.length).toBeGreaterThanOrEqual(15);
  });

  it("has required fields for all metrics", () => {
    for (const m of METRICS) {
      expect(m.source).toBeTruthy();
      expect(m.key).toBeTruthy();
      expect(["numeric", "count"]).toContain(m.type);
      expect(m.threshold).toBeGreaterThan(0);
      expect(typeof m.riskSensitive).toBe("boolean");
    }
  });

  it("includes the 5 S6 adapter sources", () => {
    const sources = new Set(METRICS.map((m) => m.source));
    expect(sources.has("usgs")).toBe(true);
    expect(sources.has("nws")).toBe(true);
    expect(sources.has("gdelt")).toBe(true);
    expect(sources.has("frankfurter")).toBe(true);
    expect(sources.has("cisa_kev")).toBe(true);
  });
});
