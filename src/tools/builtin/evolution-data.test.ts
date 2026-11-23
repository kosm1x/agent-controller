/**
 * evolution_deactivate_skill: its description, read from the definition only.
 *
 * Safety of this file: no handler is called, and the database module is stood
 * in for with one that refuses to open, so nothing here reads or writes a
 * database.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/index.js", () => ({
  getDatabase: () => {
    throw new Error("no database in this test");
  },
  writeWithRetry: () => {
    throw new Error("no database in this test");
  },
}));

import { evolutionDeactivateSkillTool } from "./evolution-data.js";

describe("evolution_deactivate_skill description", () => {
  it("says the skill stays stored but no longer matches a keyword search, and promises no reactivation", () => {
    const description = evolutionDeactivateSkillTool.definition.function.description;
    const sentence =
      "The skill remains in the database but will not match in findSkillsByKeywords queries.";
    expect(description.split(sentence).length - 1).toBe(1);
    expect(description).not.toContain("reactivated");
    expect(description).not.toContain("skill_save");
  });
});
