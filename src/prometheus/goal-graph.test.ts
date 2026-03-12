/**
 * GoalGraph unit tests.
 * Pure data structure tests — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { GoalGraph } from "./goal-graph.js";
import { GoalStatus } from "./types.js";

describe("GoalGraph", () => {
  it("should add goals and track size", () => {
    const g = new GoalGraph();
    expect(g.size).toBe(0);

    g.addGoal({ description: "Goal A" });
    g.addGoal({ description: "Goal B" });
    expect(g.size).toBe(2);
  });

  it("should generate sequential IDs", () => {
    const g = new GoalGraph();
    const a = g.addGoal({ description: "A" });
    const b = g.addGoal({ description: "B" });
    expect(a.id).toBe("g-1");
    expect(b.id).toBe("g-2");
  });

  it("should accept explicit IDs", () => {
    const g = new GoalGraph();
    const a = g.addGoal({ id: "custom-1", description: "Custom" });
    expect(a.id).toBe("custom-1");
  });

  it("should reject duplicate IDs", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "A" });
    expect(() => g.addGoal({ id: "g-1", description: "B" })).toThrow(
      "already exists",
    );
  });

  it("should wire parent-child relationships", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "p", description: "Parent" });
    g.addGoal({ id: "c1", description: "Child 1", parentId: "p" });
    g.addGoal({ id: "c2", description: "Child 2", parentId: "p" });

    const p = g.getGoal("p");
    expect(p.children).toEqual(["c1", "c2"]);
    expect(g.getGoal("c1").parentId).toBe("p");
  });

  it("should reject missing parent", () => {
    const g = new GoalGraph();
    expect(() =>
      g.addGoal({ description: "Orphan", parentId: "nonexistent" }),
    ).toThrow("not found");
  });

  it("should reject missing dependency", () => {
    const g = new GoalGraph();
    expect(() =>
      g.addGoal({ description: "Dep", dependsOn: ["nonexistent"] }),
    ).toThrow("not found");
  });

  it("should track dependencies", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "a", description: "A" });
    g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });

    expect(g.getGoal("b").dependsOn).toEqual(["a"]);
  });

  it("should remove goals and clean references", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "a", description: "A" });
    g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });
    g.addGoal({ id: "c", description: "C", parentId: "a" });

    g.removeGoal("a");

    expect(g.size).toBe(2);
    expect(g.getGoal("b").dependsOn).toEqual([]);
    expect(g.getGoal("c").parentId).toBeNull();
  });

  it("should update status", () => {
    const g = new GoalGraph();
    g.addGoal({ id: "a", description: "A" });
    expect(g.getGoal("a").status).toBe(GoalStatus.PENDING);

    g.updateStatus("a", GoalStatus.IN_PROGRESS);
    expect(g.getGoal("a").status).toBe(GoalStatus.IN_PROGRESS);
  });

  describe("getReady", () => {
    it("should return pending goals with all deps completed", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });
      g.addGoal({ id: "c", description: "C" });

      const ready = g.getReady();
      expect(ready.map((r) => r.id).sort()).toEqual(["a", "c"]);
    });

    it("should not return goals with incomplete deps", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });

      expect(g.getReady().map((r) => r.id)).toEqual(["a"]);

      g.updateStatus("a", GoalStatus.COMPLETED);
      expect(g.getReady().map((r) => r.id)).toEqual(["b"]);
    });
  });

  describe("getBlocked", () => {
    it("should mark goals with failed deps as blocked", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });

      g.updateStatus("a", GoalStatus.FAILED);
      const blocked = g.getBlocked();
      expect(blocked.map((b) => b.id)).toEqual(["b"]);
      expect(g.getGoal("b").status).toBe(GoalStatus.BLOCKED);
    });
  });

  describe("getByStatus", () => {
    it("should filter goals by status", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({
        id: "b",
        description: "B",
        status: GoalStatus.COMPLETED,
      });
      g.addGoal({ id: "c", description: "C" });

      expect(g.getByStatus(GoalStatus.PENDING).length).toBe(2);
      expect(g.getByStatus(GoalStatus.COMPLETED).length).toBe(1);
    });
  });

  describe("summary", () => {
    it("should count statuses", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B" });
      g.addGoal({
        id: "c",
        description: "C",
        status: GoalStatus.COMPLETED,
      });

      const s = g.summary();
      expect(s.total).toBe(3);
      expect(s.pending).toBe(2);
      expect(s.completed).toBe(1);
    });
  });

  describe("validate", () => {
    it("should return empty for valid graph", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });

      expect(g.validate()).toEqual([]);
    });

    it("should detect cycles", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });

      // Manually inject a cycle (a depends on b)
      const goalA = g.getGoal("a");
      goalA.dependsOn.push("b");

      const errors = g.validate();
      expect(errors.some((e) => e.includes("Cycle"))).toBe(true);
    });
  });

  describe("serialization", () => {
    it("should round-trip through toJSON/fromJSON", () => {
      const g = new GoalGraph();
      g.addGoal({ id: "a", description: "A" });
      g.addGoal({ id: "b", description: "B", dependsOn: ["a"] });
      g.addGoal({ id: "c", description: "C", parentId: "a" });
      g.updateStatus("a", GoalStatus.COMPLETED);

      const json = g.toJSON();
      const restored = GoalGraph.fromJSON(json);

      expect(restored.size).toBe(3);
      expect(restored.getGoal("a").status).toBe(GoalStatus.COMPLETED);
      expect(restored.getGoal("b").dependsOn).toEqual(["a"]);
      expect(restored.getGoal("c").parentId).toBe("a");
    });
  });
});
