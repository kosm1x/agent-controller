/**
 * Tests for swarm runner sibling context injection.
 */

import { describe, it, expect, vi } from "vitest";

// Mock dispatcher before importing swarm-runner (it auto-registers)
vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
  submitTask: vi.fn(),
  getTask: vi.fn(),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    emitEvent: vi.fn(),
  }),
}));

vi.mock("../prometheus/planner.js", () => ({
  plan: vi.fn(),
}));

vi.mock("../prometheus/reflector.js", () => ({
  reflect: vi.fn(),
}));

import { buildSubTaskDescription } from "./swarm-runner.js";
import { GoalGraph } from "../prometheus/goal-graph.js";
import { GoalStatus } from "../prometheus/types.js";

interface Tracker {
  goalId: string;
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
}

function makeGraph(): GoalGraph {
  const graph = new GoalGraph();
  graph.addGoal({ id: "g-1", description: "Setup database" });
  graph.addGoal({ id: "g-2", description: "Build API layer" });
  graph.addGoal({
    id: "g-3",
    description: "Write frontend",
    dependsOn: ["g-1"],
  });
  return graph;
}

describe("buildSubTaskDescription — sibling context", () => {
  it("includes sibling goals with their status", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      ["g-2", { goalId: "g-2", taskId: "t-2", status: "running" }],
    ]);

    const goal = graph.getGoal("g-1");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Sibling goals");
    expect(desc).toContain("Build API layer [running]");
    // g-3 depends on g-1, so it's a dependency, not a sibling here
    // But g-3's parentId is null (same as g-1), and g-1 is in g-3's dependsOn
    // When building desc for g-1, g-3 depends on g-1, but from g-1's perspective
    // g-3 is not in g-1.dependsOn. So g-3 IS a sibling of g-1
    expect(desc).toContain("Write frontend [pending]");
  });

  it("includes completed sibling output (truncated)", () => {
    const graph = makeGraph();
    const longOutput = "A".repeat(300);
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: longOutput,
        },
      ],
    ]);

    const goal = graph.getGoal("g-1");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Result: ");
    // Output should be truncated to 200 chars
    expect(desc).not.toContain("A".repeat(300));
    expect(desc).toContain("A".repeat(200));
  });

  it("does not duplicate dependency goals in sibling section", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>();

    // g-3 depends on g-1. When building desc for g-3, g-1 should NOT appear
    // in siblings because it's already in dependsOn
    graph.updateStatus("g-1", GoalStatus.COMPLETED);
    const goal = graph.getGoal("g-3");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    // g-1 should appear in dependencies section, not siblings
    expect(desc).toContain("Context from completed dependencies");
    expect(desc).toContain("Setup database (completed)");

    // g-2 is a sibling (same parentId, not a dependency of g-3)
    if (desc.includes("Sibling goals")) {
      expect(desc).toContain("Build API layer");
      // g-1 should NOT be in the sibling section
      const siblingSection = desc.split("Sibling goals")[1];
      expect(siblingSection).not.toContain("Setup database");
    }
  });

  it("omits sibling section when no siblings exist", () => {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-only", description: "Only goal" });
    const trackers = new Map<string, Tracker>();

    const goal = graph.getGoal("g-only");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).not.toContain("Sibling goals");
  });

  it("handles empty tracker output without crashing", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: undefined,
        },
      ],
    ]);

    const goal = graph.getGoal("g-1");
    // Should not throw
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Build API layer [completed]");
    expect(desc).not.toContain("Result:");
  });
});
