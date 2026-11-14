/**
 * `skill_describe` statement on the real schema (`initDatabase(":memory:")`):
 * the skills-row extras and the newest test-run time. Three skills whose ids
 * sort on each side of the one described, each with its own values in every
 * column the statement reads, and test runs whose newest time is later on
 * both neighbours than on the described skill. Rows are written with plain
 * INSERTs; fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { skillDescribeTool } from "./skill-describe.js";

interface Cols {
  version: string;
  output: string;
  inputs: string;
  certified: number;
  active: number;
  failures: number;
  lastUsed: string | null;
  useCount: number;
  successCount: number;
}

function skill(id: string, c: Cols): void {
  getDatabase()
    .prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, source, version,
                           output_type, inputs_json, is_certified, active,
                           consecutive_failures, last_failure_at, last_used,
                           use_count, success_count)
       VALUES (?, ?, ?, 'trigger', 'manual', ?, ?, ?, ?, ?, ?, '2026-03-30 08:00:00', ?, ?, ?)`,
    )
    .run(
      id,
      `name-${id}`,
      `describes ${id}`,
      c.version,
      c.output,
      c.inputs,
      c.certified,
      c.active,
      c.failures,
      c.lastUsed,
      c.useCount,
      c.successCount,
    );
}

function testRun(skillId: string, ranAt: string, result = "pass"): void {
  getDatabase()
    .prepare(
      `INSERT INTO skill_test_runs (skill_id, version_id, test_name, ran_at, result)
       VALUES (?, 1, 'case', ?, ?)`,
    )
    .run(skillId, ranAt, result);
}

async function describeSkill(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await skillDescribeTool.execute({ name })) as Record<string, unknown>;
}

beforeEach(() => {
  initDatabase(":memory:");
  // Inserted above-first so row order and id order disagree.
  skill("sk-c", {
    version: "3.0.0", output: "json", inputs: '[{"name":"in_c"}]', certified: 0, active: 1,
    failures: 1, lastUsed: "2026-04-09 09:00:00", useCount: 30, successCount: 20,
  });
  skill("sk-a", {
    version: "2.0.0", output: "markdown", inputs: '[{"name":"in_a"}]', certified: 0, active: 1,
    failures: 2, lastUsed: "2026-04-08 09:00:00", useCount: 40, successCount: 10,
  });
  skill("sk-b", {
    version: "1.4.0", output: "table", inputs: '[{"name":"in_b"}]', certified: 1, active: 0,
    failures: 4, lastUsed: "2026-04-07 09:00:00", useCount: 7, successCount: 5,
  });
  // Newest run of sk-b is 04-03 (not its last row) and failed, unlike its
  // older runs, so the newest run counts whatever its result; both
  // neighbours ran later.
  testRun("sk-b", "2026-04-01 10:00:00");
  testRun("sk-b", "2026-04-03 10:00:00", "fail");
  testRun("sk-b", "2026-04-02 10:00:00");
  testRun("sk-a", "2026-04-05 10:00:00");
  testRun("sk-c", "2026-04-04 10:00:00");
});
afterEach(() => closeDatabase());

describe("skill_describe", () => {
  it("reports the described skill's own columns and its newest test run", async () => {
    expect(await describeSkill("name-sk-b")).toEqual({
      ok: true,
      skill: {
        name: "name-sk-b",
        description: "describes sk-b",
        version: "1.4.0",
        inputs: [{ name: "in_b" }],
        output_type: "table",
        is_certified: true,
        active: false,
        use_count: 7,
        success_count: 5,
        consecutive_failures: 4,
        last_test_run_at: "2026-04-03 10:00:00",
        last_used: "2026-04-07 09:00:00",
      },
    });
  });

  it("a skill with no test run reports null, not a neighbour's run", async () => {
    getDatabase().prepare("DELETE FROM skill_test_runs WHERE skill_id = 'sk-b'").run();
    const got = (await describeSkill("sk-b")) as { skill: Record<string, unknown> };
    expect(got.skill.last_test_run_at).toBeNull();
  });
});
