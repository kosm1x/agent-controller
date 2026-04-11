import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

import { GoalGraph } from "./goal-graph.js";
import { GoalStatus } from "./types.js";
import { resetFromGoal } from "./resume.js";

describe("resetFromGoal", () => {
  it("resets target and transitive dependents", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    g.addGoal({ id: "g-2", description: "B", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "C", dependsOn: ["g-2"] });
    g.addGoal({ id: "g-4", description: "D", dependsOn: ["g-1"] });

    // Mark all completed
    for (const goal of g.getAll()) {
      g.updateStatus(goal.id, GoalStatus.COMPLETED);
    }

    const resetIds = resetFromGoal(g, "g-2");

    expect(resetIds.sort()).toEqual(["g-2", "g-3"]);
    expect(g.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(g.getGoal("g-2").status).toBe(GoalStatus.PENDING);
    expect(g.getGoal("g-3").status).toBe(GoalStatus.PENDING);
    expect(g.getGoal("g-4").status).toBe(GoalStatus.COMPLETED);
  });

  it("resets only the target when it has no dependents", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    g.addGoal({ id: "g-2", description: "B", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "C", dependsOn: ["g-1"] });

    for (const goal of g.getAll()) {
      g.updateStatus(goal.id, GoalStatus.COMPLETED);
    }

    const resetIds = resetFromGoal(g, "g-3");

    expect(resetIds).toEqual(["g-3"]);
    expect(g.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(g.getGoal("g-2").status).toBe(GoalStatus.COMPLETED);
    expect(g.getGoal("g-3").status).toBe(GoalStatus.PENDING);
  });

  it("throws on nonexistent goalId", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    expect(() => resetFromGoal(g, "nonexistent")).toThrow();
  });

  it("handles diamond dependencies", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    g.addGoal({ id: "g-2", description: "B", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "C", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-4", description: "D", dependsOn: ["g-2", "g-3"] });

    for (const goal of g.getAll()) {
      g.updateStatus(goal.id, GoalStatus.COMPLETED);
    }

    const resetIds = resetFromGoal(g, "g-1");

    expect(resetIds.sort()).toEqual(["g-1", "g-2", "g-3", "g-4"]);
    for (const id of resetIds) {
      expect(g.getGoal(id).status).toBe(GoalStatus.PENDING);
    }
  });

  it("preserves results for non-reset goals when building context", () => {
    // Simulates the resumeFromGoal flow: prior results filtered by reset set
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    g.addGoal({ id: "g-2", description: "B", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "C", dependsOn: ["g-2"] });

    for (const goal of g.getAll()) {
      g.updateStatus(goal.id, GoalStatus.COMPLETED);
    }

    const priorResults: Record<string, { goalId: string; ok: boolean }> = {
      "g-1": { goalId: "g-1", ok: true },
      "g-2": { goalId: "g-2", ok: true },
      "g-3": { goalId: "g-3", ok: true },
    };

    const resetIds = resetFromGoal(g, "g-2");
    const resetSet = new Set(resetIds);

    // Filter: keep only non-reset results
    const kept: Record<string, { goalId: string; ok: boolean }> = {};
    for (const [id, result] of Object.entries(priorResults)) {
      if (!resetSet.has(id)) kept[id] = result;
    }

    expect(Object.keys(kept)).toEqual(["g-1"]);
    expect(kept["g-1"].ok).toBe(true);
  });

  it("correctly identifies ready goals after reset", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    g.addGoal({ id: "g-2", description: "B", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "C", dependsOn: ["g-2"] });

    for (const goal of g.getAll()) {
      g.updateStatus(goal.id, GoalStatus.COMPLETED);
    }

    resetFromGoal(g, "g-2");

    // g-1 completed, g-2 pending with deps met → g-2 should be ready
    const ready = g.getReady();
    expect(ready.map((r) => r.id)).toEqual(["g-2"]);
    // g-3 pending but g-2 not completed → g-3 NOT ready
  });
});
