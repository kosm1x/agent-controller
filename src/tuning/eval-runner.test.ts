import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runEvaluation, type InferFunction } from "./eval-runner.js";
import { initDatabase, closeDatabase } from "../db/index.js";
import { ensureTuningTables, insertTestCase } from "./schema.js";
import type { TestCase } from "./types.js";

// Use in-memory database for tests
beforeEach(() => {
  initDatabase(":memory:");
  ensureTuningTables();
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

function makeScopeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    case_id: "sc-test-01",
    category: "scope_accuracy",
    input: { message: "Revisa el código del proyecto" },
    expected: { scope_groups: ["coding"] },
    weight: 1.0,
    source: "manual",
    active: true,
    ...overrides,
  };
}

function makeClassificationCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    case_id: "cl-test-01",
    category: "classification",
    input: { message: "Busca el clima" },
    expected: { agent_type: "fast" },
    weight: 1.0,
    source: "manual",
    active: true,
    ...overrides,
  };
}

function makeToolSelectionCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    case_id: "ts-test-01",
    category: "tool_selection",
    input: { message: "Busca cuánto cuesta un vuelo" },
    expected: { tools: ["web_search"] },
    weight: 1.0,
    source: "manual",
    active: true,
    ...overrides,
  };
}

describe("runEvaluation", () => {
  it("evaluates scope_accuracy cases without LLM calls", async () => {
    insertTestCase(makeScopeCase());

    const result = await runEvaluation({}, { category: "scope_accuracy" });

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].category).toBe("scope_accuracy");
    expect(result.perCase[0].score).toBe(1.0); // "código" matches coding
    expect(result.totalTokens).toBe(0);
    expect(result.subscores.scopeAccuracy).toBe(100);
  });

  it("evaluates classification cases without LLM calls", async () => {
    insertTestCase(makeClassificationCase());

    const result = await runEvaluation({}, { category: "classification" });

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].score).toBe(1.0); // short message → fast
    expect(result.subscores.classification).toBe(100);
  });

  it("evaluates tool_selection cases with mock inference", async () => {
    insertTestCase(makeToolSelectionCase());

    const mockInfer: InferFunction = async () => ({
      toolsCalled: ["web_search"],
      tokensUsed: 150,
    });

    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].score).toBe(1.0);
    expect(result.totalTokens).toBe(150);
  });

  it("returns 0 composite for empty test suite", async () => {
    const result = await runEvaluation();
    expect(result.compositeScore).toBe(0);
    expect(result.perCase).toHaveLength(0);
  });

  it("computes composite score across mixed categories", async () => {
    insertTestCase(makeScopeCase());
    insertTestCase(makeClassificationCase());
    insertTestCase(makeToolSelectionCase());

    const mockInfer: InferFunction = async () => ({
      toolsCalled: ["web_search"],
      tokensUsed: 100,
    });

    const result = await runEvaluation({}, undefined, mockInfer);

    expect(result.perCase).toHaveLength(3);
    // All pass → composite should be 100
    expect(result.compositeScore).toBe(100);
  });

  it("filters by caseIds", async () => {
    insertTestCase(makeScopeCase({ case_id: "sc-a" }));
    insertTestCase(makeScopeCase({ case_id: "sc-b" }));

    const result = await runEvaluation({}, { caseIds: ["sc-a"] });

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].caseId).toBe("sc-a");
  });

  it("handles scope pattern overrides in sandbox", async () => {
    // Test case expects "coding" group for "Docker containers"
    insertTestCase(
      makeScopeCase({
        case_id: "sc-docker",
        input: { message: "Lista los Docker containers" },
        expected: { scope_groups: ["coding"] },
      }),
    );

    // Default patterns don't include "docker" → should fail
    const resultDefault = await runEvaluation(
      {},
      { category: "scope_accuracy" },
    );
    expect(resultDefault.perCase[0].score).toBe(0); // "docker" not in coding regex

    // Override with pattern that includes docker → should pass
    const resultOverride = await runEvaluation(
      {
        scopePatternOverrides: [
          { pattern: /\b(docker|code|archivos?)/i, group: "coding" },
        ],
      },
      { category: "scope_accuracy" },
    );
    expect(resultOverride.perCase[0].score).toBe(1.0);
  });

  it("records error as 0 score when case evaluation throws", async () => {
    insertTestCase(makeToolSelectionCase());

    const failingInfer: InferFunction = async () => {
      throw new Error("API unavailable");
    };

    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      failingInfer,
    );

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].score).toBe(0);
    expect(result.perCase[0].details.error).toContain("API unavailable");
  });
});
