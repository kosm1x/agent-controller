import { describe, it, expect } from "vitest";
import {
  quantizeTimeToFrame,
  formatFrameTime,
  timeToFrameIndex,
} from "./frame-clock.js";

describe("quantizeTimeToFrame", () => {
  it("returns 0 for t=0 at any fps", () => {
    expect(quantizeTimeToFrame(0, 24)).toBe(0);
    expect(quantizeTimeToFrame(0, 30)).toBe(0);
    expect(quantizeTimeToFrame(0, 60)).toBe(0);
  });

  it("rounds negative time to 0", () => {
    expect(quantizeTimeToFrame(-1, 24)).toBe(0);
    expect(quantizeTimeToFrame(-0.0001, 30)).toBe(0);
  });

  it("quantizes exact frame boundaries unchanged", () => {
    // at fps=24, 1/24 = 0.04166...
    expect(quantizeTimeToFrame(1 / 24, 24)).toBeCloseTo(1 / 24, 10);
    expect(quantizeTimeToFrame(0.5, 30)).toBeCloseTo(0.5, 10);
    expect(quantizeTimeToFrame(1.0, 60)).toBe(1.0);
  });

  it("snaps between-frame values to nearest frame", () => {
    // at fps=24: frame 0 = 0s, frame 1 = 0.04167s, midpoint = 0.02083
    // below midpoint → frame 0; above → frame 1
    expect(quantizeTimeToFrame(0.01, 24)).toBe(0);
    expect(quantizeTimeToFrame(0.03, 24)).toBeCloseTo(1 / 24, 10);
  });

  it("is stable for identical inputs (determinism)", () => {
    const a = quantizeTimeToFrame(3.14159, 30);
    const b = quantizeTimeToFrame(3.14159, 30);
    expect(a).toBe(b);
  });

  it("throws on NaN t", () => {
    expect(() => quantizeTimeToFrame(NaN, 24)).toThrow(/not finite/);
  });

  it("throws on Infinity t", () => {
    expect(() => quantizeTimeToFrame(Infinity, 24)).toThrow(/not finite/);
    expect(() => quantizeTimeToFrame(-Infinity, 24)).toThrow(/not finite/);
  });

  it("throws on out-of-range fps", () => {
    expect(() => quantizeTimeToFrame(1, 0)).toThrow(/fps out of range/);
    expect(() => quantizeTimeToFrame(1, -5)).toThrow(/fps out of range/);
    expect(() => quantizeTimeToFrame(1, 500)).toThrow(/fps out of range/);
  });
});

describe("formatFrameTime", () => {
  it("emits 6-decimal precision", () => {
    expect(formatFrameTime(1, 24)).toBe("1.000000");
    expect(formatFrameTime(1 / 24, 24)).toMatch(/^0\.04166[67]$/);
  });

  it("is deterministic for repeated calls", () => {
    expect(formatFrameTime(2.5, 30)).toBe(formatFrameTime(2.5, 30));
  });
});

describe("timeToFrameIndex", () => {
  it("returns 0 for t=0 or negative", () => {
    expect(timeToFrameIndex(0, 24)).toBe(0);
    expect(timeToFrameIndex(-1, 24)).toBe(0);
  });

  it("returns correct frame index at boundaries", () => {
    expect(timeToFrameIndex(1, 24)).toBe(24);
    expect(timeToFrameIndex(1, 30)).toBe(30);
    expect(timeToFrameIndex(2.5, 60)).toBe(150);
  });
});
