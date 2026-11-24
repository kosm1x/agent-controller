/**
 * evolution_deactivate_skill and evolution_get_data: their descriptions, read
 * from the definitions only.
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

import {
  evolutionDeactivateSkillTool,
  evolutionGetDataTool,
} from "./evolution-data.js";

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

// Description pins: each tool's whole description text as registered.
describe("tool description texts", () => {
  it("evolution_get_data carries exactly this description", () => {
    expect(evolutionGetDataTool.definition.function.description).toBe(
      [
        "Get aggregated outcome data for skill evolution analysis.",
        "",
        "Returns three datasets:",
        "1. tool_effectiveness: Per-tool success rates grouped by task classification (top 30 rows, last `days` days)",
        "2. runner_performance: Per-runner success rate and avg duration (last `days` days)",
        "3. underperforming_skills: Active skills with success rate below 40% on 5+ uses",
        "",
        "USE WHEN: Running the nightly evolution ritual to analyze patterns.",
        "DO NOT USE: During regular task execution.",
      ].join("\n"),
    );
  });

  it("evolution_deactivate_skill carries exactly this description", () => {
    expect(evolutionDeactivateSkillTool.definition.function.description).toBe(
      [
        "Deactivate an underperforming skill so it is no longer injected into prompts.",
        "",
        "The skill remains in the database but will not match in findSkillsByKeywords queries.",
        "Use only during evolution analysis for skills",
        "with consistently low success rates on 5+ uses.",
        "",
        "DO NOT USE WHEN:",
        "- The skill was not in the underperforming list you just read: this tool checks no success rate or use count itself, and it reports success even when no skill has that id.",
        "- You want a skill removed or switched back on: this tool only marks a skill inactive; it deletes nothing and cannot undo the change.",
      ].join("\n"),
    );
  });
});
