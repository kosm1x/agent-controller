import { describe, it, expect } from "vitest";
import { collectFinalAnswer } from "./final-answer.js";
import type { ExecutionResult, GoalResult } from "./types.js";

function goal(partial: Partial<GoalResult>): GoalResult {
  return {
    goalId: "g",
    ok: true,
    durationMs: 0,
    toolCalls: 0,
    toolNames: [],
    toolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    ...partial,
  };
}

function execResults(goalResults: Record<string, GoalResult>): ExecutionResult {
  return {
    goalResults,
    summary: {},
    totalToolCalls: 0,
    totalToolNames: [],
    totalToolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    toolRepairs: [],
  };
}

describe("collectFinalAnswer", () => {
  it("joins per-goal answers in order — the real agent report, not the reflector summary", () => {
    const out = collectFinalAnswer(
      execResults({
        "g-1": goal({ goalId: "g-1", result: "data retrieved" }),
        "g-2": goal({ goalId: "g-2", result: "EVOLUTION REPORT — patterns…" }),
      }),
    );
    expect(out).toBe("data retrieved\n\nEVOLUTION REPORT — patterns…");
  });

  it("skips goals with no/empty text", () => {
    const out = collectFinalAnswer(
      execResults({
        "g-1": goal({ goalId: "g-1", result: "   " }),
        "g-2": goal({ goalId: "g-2", result: "the report" }),
        "g-3": goal({ goalId: "g-3" }), // no result field
      }),
    );
    expect(out).toBe("the report");
  });

  it("returns null when no goal produced text (avoids storing junk)", () => {
    expect(
      collectFinalAnswer(execResults({ "g-1": goal({ result: undefined }) })),
    ).toBeNull();
    expect(collectFinalAnswer(execResults({}))).toBeNull();
  });
});
