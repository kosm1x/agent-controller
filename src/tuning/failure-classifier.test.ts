import { describe, it, expect } from "vitest";
import { classifyFailureSource } from "./failure-classifier.js";
import type { Mutation, CaseScore } from "./types.js";

const baseMutation: Mutation = {
  surface: "tool_description",
  target: "web_search",
  mutation_type: "rewrite",
  mutated_value: "Search the web for current information.",
  hypothesis: "Clarify when this tool is appropriate.",
};

function mkCase(
  overrides: Partial<CaseScore> & { caseId: string; category: string },
): CaseScore {
  return {
    score: 1.0,
    details: {},
    ...overrides,
    category: overrides.category as CaseScore["category"],
  };
}

describe("classifyFailureSource", () => {
  it("returns null on passed experiments", () => {
    expect(
      classifyFailureSource({
        status: "passed",
        mutation: baseMutation,
        perCase: [],
      }),
    ).toBeNull();
  });

  // R1 W8: pending is a transient state — never classify
  it("returns null on pending experiments", () => {
    expect(
      classifyFailureSource({
        status: "pending",
        mutation: baseMutation,
      }),
    ).toBeNull();
  });

  it("classifies rejected gate failures as skill", () => {
    expect(
      classifyFailureSource({
        status: "rejected",
        mutation: baseMutation,
      }),
    ).toBe("skill");
  });

  it("classifies timeout errors as env", () => {
    expect(
      classifyFailureSource({
        status: "error",
        mutation: baseMutation,
        errorMessage: "Experiment timeout (10min)",
      }),
    ).toBe("env");
  });

  it("classifies rate-limit errors as env", () => {
    expect(
      classifyFailureSource({
        status: "error",
        mutation: baseMutation,
        errorMessage: "HTTP 429 rate limit exceeded",
      }),
    ).toBe("env");
  });

  it("classifies ECONNRESET as env", () => {
    expect(
      classifyFailureSource({
        status: "error",
        mutation: baseMutation,
        errorMessage: "fetch failed: ECONNRESET",
      }),
    ).toBe("env");
  });

  it("defaults unrecognized errors to skill", () => {
    expect(
      classifyFailureSource({
        status: "error",
        mutation: baseMutation,
        errorMessage: "Invalid JSON returned by model",
      }),
    ).toBe("skill");
  });

  it("classifies regression with no per-case as skill", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: baseMutation,
        perCase: [],
      }),
    ).toBe("skill");
  });

  it("classifies classification-only regression as agent when surface != classifier", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: { ...baseMutation, surface: "tool_description" },
        perCase: [
          mkCase({ caseId: "c1", category: "classification", score: 0.1 }),
          mkCase({ caseId: "c2", category: "classification", score: 0.2 }),
        ],
      }),
    ).toBe("agent");
  });

  it("classifies scope_accuracy-only regression as agent when surface != scope_rule", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: { ...baseMutation, surface: "tool_description" },
        perCase: [
          mkCase({ caseId: "c1", category: "scope_accuracy", score: 0.2 }),
        ],
      }),
    ).toBe("agent");
  });

  it("classifies tool_selection regression as skill", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: baseMutation,
        perCase: [
          mkCase({ caseId: "c1", category: "tool_selection", score: 0.1 }),
          mkCase({ caseId: "c2", category: "tool_selection", score: 0.3 }),
        ],
      }),
    ).toBe("skill");
  });

  it("classifies scope_rule regression on scope cases as skill (mutation surface matches)", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: { ...baseMutation, surface: "scope_rule" },
        perCase: [
          mkCase({ caseId: "c1", category: "scope_accuracy", score: 0.2 }),
        ],
      }),
    ).toBe("skill");
  });

  it("classifies mixed-category regression as skill", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: baseMutation,
        perCase: [
          mkCase({ caseId: "c1", category: "classification", score: 0.1 }),
          mkCase({ caseId: "c2", category: "tool_selection", score: 0.2 }),
        ],
      }),
    ).toBe("skill");
  });

  it("ignores cases that are already passing", () => {
    expect(
      classifyFailureSource({
        status: "regressed",
        mutation: { ...baseMutation, surface: "tool_description" },
        perCase: [
          mkCase({ caseId: "c1", category: "tool_selection", score: 0.9 }),
          mkCase({ caseId: "c2", category: "classification", score: 0.1 }),
        ],
      }),
    ).toBe("agent");
  });
});
