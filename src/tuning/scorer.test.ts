import { describe, it, expect } from "vitest";
import {
  scoreToolSelection,
  scoreScopeAccuracy,
  scoreClassification,
  computeCompositeScore,
} from "./scorer.js";
import type { CaseScore } from "./types.js";

describe("scoreToolSelection", () => {
  it("scores 1.0 when all expected tools are called", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "user_fact_set"] },
      ["web_search", "user_fact_set"],
    );
    expect(result.score).toBe(1.0);
  });

  it("scores 0.0 when no expected tools are called", () => {
    const result = scoreToolSelection({ tools: ["web_search"] }, [
      "gmail_send",
    ]);
    expect(result.score).toBe(0.0);
  });

  it("multi-tool case is any-hit: half the expected tools called scores 1.0, proportional 0.5 kept in details (2026-10-04)", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "user_fact_set"] },
      ["web_search"],
    );
    expect(result.score).toBe(1.0);
    expect(result.excluded).toBe(false);
    expect(result.details.scoring).toBe("any_hit");
    expect(result.details.proportionalScore).toBe(0.5);
  });

  it("multi-tool case with no expected tool called scores 0 (any-hit and proportional)", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "user_fact_set"] },
      ["gmail_send"],
    );
    expect(result.score).toBe(0);
    expect(result.details.proportionalScore).toBe(0);
  });

  it("single-tool case is unchanged: 1/0, scoring 'single', proportional equals score", () => {
    const hit = scoreToolSelection({ tools: ["web_search"] }, ["web_search"]);
    const miss = scoreToolSelection({ tools: ["web_search"] }, []);
    expect([hit.score, miss.score]).toEqual([1, 0]);
    expect(hit.details.scoring).toBe("single");
    expect(hit.details.proportionalScore).toBe(1);
    expect(miss.details.proportionalScore).toBe(0);
  });

  it("any-hit keeps the forbidden-tool penalty: a hit plus a violation scores 0", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "user_fact_set"], not_tools: ["memory_store"] },
      ["web_search", "memory_store"],
    );
    expect(result.score).toBe(0);
    expect(result.details.violations).toEqual(["memory_store"]);
    // proportional: (1 hit - 2) / 2 → clamped 0
    expect(result.details.proportionalScore).toBe(0);
    expect(result.details.rawPoints).toBe(-1);
  });

  it("scores only OFFERED expected tools: the unreachable one leaves the denominator", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "gmail_send"] },
      ["web_search"],
      new Set(["web_search", "file_read"]),
    );
    // gmail_send was never offered → single offered tool, hit → 1.0
    expect(result.score).toBe(1);
    expect(result.excluded).toBe(false);
    expect(result.details.offered).toEqual(["web_search"]);
    expect(result.details.unreachable).toEqual(["gmail_send"]);
    expect(result.details.maxPoints).toBe(1);
    expect(result.details.scoring).toBe("single");
    expect(result.details.expected).toEqual(["web_search", "gmail_send"]);
  });

  it("a case with expected tools but NONE offered is excluded (score not meaningful)", () => {
    const result = scoreToolSelection(
      { tools: ["gmail_send"], not_tools: ["shell_exec"] },
      [],
      new Set(["web_search"]),
    );
    expect(result.excluded).toBe(true);
    expect(result.details.excluded).toBe(true);
    expect(result.details.offered).toEqual([]);
    expect(result.details.unreachable).toEqual(["gmail_send"]);
  });

  it("expected tools all unreachable but an OFFERED forbidden tool: scored forbidden-only, not excluded", () => {
    const offered = new Set(["web_search", "shell_exec"]);
    const expected = { tools: ["gmail_send"], not_tools: ["shell_exec"] };
    const clean = scoreToolSelection(expected, ["web_search"], offered);
    expect(clean.excluded).toBe(false);
    expect(clean.score).toBe(1);
    expect(clean.details.scoring).toBe("forbidden_only");
    expect(clean.details.offered).toEqual([]);
    expect(clean.details.unreachable).toEqual(["gmail_send"]);
    const violated = scoreToolSelection(expected, ["shell_exec"], offered);
    expect(violated.excluded).toBe(false);
    expect(violated.score).toBe(0);
    expect(violated.details.violations).toEqual(["shell_exec"]);
  });

  it("a forbidden-only case is excluded only when its forbidden tools were not offered either", () => {
    const scored = scoreToolSelection(
      { not_tools: ["shell_exec"] },
      [],
      new Set(["shell_exec"]),
    );
    expect(scored.excluded).toBe(false);
    expect(scored.score).toBe(1);
    expect(scored.details.scoring).toBe("forbidden_only");
    const nothingCheckable = scoreToolSelection(
      { not_tools: ["shell_exec"] },
      [],
      new Set(["web_search"]),
    );
    expect(nothingCheckable.excluded).toBe(true);
  });

  it("ignores first_tools: scored against tools (no round boundaries recorded)", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "file_write"], first_tools: ["web_search"] },
      ["file_write"],
    );
    // any-hit over `tools`: file_write is an expected tool → 1.0
    expect(result.score).toBe(1);
    expect(result.details.expected).toEqual(["web_search", "file_write"]);
    expect(result.details.scoring).toBe("any_hit");
    expect(result.details).not.toHaveProperty("expectedSource");
  });

  it("penalizes forbidden tools that are called", () => {
    const result = scoreToolSelection(
      { tools: ["web_search"], not_tools: ["memory_store"] },
      ["web_search", "memory_store"],
    );
    // 1 hit - 2 violation = -1, max 1, normalized: max(0, -1/1) = 0
    expect(result.score).toBe(0);
    expect(result.details.violations).toContain("memory_store");
  });

  it("scores 1.0 when expected is empty and no forbidden tools called", () => {
    const result = scoreToolSelection(
      { tools: [], not_tools: ["memory_store"] },
      [],
    );
    expect(result.score).toBe(1.0);
  });

  it("scores 0.0 when expected is empty but forbidden tools called", () => {
    const result = scoreToolSelection(
      { tools: [], not_tools: ["memory_store"] },
      ["memory_store"],
    );
    expect(result.score).toBe(0.0);
  });

  it("handles missing expected and not_tools as pass", () => {
    // No expectations at all → vacuous truth, score 1.0
    const result = scoreToolSelection({}, ["web_search"]);
    expect(result.score).toBe(1.0);
  });

  it("tracks hits and misses in details", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "user_fact_set", "calendar_list"] },
      ["web_search", "calendar_list"],
    );
    expect(result.details.hits).toEqual(["web_search", "calendar_list"]);
    expect(result.details.misses).toEqual(["user_fact_set"]);
  });
});

