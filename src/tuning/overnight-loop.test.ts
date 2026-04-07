import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOvernightTuning, validateMutation } from "./overnight-loop.js";
import { initDatabase, closeDatabase } from "../db/index.js";
import {
  ensureTuningTables,
  insertTestCase,
  insertVariant,
  getLatestRun,
  getExperimentsByRun,
  getValidVariants,
} from "./schema.js";
import type { TestCase, TuningSurface } from "./types.js";
import { serializeSandbox } from "./variant-store.js";
import type { InferFunction } from "./eval-runner.js";
import type { MetaInferFunction } from "./meta-agent.js";

beforeEach(() => {
  initDatabase(":memory:");
  ensureTuningTables();

  // Seed minimal test cases
  const scopeCase: TestCase = {
    case_id: "sc-docker",
    category: "scope_accuracy",
    input: { message: "Revisa los containers de Docker" },
    expected: { scope_groups: ["coding"] },
    weight: 1.0,
    source: "manual",
    active: true,
  };
  const classCase: TestCase = {
    case_id: "cl-simple",
    category: "classification",
    input: { message: "Busca el clima" },
    expected: { agent_type: "fast" },
    weight: 1.0,
    source: "manual",
    active: true,
  };
  insertTestCase(scopeCase);
  insertTestCase(classCase);
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

function makeMockEvalInfer(): InferFunction {
  return async () => ({ toolsCalled: [], tokensUsed: 0 });
}

function makeMockMetaInfer(
  mutations: Array<Record<string, string>>,
): MetaInferFunction {
  let callIdx = 0;
  return async () => {
    const m = mutations[callIdx % mutations.length];
    callIdx++;
    return { content: JSON.stringify(m), tokensUsed: 100 };
  };
}

describe("runOvernightTuning", () => {
  it("runs baseline and experiments, produces report", async () => {
    const result = await runOvernightTuning({
      maxExperiments: 2,
      maxCostUsd: 10,
      surfaces: ["scope_rule"] as TuningSurface[],
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: makeMockMetaInfer([
        {
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(docker|code|archivos?)",
          hypothesis: "Add docker to coding scope",
        },
      ]),
    });

    expect(result.baseline_score).toBeGreaterThanOrEqual(0);
    expect(result.experiments_run).toBe(2);
    expect(result.report).toContain("TUNING REPORT");
    expect(result.status).toBe("completed");
  });

  it("stops when budget is exceeded", async () => {
    const result = await runOvernightTuning({
      maxExperiments: 100,
      maxCostUsd: 0.001, // Tiny budget — should stop almost immediately
      surfaces: ["scope_rule"] as TuningSurface[],
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: makeMockMetaInfer([
        {
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(docker|code)",
          hypothesis: "test",
        },
      ]),
    });

    expect(result.status).toBe("budget_exceeded");
    expect(result.experiments_run).toBeLessThan(100);
  });

  it("detects stall and stops", async () => {
    // Meta-agent always proposes same mutation → after first keep,
    // subsequent attempts produce 0 delta → regressions
    const result = await runOvernightTuning({
      maxExperiments: 20,
      maxCostUsd: 100,
      stalledAfterN: 3,
      surfaces: ["scope_rule"] as TuningSurface[],
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: makeMockMetaInfer([
        {
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(docker|code)",
          hypothesis: "same mutation every time",
        },
      ]),
    });

    // Should stop due to stall (3+ consecutive regressions after the first keep)
    expect(result.experiments_run).toBeLessThanOrEqual(10);
  });

  it("persists run and experiments to database", async () => {
    const result = await runOvernightTuning({
      maxExperiments: 1,
      maxCostUsd: 10,
      surfaces: ["scope_rule"] as TuningSurface[],
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: makeMockMetaInfer([
        {
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(docker)",
          hypothesis: "persist test",
        },
      ]),
    });

    const latestRun = getLatestRun();
    expect(latestRun).not.toBeNull();
    expect(latestRun!.run_id).toBe(result.run_id);

    const experiments = getExperimentsByRun(result.run_id);
    expect(experiments).toHaveLength(1);
    expect(experiments[0].hypothesis).toBe("persist test");
  });

  it("handles meta-agent parse failure gracefully", async () => {
    const result = await runOvernightTuning({
      maxExperiments: 2,
      maxCostUsd: 10,
      stalledAfterN: 5,
      surfaces: ["scope_rule"] as TuningSurface[],
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: async () => ({
        content: "I can't propose anything useful right now.",
        tokensUsed: 50,
      }),
    });

    // Should complete with 0 wins (all parse failures count as regressions)
    expect(result.experiments_won).toBe(0);
    expect(result.experiments_run).toBe(0); // parse failures don't count as experiments
  });

  it("loads parent variant from archive when available", async () => {
    // Seed a parent variant
    const parentConfig = serializeSandbox({
      scopePatternOverrides: [
        { pattern: /\b(docker|code)\b/i, group: "coding" },
      ],
    });
    insertVariant({
      variant_id: "var-parent",
      parent_id: null,
      run_id: "old-run",
      generation: 0,
      config_json: parentConfig,
      composite_score: 75,
      subscores_json: null,
      valid: true,
      activated_at: null,
      created_at: new Date().toISOString(),
    });

    const result = await runOvernightTuning({
      maxExperiments: 1,
      maxCostUsd: 10,
      surfaces: ["scope_rule"] as TuningSurface[],
      parentSelection: "best",
      stagedGate: false,
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: makeMockMetaInfer([
        {
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(docker|code|git)",
          hypothesis: "extend coding scope from parent",
        },
      ]),
    });

    expect(result.experiments_run).toBe(1);
    // Run completed, meaning parent was loaded successfully
    expect(result.status).toBe("completed");
  });

  it("persists winning variant to archive", async () => {
    // Start with no variants
    expect(getValidVariants()).toHaveLength(0);

    // Use a meta-agent that produces a genuinely different scope pattern
    // that will score differently from baseline
    await runOvernightTuning({
      maxExperiments: 3,
      maxCostUsd: 10,
      stalledAfterN: 10,
      minDeltaToKeep: -100, // Accept any mutation (for testing)
      surfaces: ["scope_rule"] as TuningSurface[],
      parentSelection: "best",
      stagedGate: false,
      evalInferFn: makeMockEvalInfer(),
      metaInferFn: makeMockMetaInfer([
        {
          surface: "scope_rule",
          target: "coding",
          mutation_type: "adjust",
          mutated_value: "\\b(docker|code|git)",
          hypothesis: "should persist",
        },
      ]),
    });

    // Since minDeltaToKeep is -100, all mutations are "wins"
    const variants = getValidVariants();
    expect(variants.length).toBeGreaterThanOrEqual(1);
    expect(variants[0].variant_id).toMatch(/^var-tune-/);
    expect(variants[0].generation).toBe(0); // First generation (no parent)
  });
});

// ---------------------------------------------------------------------------
// validateMutation (v6.4 A1 — anti-overfitting + simplicity gate)
// ---------------------------------------------------------------------------

describe("validateMutation", () => {
  // Use realistic description lengths (100+ chars) so ratio tests are meaningful
  const original =
    "Search the web for current information using major search engines. Returns top results with snippets.";
  const baseMutation = {
    surface: "tool_description" as const,
    target: "web_search",
    mutation_type: "rewrite" as const,
    hypothesis: "Add clearer usage guidance for news queries",
    mutated_value:
      "Search the web for current information using major search engines. Returns top results with snippets and dates.",
    original_value: original,
  };

  it("passes a clean mutation", () => {
    expect(validateMutation(baseMutation, 5, original)).toBeNull();
  });

  it("rejects overfitting: hypothesis mentions specific case ID", () => {
    const m = {
      ...baseMutation,
      hypothesis: "Fix case-42 by adding keyword",
    };
    expect(validateMutation(m, 5, original)).toContain("overfitting");
  });

  it("rejects complexity: mutation >2x longer than original", () => {
    const m = {
      ...baseMutation,
      mutated_value: "A".repeat(210), // >2x of 100-char original
    };
    expect(validateMutation(m, 5, original)).toContain("complexity");
  });

  it("rejects low-worth: single case + length increase >20%", () => {
    const m = {
      ...baseMutation,
      // ~30% longer than original (130 vs 100 chars)
      mutated_value:
        original +
        " Also check academic sources and verify publication dates for accuracy.",
    };
    expect(validateMutation(m, 1, original)).toContain("low-worth");
  });

  it("allows single-case fix if no length increase", () => {
    const m = {
      ...baseMutation,
      // Same length, different wording
      mutated_value:
        "Query the internet for latest information using major search engines. Returns top results with snippets.",
    };
    expect(validateMutation(m, 1, original)).toBeNull();
  });

  it("allows longer mutation if many cases affected", () => {
    const m = {
      ...baseMutation,
      mutated_value:
        original +
        " Also check academic sources and verify publication dates for accuracy.",
    };
    expect(validateMutation(m, 10, original)).toBeNull();
  });
});
