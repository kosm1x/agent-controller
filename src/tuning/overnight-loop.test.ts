import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOvernightTuning } from "./overnight-loop.js";
import { initDatabase, closeDatabase } from "../db/index.js";
import {
  ensureTuningTables,
  insertTestCase,
  getLatestRun,
  getExperimentsByRun,
} from "./schema.js";
import type { TestCase, TuningSurface } from "./types.js";
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
});
