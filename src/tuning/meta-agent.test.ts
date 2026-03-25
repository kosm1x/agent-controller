import { describe, it, expect } from "vitest";
import {
  parseMutationResponse,
  formatWorstCases,
  formatExperimentHistory,
  buildMetaAgentPrompt,
} from "./meta-agent.js";
import type { CaseScore, Experiment, TuningSurface } from "./types.js";

describe("parseMutationResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      surface: "tool_description",
      target: "web_search",
      mutation_type: "rewrite",
      mutated_value: "New description",
      hypothesis: "Improve price query matching",
    });

    const result = parseMutationResponse(response);
    expect(result).not.toBeNull();
    expect(result!.surface).toBe("tool_description");
    expect(result!.target).toBe("web_search");
    expect(result!.mutated_value).toBe("New description");
  });

  it("parses JSON wrapped in markdown code fence", () => {
    const response = `Here's my proposal:

\`\`\`json
{
  "surface": "scope_rule",
  "target": "coding",
  "mutation_type": "adjust",
  "mutated_value": "\\\\b(docker|code)",
  "hypothesis": "Add docker keyword"
}
\`\`\`

This should improve the coding scope.`;

    const result = parseMutationResponse(response);
    expect(result).not.toBeNull();
    expect(result!.surface).toBe("scope_rule");
    expect(result!.target).toBe("coding");
  });

  it("returns null for empty response", () => {
    expect(parseMutationResponse("")).toBeNull();
  });

  it("returns null for response without JSON", () => {
    expect(
      parseMutationResponse("I think we should improve web_search"),
    ).toBeNull();
  });

  it("returns null for invalid surface", () => {
    const response = JSON.stringify({
      surface: "invalid_surface",
      target: "web_search",
      mutated_value: "test",
    });
    expect(parseMutationResponse(response)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const response = JSON.stringify({
      surface: "tool_description",
      // missing target and mutated_value
    });
    expect(parseMutationResponse(response)).toBeNull();
  });

  it("defaults mutation_type to rewrite", () => {
    const response = JSON.stringify({
      surface: "tool_description",
      target: "web_search",
      mutated_value: "New desc",
    });
    const result = parseMutationResponse(response);
    expect(result!.mutation_type).toBe("rewrite");
  });

  it("extracts JSON from text with surrounding content", () => {
    const response = `After analyzing the cases, I propose: {"surface":"scope_rule","target":"coding","mutation_type":"adjust","mutated_value":"test","hypothesis":"testing"} This should help.`;
    const result = parseMutationResponse(response);
    expect(result).not.toBeNull();
    expect(result!.surface).toBe("scope_rule");
  });
});

describe("formatWorstCases", () => {
  it("sorts by score ascending and limits", () => {
    const cases: CaseScore[] = [
      { caseId: "a", category: "scope_accuracy", score: 0.8, details: {} },
      { caseId: "b", category: "tool_selection", score: 0.2, details: {} },
      { caseId: "c", category: "classification", score: 0.5, details: {} },
    ];
    const result = formatWorstCases(cases, 2);
    expect(result).toContain("**b**");
    expect(result).toContain("**c**");
    expect(result).not.toContain("**a**");
  });
});

describe("formatExperimentHistory", () => {
  it("formats experiment with delta", () => {
    const experiments: Experiment[] = [
      {
        experiment_id: "e1",
        run_id: "r1",
        surface: "scope_rule",
        target: "coding",
        mutation_type: "adjust",
        original_value: "old",
        mutated_value: "new",
        hypothesis: "test hyp",
        baseline_score: 50,
        mutated_score: 55,
        status: "passed",
      },
    ];
    const result = formatExperimentHistory(experiments);
    expect(result).toContain("[passed]");
    expect(result).toContain("+5.0");
    expect(result).toContain("test hyp");
  });

  it("returns message for empty history", () => {
    expect(formatExperimentHistory([])).toBe("No previous experiments.");
  });
});

describe("buildMetaAgentPrompt", () => {
  it("includes score and surfaces in prompt", () => {
    const ctx = {
      compositeScore: 72.5,
      worstCases: [] as CaseScore[],
      experimentHistory: [] as Experiment[],
      surfaces: ["tool_description", "scope_rule"] as TuningSurface[],
    };
    const prompt = buildMetaAgentPrompt(ctx);
    expect(prompt).toContain("72.5");
    expect(prompt).toContain("tool_description");
    expect(prompt).toContain("scope_rule");
    expect(prompt).toContain("Propose exactly ONE mutation");
  });
});
