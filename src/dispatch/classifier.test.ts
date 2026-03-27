/**
 * Classifier unit tests.
 * Tests the heuristic scoring and agent type routing.
 */

import { describe, it, expect, vi } from "vitest";
import { classify } from "./classifier.js";
import type { RunnerStats, KeywordOutcomeRow } from "../db/task-outcomes.js";

describe("classifier", () => {
  it("should classify short simple tasks as fast", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage",
    });
    expect(result.agentType).toBe("fast");
    expect(result.score).toBeLessThan(3);
    expect(result.explicit).toBe(false);
  });

  it("should classify isolation keywords as nanoclaw", () => {
    const result = classify({
      title: "Run in container",
      description:
        "Execute this task in a sandbox environment with proper isolation",
    });
    expect(result.agentType).toBe("nanoclaw");
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThan(6);
  });

  it("should classify multi-step tasks as heavy", () => {
    const result = classify({
      title: "Refactor auth",
      description:
        "Architect a new authentication system. Redesign the token storage to meet compliance. Analyze and fix all related modules.",
    });
    expect(result.agentType).toBe("heavy");
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  it("should classify parallelizable tasks as swarm", () => {
    const result = classify({
      title: "Full audit",
      description:
        "Audit all 12 service modules for security. Check multiple files across all services. Each module independently reviewed in parallel.",
    });
    expect(result.agentType).toBe("swarm");
    expect(result.score).toBeGreaterThanOrEqual(9);
  });

  it("should respect explicit agent_type override", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "heavy",
    });
    expect(result.agentType).toBe("heavy");
    expect(result.explicit).toBe(true);
    expect(result.score).toBe(-1);
  });

  it("should treat auto as non-explicit", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "auto",
    });
    expect(result.explicit).toBe(false);
    expect(result.agentType).toBe("fast");
  });

  it("should boost score with tags", () => {
    const simple = classify({
      title: "Task",
      description: "A task",
    });
    const withTags = classify({
      title: "Task",
      description: "A task",
      tags: ["complex", "research"],
    });
    expect(withTags.score).toBeGreaterThan(simple.score);
  });

  it("should boost score for critical priority", () => {
    const normal = classify({
      title: "Task",
      description: "A moderate length task description for testing",
    });
    const critical = classify({
      title: "Task",
      description: "A moderate length task description for testing",
      priority: "critical",
    });
    expect(critical.score).toBe(normal.score + 1);
  });

  it("should account for description length", () => {
    const shortDesc = classify({
      title: "Task",
      description: "Short",
    });
    const longDesc = classify({
      title: "Task",
      description: Array(201).fill("word").join(" "),
    });
    expect(longDesc.score).toBeGreaterThan(shortDesc.score);
  });

  // Model tier tests
  it("should recommend flash model for simple tasks", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage",
    });
    expect(result.modelTier).toBe("flash");
  });

  it("should recommend capable model for architecture tasks", () => {
    const result = classify({
      title: "Review auth",
      description:
        "Review the authentication architecture and suggest improvements",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should recommend standard model for medium complexity", () => {
    const result = classify({
      title: "Update config",
      description: Array(101).fill("word").join(" "),
    });
    expect(result.modelTier).toBe("standard");
  });

  it("should set standard model tier for messaging tasks", () => {
    const result = classify({
      title: "Send greeting",
      description: "Say hello to the user",
      tags: ["messaging"],
    });
    expect(result.modelTier).toBe("standard");
  });

  it("should set standard model tier for explicit overrides", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "heavy",
    });
    expect(result.modelTier).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// Outcome adjustment tests (mock DB for these)
// ---------------------------------------------------------------------------

describe("classifier outcome adjustments", () => {
  function makeStats(overrides: Partial<RunnerStats>[]): RunnerStats[] {
    return overrides.map((o) => ({
      ran_on: "fast",
      total: 20,
      successes: 18,
      avg_duration_ms: 5000,
      success_rate: 0.9,
      avg_cost_usd: 0.01,
      ...o,
    }));
  }

  async function classifyWith(
    stats: RunnerStats[],
    keywords: KeywordOutcomeRow[],
    input: { title: string; description: string },
  ) {
    vi.resetModules();
    vi.doMock("../db/task-outcomes.js", () => ({
      queryRunnerStats: () => stats,
      queryOutcomesByKeywords: () => keywords,
    }));
    const { classify: c } = await import("./classifier.js");
    return c(input);
  }

  it("should return 0 adjustment with insufficient data", async () => {
    const result = await classifyWith(makeStats([{ total: 5 }]), [], {
      title: "Test",
      description: "task",
    });
    expect(result.score).toBeLessThan(3);
  });

  it("should pull score down when fast has high success rate", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 50, successes: 48, success_rate: 0.96 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("prefer fast");
  });

  it("should push score up when fast has low success rate", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 20, successes: 8, success_rate: 0.4 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("try heavier");
  });

  it("should detect heavy duration anomaly", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        {
          ran_on: "heavy",
          total: 10,
          avg_duration_ms: 8000,
          success_rate: 0.8,
        },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("over-classified");
  });

  it("should penalize expensive low-success runners", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        { ran_on: "heavy", total: 10, success_rate: 0.3, avg_cost_usd: 0.1 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("costly");
  });

  it("should nudge toward runner that succeeds on similar tasks", async () => {
    const similar: KeywordOutcomeRow[] = [
      { task_id: "t1", ran_on: "nanoclaw", success: 1, duration_ms: 5000 },
      { task_id: "t2", ran_on: "nanoclaw", success: 1, duration_ms: 6000 },
      { task_id: "t3", ran_on: "nanoclaw", success: 1, duration_ms: 4000 },
      { task_id: "t4", ran_on: "fast", success: 0, duration_ms: 3000 },
    ];
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        { ran_on: "nanoclaw", total: 10, success_rate: 0.8 },
      ]),
      similar,
      {
        title: "Deploy config",
        description: "update deployment configuration",
      },
    );
    expect(result.reason).toContain("similar tasks");
  });

  it("should clamp total adjustment to [-3, +4]", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 50, success_rate: 0.95 },
        {
          ran_on: "heavy",
          total: 10,
          avg_duration_ms: 5000,
          success_rate: 0.3,
        },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.score).toBeGreaterThanOrEqual(-3);
  });
});
