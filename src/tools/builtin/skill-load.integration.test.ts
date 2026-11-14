/**
 * `skill_load` statements on the real schema (`initDatabase(":memory:")`).
 * Three skills whose ids sort on each side of the one loaded, each with its
 * own pointer, output type, trigger examples, certification and version
 * rows, so a statement that read a neighbour's row returns a different
 * payload. Version ids of the loaded skill sit between the neighbours' ids.
 * Rows are written with plain INSERTs; fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { skillLoadTool } from "./skill-load.js";

function skill(id: string, o: { output: string; triggers: string[]; certified: number }): void {
  getDatabase()
    .prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, source,
                           inputs_json, output_type, trigger_examples_json, is_certified)
       VALUES (?, ?, ?, 'trigger', 'manual', '[{"name":"skills_row_input"}]', ?, ?, ?)`,
    )
    .run(id, `name-${id}`, `describes ${id}`, o.output, JSON.stringify(o.triggers), o.certified);
}

function version(skillId: string, v: string): number {
  return Number(
    getDatabase()
      .prepare(
        `INSERT INTO skill_versions (skill_id, version, body, body_sha256, inputs_json,
                                     tests_json, tools_used_json, created_by, critic_verdict)
         VALUES (?, ?, ?, 'sha', ?, '[]', ?, 'operator', 'pass')`,
      )
      .run(
        skillId,
        v,
        `# body of ${skillId} ${v}`,
        JSON.stringify([{ name: `in_${skillId}_${v}` }]),
        JSON.stringify([`tool_${skillId}_${v}`]),
      ).lastInsertRowid,
  );
}

function point(skillId: string, versionId: number): void {
  getDatabase()
    .prepare("UPDATE skills SET current_version_id = ? WHERE skill_id = ?")
    .run(versionId, skillId);
}

async function load(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await skillLoadTool.execute(args)) as Record<string, unknown>;
}

const ids: Record<string, number> = {};

beforeEach(() => {
  initDatabase(":memory:");
  // Inserted above-first so row order and id order disagree.
  skill("sk-c", { output: "json", triggers: ["trigger c"], certified: 0 });
  skill("sk-a", { output: "markdown", triggers: ["trigger a"], certified: 0 });
  skill("sk-b", { output: "table", triggers: ["trigger b1", "trigger b2"], certified: 1 });
  ids.a200 = version("sk-a", "2.0.0");
  ids.b100 = version("sk-b", "1.0.0");
  ids.b120 = version("sk-b", "1.2.0");
  ids.c200 = version("sk-c", "2.0.0");
  ids.c100 = version("sk-c", "1.0.0");
  point("sk-a", ids.a200);
  point("sk-b", ids.b120);
  point("sk-c", ids.c200);
});
afterEach(() => closeDatabase());

describe("skill_load — current version through the pointer", () => {
  it("returns the loaded skill's pointed-at version and its own skills-row fields", async () => {
    expect(await load({ name: "name-sk-b" })).toEqual({
      ok: true,
      skill: {
        name: "name-sk-b",
        description: "describes sk-b",
        version: "1.2.0",
        inputs: [{ name: "in_sk-b_1.2.0" }],
        output_type: "table",
        trigger_examples: ["trigger b1", "trigger b2"],
        tools_used: ["tool_sk-b_1.2.0"],
        body: "# body of sk-b 1.2.0",
        is_certified: true,
        version_is_current: true,
      },
    });
  });
});

describe("skill_load — explicit version", () => {
  it("loads that version of this skill; the skills-row fields stay this skill's", async () => {
    expect(await load({ name: "sk-b", version: "1.0.0" })).toEqual({
      ok: true,
      skill: {
        name: "name-sk-b",
        description: "describes sk-b",
        version: "1.0.0",
        inputs: [{ name: "in_sk-b_1.0.0" }],
        output_type: "table",
        trigger_examples: ["trigger b1", "trigger b2"],
        tools_used: ["tool_sk-b_1.0.0"],
        body: "# body of sk-b 1.0.0",
        is_certified: true,
        version_is_current: false,
      },
    });
  });

  // A version only the neighbours have, and a version between this skill's
  // two versions, are both not found.
  it.each(["2.0.0", "1.1.0"])("version %s that this skill lacks is not found", async (v) => {
    expect(await load({ name: "sk-b", version: v })).toEqual({
      ok: false,
      reason: "version_not_found",
      name: "sk-b",
      version: v,
    });
  });
});
