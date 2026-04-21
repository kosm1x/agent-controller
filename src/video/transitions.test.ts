import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TRANSITION_NAMES,
  resolveTransition,
  isTransitionName,
  type TransitionName,
} from "./transitions.js";

const NATIVE_TRANSITIONS: TransitionName[] = [
  "fade",
  "wipeleft",
  "wiperight",
  "circleopen",
  "circlecrop",
  "pixelize",
  "dissolve",
  "radial",
];

const FALLBACK_TRANSITIONS: TransitionName[] = [
  "domain-warp",
  "ridged-burn",
  "gravitational-lens",
  "chromatic-radial-split",
  "sdf-iris",
  "rgb-displacement",
];

describe("TRANSITION_NAMES", () => {
  it("contains exactly 14 names", () => {
    expect(TRANSITION_NAMES.length).toBe(14);
  });

  it("has no duplicates", () => {
    const set = new Set(TRANSITION_NAMES);
    expect(set.size).toBe(TRANSITION_NAMES.length);
  });
});

describe("resolveTransition — native transitions", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  for (const name of NATIVE_TRANSITIONS) {
    it(`${name} resolves to native xfade`, () => {
      const spec = resolveTransition(name, 1.0, 5.0);
      expect(spec.native).toBe(true);
      expect(spec.filterExpr).toMatch(
        /^xfade=transition=\w+:duration=1\.000:offset=5\.000$/,
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });
  }
});

describe("resolveTransition — fallback transitions", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  for (const name of FALLBACK_TRANSITIONS) {
    it(`${name} falls back to dissolve and warns`, () => {
      const spec = resolveTransition(name, 1.0, 5.0);
      expect(spec.native).toBe(false);
      expect(spec.xfadeName).toBe("dissolve");
      expect(spec.filterExpr).toMatch(/transition=dissolve/);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/v7\.4\.4/);
    });
  }
});

describe("resolveTransition — validation", () => {
  it("rejects unknown transition name", () => {
    expect(() =>
      resolveTransition("not-a-real-transition" as TransitionName, 1, 0),
    ).toThrow(/unknown transition name/);
  });

  it("rejects zero or negative duration", () => {
    expect(() => resolveTransition("fade", 0, 0)).toThrow(
      /durationSec must be positive/,
    );
    expect(() => resolveTransition("fade", -1, 0)).toThrow(
      /durationSec must be positive/,
    );
  });

  it("rejects negative offset", () => {
    expect(() => resolveTransition("fade", 1, -0.001)).toThrow(
      /offsetSec must be non-negative/,
    );
  });

  it("rejects NaN / Infinity duration or offset", () => {
    expect(() => resolveTransition("fade", NaN, 0)).toThrow();
    expect(() => resolveTransition("fade", Infinity, 0)).toThrow();
    expect(() => resolveTransition("fade", 1, NaN)).toThrow();
    expect(() => resolveTransition("fade", 1, Infinity)).toThrow();
  });

  it("rejects shell-injection attempt as unknown name (schema layer defense)", () => {
    expect(() =>
      resolveTransition("'; rm -rf /" as TransitionName, 1, 0),
    ).toThrow(/unknown transition name/);
  });
});

describe("isTransitionName", () => {
  it("returns true for known names", () => {
    expect(isTransitionName("fade")).toBe(true);
    expect(isTransitionName("domain-warp")).toBe(true);
  });
  it("returns false for unknown or non-string", () => {
    expect(isTransitionName("nope")).toBe(false);
    expect(isTransitionName(42)).toBe(false);
    expect(isTransitionName(null)).toBe(false);
    expect(isTransitionName(undefined)).toBe(false);
  });
});
