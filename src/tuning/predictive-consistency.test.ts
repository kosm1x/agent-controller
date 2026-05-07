import { describe, it, expect, vi } from "vitest";
import {
  runPredictiveCheck,
  sampleProbeCases,
  isPredictiveConsistencyEnabled,
} from "./predictive-consistency.js";
import type { CaseScore, Mutation, TestCase } from "./types.js";

const mut = (hypothesis: string): Mutation => ({
  surface: "tool_description",
  target: "web_search",
  mutation_type: "rewrite",
  hypothesis,
  mutated_value: "x",
});

const tc = (id: string, message: string): TestCase => ({
  case_id: id,
  category: "tool_selection",
  input: { message },
  expected: {},
  weight: 1,
  source: "manual",
  active: true,
});

const cs = (caseId: string, score: number): CaseScore => ({
  caseId,
  category: "tool_selection",
  score,
  details: {},
});

describe("sampleProbeCases", () => {
  it("returns only cases that intersect the affected set", () => {
    const out = sampleProbeCases(
      ["a", "b"],
      [tc("a", "ma"), tc("b", "mb"), tc("c", "mc")],
      3,
    );
    expect(out.map((c) => c.case_id)).toEqual(["a", "b"]);
  });

  it("caps at the requested count, preferring lexicographic case_id order (stable)", () => {
    const out = sampleProbeCases(
      ["zz", "aa", "mm"],
      [tc("zz", "x"), tc("aa", "x"), tc("mm", "x")],
      2,
    );
    expect(out.map((c) => c.case_id)).toEqual(["aa", "mm"]);
  });

  it("returns empty when cap is 0", () => {
    const out = sampleProbeCases(["a"], [tc("a", "x")], 0);
    expect(out).toEqual([]);
  });

  it("returns empty when no affected cases match the catalog", () => {
    const out = sampleProbeCases(["x"], [tc("a", "ma")], 3);
    expect(out).toEqual([]);
  });
});

describe("runPredictiveCheck", () => {
  const cases = [
    tc("c1", "search for foo"),
    tc("c2", "search for bar"),
    tc("c3", "search for baz"),
  ];

  it("passes when predictions align with the actual outcomes (>= threshold)", async () => {
    // Actual: c1 pass, c2 pass, c3 fail
    const perCase = [cs("c1", 0.9), cs("c2", 0.8), cs("c3", 0.2)];
    const inferFn = vi.fn(async (_h: string, msg: string) => ({
      // Predict pass for any non-baz message. Matches actual.
      predictedPass: !msg.includes("baz"),
      tokensUsed: 10,
    }));

    const r = await runPredictiveCheck(
      mut("widening recall improves on baz-style queries"),
      ["c1", "c2", "c3"],
      cases,
      perCase,
      inferFn,
    );

    expect(r.passed).toBe(true);
    expect(r.correct).toBe(3);
    expect(r.total).toBe(3);
    expect(r.tokensUsed).toBe(30);
    expect(r.reason).toBeUndefined();
  });

  it("rejects when predictions don't beat the threshold", async () => {
    const perCase = [cs("c1", 0.9), cs("c2", 0.8), cs("c3", 0.2)];
    // Always predict pass — 2/3 correct = 0.66 by accident
    // Use always-fail to get 1/3 correct → below 0.5 threshold
    const inferFn = vi.fn(async () => ({
      predictedPass: false,
      tokensUsed: 10,
    }));

    const r = await runPredictiveCheck(
      mut("hypothesis is gibberish"),
      ["c1", "c2", "c3"],
      cases,
      perCase,
      inferFn,
    );

    expect(r.passed).toBe(false);
    expect(r.correct).toBe(1); // only c3 actually fails
    expect(r.total).toBe(3);
    expect(r.reason).toMatch(/predicted 1\/3/);
  });

  it("returns passed=false with reason when no probe cases exist", async () => {
    const inferFn = vi.fn();
    const r = await runPredictiveCheck(
      mut("h"),
      [], // no affected cases
      cases,
      [],
      inferFn,
    );
    expect(r.passed).toBe(false);
    expect(r.total).toBe(0);
    expect(r.reason).toMatch(/no probe cases/);
    expect(inferFn).not.toHaveBeenCalled();
  });

  it("skips probe cases that have no eval score (no fabrication)", async () => {
    // c2 is missing from perCase
    const perCase = [cs("c1", 0.9), cs("c3", 0.2)];
    const inferFn = vi.fn(async () => ({ predictedPass: true, tokensUsed: 5 }));

    await runPredictiveCheck(
      mut("h"),
      ["c1", "c2", "c3"],
      cases,
      perCase,
      inferFn,
      { threshold: 0.0 }, // lenient — just want to check call count
    );

    // c2 should be skipped (no actualScore), so only c1 + c3 probed.
    expect(inferFn).toHaveBeenCalledTimes(2);
  });

  it("respects the configurable threshold", async () => {
    const perCase = [cs("c1", 0.9), cs("c2", 0.8), cs("c3", 0.9)];
    // Predict pass for c1, fail for the others — 1/3 correct
    const inferFn = vi.fn(async (_h: string, msg: string) => ({
      predictedPass: msg.includes("foo"),
      tokensUsed: 10,
    }));

    const lenient = await runPredictiveCheck(
      mut("h"),
      ["c1", "c2", "c3"],
      cases,
      perCase,
      inferFn,
      { threshold: 0.3 },
    );
    expect(lenient.passed).toBe(true); // 0.33 >= 0.3

    inferFn.mockClear();
    const strict = await runPredictiveCheck(
      mut("h"),
      ["c1", "c2", "c3"],
      cases,
      perCase,
      inferFn,
      { threshold: 0.9 },
    );
    expect(strict.passed).toBe(false);
  });

  it("caps probes at MAX_PROBE_CASES (3) regardless of caller-requested count", async () => {
    const many = Array.from({ length: 10 }, (_, i) => tc(`c${i}`, `m${i}`));
    const ids = many.map((c) => c.case_id);
    const perCase = many.map((c) => cs(c.case_id, 1.0));
    const inferFn = vi.fn(async () => ({ predictedPass: true, tokensUsed: 1 }));

    const r = await runPredictiveCheck(
      mut("h"),
      ids,
      many,
      perCase,
      inferFn,
      { maxProbes: 100 }, // ask for more than allowed
    );
    // Hard cap of 3 should still apply
    expect(r.total).toBe(3);
    expect(inferFn).toHaveBeenCalledTimes(3);
  });
});

describe("isPredictiveConsistencyEnabled", () => {
  it("returns false by default", () => {
    delete process.env.TUNING_PREDICTIVE_CONSISTENCY;
    expect(isPredictiveConsistencyEnabled()).toBe(false);
  });

  it("returns true only for the literal 'true' string", () => {
    process.env.TUNING_PREDICTIVE_CONSISTENCY = "true";
    expect(isPredictiveConsistencyEnabled()).toBe(true);

    process.env.TUNING_PREDICTIVE_CONSISTENCY = "1";
    expect(isPredictiveConsistencyEnabled()).toBe(false);

    process.env.TUNING_PREDICTIVE_CONSISTENCY = "TRUE";
    expect(isPredictiveConsistencyEnabled()).toBe(false);

    delete process.env.TUNING_PREDICTIVE_CONSISTENCY;
  });
});
