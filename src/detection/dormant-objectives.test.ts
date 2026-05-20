/**
 * Dormant-objective detector tests (V8.1 Phase 5 B1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectDormantObjectives } from "./dormant-objectives.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

function insertObjective(path: string, title: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO jarvis_files (id, path, title, content) VALUES (?, ?, ?, '')",
    )
    .run(crypto.randomUUID(), path, title);
}

/** Insert a task whose metadata references `objectivePath`, with an activity age. */
function insertLinkedTask(objectivePath: string, ageDays: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, metadata, updated_at)
       VALUES (?, 'task', 'desc', ?, datetime('now', ?))`,
    )
    .run(
      `t-${crypto.randomUUID()}`,
      JSON.stringify({ objective: objectivePath }),
      `-${ageDays} days`,
    );
}

describe("detectDormantObjectives", () => {
  it("flags an objective whose last linked task is older than 14 days", () => {
    insertObjective("NorthStar/objectives/alpha.md", "Alpha");
    insertLinkedTask("NorthStar/objectives/alpha.md", 30);
    const signals = detectDormantObjectives();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("dormant_objective");
    expect(signals[0]!.objectivePath).toBe("NorthStar/objectives/alpha.md");
    expect(signals[0]!.daysDormant).toBe(30);
  });

  it("does not flag an objective with recent task activity", () => {
    insertObjective("NorthStar/objectives/beta.md", "Beta");
    insertLinkedTask("NorthStar/objectives/beta.md", 3);
    expect(detectDormantObjectives()).toEqual([]);
  });

  it("flags an objective with no linked task ever (daysDormant null)", () => {
    insertObjective("NorthStar/objectives/gamma.md", "Gamma");
    const signals = detectDormantObjectives();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.daysDormant).toBeNull();
    expect(signals[0]!.lastTaskActivity).toBeNull();
  });

  it("ignores non-objective jarvis_files rows", () => {
    insertObjective("NorthStar/visions/whole.md", "A vision");
    insertObjective("reference/notes.md", "Some notes");
    expect(detectDormantObjectives()).toEqual([]);
  });

  it("honours a custom threshold", () => {
    insertObjective("NorthStar/objectives/delta.md", "Delta");
    insertLinkedTask("NorthStar/objectives/delta.md", 10);
    expect(detectDormantObjectives(14)).toEqual([]);
    expect(detectDormantObjectives(7)).toHaveLength(1);
  });
});
