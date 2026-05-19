/**
 * v7.7 Spine 2 — tolerance evaluator tests.
 *
 * Pure tests; no DB, no LLM. Covers all 5 tolerance kinds with positive
 * AND negative cases, plus the defensive paths (undefined observed, no
 * baseline, malformed inputs).
 */

import { describe, it, expect } from "vitest";
import { evaluateTolerance, type ToleranceRule } from "./tolerance.js";

describe("evaluateTolerance — absolute_threshold", () => {
  it("gt: trips when observed > value", () => {
    const r = evaluateTolerance(
      100,
      {},
      { kind: "absolute_threshold", op: "gt", value: 50 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("above");
  });

  it("gt: does NOT trip when observed === value", () => {
    const r = evaluateTolerance(
      50,
      {},
      { kind: "absolute_threshold", op: "gt", value: 50 },
    );
    expect(r.tripped).toBe(false);
  });

  it("lt: trips when observed < value", () => {
    const r = evaluateTolerance(
      30,
      {},
      { kind: "absolute_threshold", op: "lt", value: 50 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("below");
  });

  it("gte / lte: inclusive at boundary", () => {
    expect(
      evaluateTolerance(
        50,
        {},
        { kind: "absolute_threshold", op: "gte", value: 50 },
      ).tripped,
    ).toBe(true);
    expect(
      evaluateTolerance(
        50,
        {},
        { kind: "absolute_threshold", op: "lte", value: 50 },
      ).tripped,
    ).toBe(true);
  });

  it("eq: trips when observed === value (changed deviation)", () => {
    const r = evaluateTolerance(
      0,
      {},
      { kind: "absolute_threshold", op: "eq", value: 0 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("changed");
  });

  it("neq: trips when observed !== value", () => {
    const r = evaluateTolerance(
      1,
      {},
      { kind: "absolute_threshold", op: "neq", value: 0 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("above");
  });

  it("does NOT trip on undefined / null observed", () => {
    const rule: ToleranceRule = {
      kind: "absolute_threshold",
      op: "gt",
      value: 0,
    };
    expect(evaluateTolerance(undefined, {}, rule).tripped).toBe(false);
    expect(evaluateTolerance(null, {}, rule).tripped).toBe(false);
  });

  it("does NOT trip on NaN observed", () => {
    expect(
      evaluateTolerance(
        Number.NaN,
        {},
        { kind: "absolute_threshold", op: "gt", value: 0 },
      ).tripped,
    ).toBe(false);
  });
});

describe("evaluateTolerance — pct_drift_from_baseline", () => {
  it("trips when observed deviates by ≥ pct", () => {
    const r = evaluateTolerance(
      130,
      { value: 100 },
      { kind: "pct_drift_from_baseline", pct: 0.3 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("above");
  });

  it("does NOT trip when within tolerance band", () => {
    expect(
      evaluateTolerance(
        129,
        { value: 100 },
        { kind: "pct_drift_from_baseline", pct: 0.3 },
      ).tripped,
    ).toBe(false);
  });

  it("trips below baseline (below deviation)", () => {
    const r = evaluateTolerance(
      60,
      { value: 100 },
      { kind: "pct_drift_from_baseline", pct: 0.3 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("below");
  });

  it("does NOT trip on zero baseline (avoids divide-by-zero)", () => {
    expect(
      evaluateTolerance(
        100,
        { value: 0 },
        { kind: "pct_drift_from_baseline", pct: 0.3 },
      ).tripped,
    ).toBe(false);
  });

  it("does NOT trip on missing baseline value", () => {
    expect(
      evaluateTolerance(100, {}, { kind: "pct_drift_from_baseline", pct: 0.3 })
        .tripped,
    ).toBe(false);
  });
});

describe("evaluateTolerance — enum_match", () => {
  it("passes when observed in expected[]", () => {
    expect(
      evaluateTolerance(
        "claude-sdk",
        {},
        { kind: "enum_match", expected: ["claude-sdk", "openai"] },
      ).tripped,
    ).toBe(false);
  });

  it("trips when observed NOT in expected[]", () => {
    const r = evaluateTolerance(
      "qwen3.6-plus",
      {},
      { kind: "enum_match", expected: ["claude-sdk"] },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("changed");
  });

  it("treats null / empty as no-trip (no observation yet)", () => {
    expect(
      evaluateTolerance(null, {}, { kind: "enum_match", expected: ["x"] })
        .tripped,
    ).toBe(false);
    expect(
      evaluateTolerance("", {}, { kind: "enum_match", expected: ["x"] })
        .tripped,
    ).toBe(false);
  });
});

describe("evaluateTolerance — absent", () => {
  it("trips when last-seen is older than window", () => {
    const oldMs = Date.now() - 10 * 60_000; // 10 min ago
    const r = evaluateTolerance(
      oldMs,
      {},
      { kind: "absent", window_minutes: 5 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("absent");
  });

  it("does NOT trip when last-seen within window", () => {
    const recentMs = Date.now() - 60_000; // 1 min ago
    expect(
      evaluateTolerance(recentMs, {}, { kind: "absent", window_minutes: 5 })
        .tripped,
    ).toBe(false);
  });

  it("accepts ISO datetime observed", () => {
    const oldIso = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(
      evaluateTolerance(oldIso, {}, { kind: "absent", window_minutes: 5 })
        .tripped,
    ).toBe(true);
  });

  it("falls back to baseline.last_seen_at when observed is null", () => {
    const oldIso = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(
      evaluateTolerance(
        null,
        { last_seen_at: oldIso },
        { kind: "absent", window_minutes: 5 },
      ).tripped,
    ).toBe(true);
  });

  it("does NOT trip when no last-seen available anywhere", () => {
    expect(
      evaluateTolerance(null, {}, { kind: "absent", window_minutes: 5 })
        .tripped,
    ).toBe(false);
  });
});

describe("evaluateTolerance — window_breach", () => {
  it("trips when below min", () => {
    const r = evaluateTolerance(
      5,
      {},
      { kind: "window_breach", min: 10, max: 100 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("below");
  });

  it("trips when above max", () => {
    const r = evaluateTolerance(
      150,
      {},
      { kind: "window_breach", min: 10, max: 100 },
    );
    expect(r.tripped).toBe(true);
    expect(r.deviationKind).toBe("above");
  });

  it("does NOT trip when within range", () => {
    expect(
      evaluateTolerance(50, {}, { kind: "window_breach", min: 10, max: 100 })
        .tripped,
    ).toBe(false);
  });

  it("min-only: ignores max boundary", () => {
    expect(
      evaluateTolerance(1000, {}, { kind: "window_breach", min: 10 }).tripped,
    ).toBe(false);
    expect(
      evaluateTolerance(5, {}, { kind: "window_breach", min: 10 }).tripped,
    ).toBe(true);
  });
});

describe("evaluateTolerance — detail messages", () => {
  it("absolute_threshold detail includes observed + op + value", () => {
    const r = evaluateTolerance(
      100,
      {},
      { kind: "absolute_threshold", op: "gt", value: 50 },
    );
    expect(r.detail).toMatch(/100.*gt.*50/);
  });

  it("pct_drift detail includes drift percentage and baseline", () => {
    const r = evaluateTolerance(
      130,
      { value: 100 },
      { kind: "pct_drift_from_baseline", pct: 0.3 },
    );
    expect(r.detail).toMatch(/30.0%/);
    expect(r.detail).toMatch(/100/);
  });
});
