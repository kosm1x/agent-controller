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

  it("scores 0.5 when half the expected tools are called", () => {
    const result = scoreToolSelection(
      { tools: ["web_search", "user_fact_set"] },
      ["web_search"],
    );
    expect(result.score).toBe(0.5);
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
});