describe("scoreScopeAccuracy", () => {
  it("scores 1.0 when all expected groups are active", () => {
    const result = scoreScopeAccuracy(
      { scope_groups: ["coding", "wordpress"] },
      new Set(["coding", "wordpress", "google"]),
    );
    expect(result.score).toBe(1.0);
  });

  it("scores 0.0 when no expected groups are active", () => {
    const result = scoreScopeAccuracy(
      { scope_groups: ["coding"] },
      new Set(["google"]),
    );
    expect(result.score).toBe(0.0);
  });

  it("handles not_scope_groups correctly", () => {
    const result = scoreScopeAccuracy(
      { scope_groups: [], not_scope_groups: ["coding", "browser"] },
      new Set([]),
    );
    expect(result.score).toBe(1.0); // neither forbidden group is active
  });

  it("penalizes when forbidden groups are active", () => {
    const result = scoreScopeAccuracy(
      { not_scope_groups: ["coding", "browser"] },
      new Set(["coding"]),
    );
    expect(result.score).toBe(0.5); // 1 of 2 checks pass
    expect(result.details.violations).toContain("coding");
  });

  it("scores 1.0 when no checks defined", () => {
    const result = scoreScopeAccuracy({}, new Set(["coding"]));
    expect(result.score).toBe(1.0);
  });
});

describe("scoreClassification", () => {
  it("scores 1.0 on exact match", () => {
    const result = scoreClassification({ agent_type: "fast" }, "fast");
    expect(result.score).toBe(1.0);
  });

  it("scores 0.0 on mismatch", () => {
    const result = scoreClassification({ agent_type: "fast" }, "heavy");
    expect(result.score).toBe(0.0);
  });

  it("defaults expected to fast", () => {
    const result = scoreClassification({}, "fast");
    expect(result.score).toBe(1.0);
  });
});

describe("computeCompositeScore", () => {
  it("computes weighted average across categories", () => {
    const cases: CaseScore[] = [
      { caseId: "ts-1", category: "tool_selection", score: 0.8, details: {} },
      { caseId: "ts-2", category: "tool_selection", score: 0.6, details: {} },
      { caseId: "sc-1", category: "scope_accuracy", score: 1.0, details: {} },
      { caseId: "cl-1", category: "classification", score: 1.0, details: {} },
    ];

    const { compositeScore, subscores } = computeCompositeScore(cases);

    // tool_selection avg: (0.8+0.6)/2 = 0.7 → 70
    // scope avg: 1.0 → 100
    // classification avg: 1.0 → 100
    // composite: 70*0.5 + 100*0.3 + 100*0.2 = 35 + 30 + 20 = 85
    expect(subscores.toolSelection).toBe(70);
    expect(subscores.scopeAccuracy).toBe(100);
    expect(subscores.classification).toBe(100);
    expect(compositeScore).toBe(85);
  });

  it("returns 0 for empty cases", () => {
    const { compositeScore } = computeCompositeScore([]);
    expect(compositeScore).toBe(0);
  });

  it("handles single category", () => {
    const cases: CaseScore[] = [
      { caseId: "sc-1", category: "scope_accuracy", score: 0.5, details: {} },
    ];
    const { compositeScore, subscores } = computeCompositeScore(cases);
    expect(subscores.scopeAccuracy).toBe(50);
    expect(subscores.toolSelection).toBe(0);
    expect(compositeScore).toBe(50 * 0.3); // only scope contributes
  });

  it("uses case weights when provided", () => {
    const cases: CaseScore[] = [
      {
        caseId: "ts-1",
        category: "tool_selection",
        score: 1.0,
        weight: 1.0,
        details: {},
      },
      {
        caseId: "ts-2",
        category: "tool_selection",
        score: 0.0,
        weight: 0.1,
        details: {},
      },
    ];
    const { subscores } = computeCompositeScore(cases);
    // Weighted avg: (1.0*1.0 + 0.0*0.1) / (1.0+0.1) = 0.909... → ~90.9
    expect(subscores.toolSelection).toBeCloseTo(90.9, 0);
  });

  it("defaults weight to 1.0 when not provided", () => {
    const cases: CaseScore[] = [
      { caseId: "ts-1", category: "tool_selection", score: 0.8, details: {} },
      { caseId: "ts-2", category: "tool_selection", score: 0.6, details: {} },
    ];
    const { subscores } = computeCompositeScore(cases);
    // Equal weight: (0.8+0.6)/2 = 0.7 → 70
    expect(subscores.toolSelection).toBe(70);
  });
});
