/**
 * `skills/storage` statements on the real schema (`initDatabase(":memory:")`),
 * asserting the exact row each statement reads or writes — and neighbouring
 * rows on both sides of the key that must stay out of the result or as they
 * were. Only the SQL storage helpers are called: no critic, no embedding, no
 * knowledge-base file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import type { ParsedSkill } from "./frontmatter.js";
import {
  currentSkillVersion,
  ensureSkillRow,
  pointSkillAtVersion,
  recordVersion,
  sha256,
} from "./storage.js";

function fm(name: string, version = "1.0.0"): ParsedSkill {
  return {
    name,
    description: `Describes ${name} ${version}`,
    version,
    output_type: "text",
    trigger_examples: [`first trigger of ${name}`, `second trigger of ${name}`],
    tools_used: [`tool_${name}`],
    inputs_json: `[{"name":"in_${name}_${version}","type":"string","required":true}]`,
    tests_json: `[{"name":"t_${name}_${version}","input":{},"expect":{}}]`,
  };
}

function skillRow(skillId: string): Record<string, unknown> {
  return getDatabase()
    .prepare("SELECT * FROM skills WHERE skill_id = ?")
    .get(skillId) as Record<string, unknown>;
}

/** A `skill_versions` row written directly, so seeds do not depend on the
 *  statement under test. */
function seedVersion(skillId: string, version: string, body: string): number {
  const info = getDatabase()
    .prepare(
      `INSERT INTO skill_versions
         (skill_id, version, body, body_sha256, inputs_json, tests_json,
          tools_used_json, created_by)
       VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'boot-scan')`,
    )
    .run(skillId, version, body, sha256(body));
  return Number(info.lastInsertRowid);
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("ensureSkillRow", () => {
  // A new skill row carries the frontmatter field by field (description and
  // trigger text are both free text, so a mix-up would still insert); the
  // first trigger example is the row's trigger text. Skills named on either
  // side of the new name are not mistaken for it and stay as they were, and a
  // second call returns the same row unchanged (body_path is stamped once).
  it("creates the row with each frontmatter field in its own column", () => {
    const charlie = ensureSkillRow(fm("charlie"), "skills/charlie/SKILL.md");
    const alpha = ensureSkillRow(fm("alpha"), "skills/alpha/SKILL.md");
    const before = [skillRow(charlie), skillRow(alpha)];
    const id = ensureSkillRow(fm("bravo"), "skills/bravo/SKILL.md");
    expect([charlie, alpha]).not.toContain(id);
    expect(skillRow(id)).toMatchObject({
      skill_id: id,
      name: "bravo",
      description: "Describes bravo 1.0.0",
      trigger_text: "first trigger of bravo",
      steps: "[]",
      tools: "[]",
      source: "manual",
      version: "1.0.0",
      inputs_json: '[{"name":"in_bravo_1.0.0","type":"string","required":true}]',
      output_type: "text",
      trigger_examples_json: JSON.stringify([
        "first trigger of bravo",
        "second trigger of bravo",
      ]),
      tests_json: '[{"name":"t_bravo_1.0.0","input":{},"expect":{}}]',
      body_path: "skills/bravo/SKILL.md",
    });
    expect([skillRow(charlie), skillRow(alpha)]).toEqual(before);
    expect(ensureSkillRow(fm("bravo"), "skills/other/SKILL.md")).toBe(id);
    expect(skillRow(id).body_path).toBe("skills/bravo/SKILL.md");
  });
});

describe("recordVersion", () => {
  // The lookup is by THIS skill and THIS version: the same version of a
  // neighbouring skill (on either side of the id), or a neighbouring version
  // of this skill, is neither "unchanged" nor "drift".
  it("compares only against the same skill's same version", () => {
    seedVersion("sk-a", "1.0.0", "body a 1.0.0");
    seedVersion("sk-a", "1.5.0", "body a 1.5.0");
    seedVersion("sk-b", "1.0.0", "body b 1.0.0");
    seedVersion("sk-b", "2.0.0", "body b 2.0.0");
    seedVersion("sk-c", "1.5.0", "body c 1.5.0");

    expect(
      recordVersion({
        skillId: "sk-b",
        fm: fm("bravo", "1.0.0"),
        body: "body b 1.0.0",
        createdBy: "operator",
        criticVerdict: "pass",
        criticCritique: null,
      }),
    ).toEqual({ kind: "unchanged" });
    expect(
      recordVersion({
        skillId: "sk-b",
        fm: fm("bravo", "1.0.0"),
        body: "edited body",
        createdBy: "operator",
        criticVerdict: "pass",
        criticCritique: null,
      }),
    ).toEqual({ kind: "drift", existingSha: sha256("body b 1.0.0") });

    const out = recordVersion({
      skillId: "sk-b",
      fm: fm("bravo", "1.5.0"),
      body: "body b 1.5.0",
      createdBy: "refiner",
      criticVerdict: "fail_returned_anyway",
      criticCritique: "critique text",
    });
    expect(out.kind).toBe("inserted");
    const versionId = out.kind === "inserted" ? out.versionId : -1;
    expect(
      getDatabase().prepare("SELECT * FROM skill_versions WHERE id = ?").get(versionId),
    ).toMatchObject({
      skill_id: "sk-b",
      version: "1.5.0",
      body: "body b 1.5.0",
      body_sha256: sha256("body b 1.5.0"),
      inputs_json: '[{"name":"in_bravo_1.5.0","type":"string","required":true}]',
      tests_json: '[{"name":"t_bravo_1.5.0","input":{},"expect":{}}]',
      tools_used_json: JSON.stringify(["tool_bravo"]),
      created_by: "refiner",
      critic_verdict: "fail_returned_anyway",
      critic_critique: "critique text",
    });
  });
});

describe("pointSkillAtVersion", () => {
  // Points ONE skill at its new version, refreshes its frontmatter fields,
  // decertifies it and stamps updated_at; the other skills' rows stay exactly
  // as they were. skill_id is a random UUID, so the target is the middle id
  // after sorting — a neighbour on each side of the key.
  it("updates only the named skill", () => {
    const [lo, mid, hi] = [
      ensureSkillRow(fm("alpha"), null),
      ensureSkillRow(fm("bravo"), null),
      ensureSkillRow(fm("charlie"), null),
    ].sort();
    const OLD = "2000-01-01 00:00:00";
    getDatabase().prepare("UPDATE skills SET is_certified = 1, updated_at = ?").run(OLD);
    const before = [skillRow(lo), skillRow(hi)];
    const versionId = seedVersion(mid, "2.0.0", "body bravo 2.0.0");
    const next: ParsedSkill = { ...fm("bravo", "2.0.0"), output_type: "json" };
    next.trigger_examples = ["replacement trigger"];

    pointSkillAtVersion(mid, next, versionId);

    expect(skillRow(mid).updated_at).not.toBe(OLD);
    expect(skillRow(mid)).toMatchObject({
      description: "Describes bravo 2.0.0",
      version: "2.0.0",
      inputs_json: '[{"name":"in_bravo_2.0.0","type":"string","required":true}]',
      output_type: "json",
      trigger_examples_json: JSON.stringify(["replacement trigger"]),
      tests_json: '[{"name":"t_bravo_2.0.0","input":{},"expect":{}}]',
      current_version_id: versionId,
      is_certified: 0,
    });
    expect([skillRow(lo), skillRow(hi)]).toEqual(before);
  });
});

describe("currentSkillVersion", () => {
  // Answers for the named skill only: a name on either side of a seeded one,
  // or a skill with no current version, has no current version.
  it("returns the named skill's current version, and null otherwise", () => {
    const names = ["charlie", "alpha", "echo", "bravo"];
    const versions: Record<string, string> = {
      charlie: "3.0.0",
      alpha: "1.0.0",
      echo: "4.0.0",
    };
    for (const name of names) {
      const id = ensureSkillRow(fm(name), null);
      const v = versions[name];
      if (v) pointSkillAtVersion(id, fm(name, v), seedVersion(id, v, `body ${name}`));
    }
    expect(currentSkillVersion("charlie")).toBe("3.0.0");
    expect(currentSkillVersion("alpha")).toBe("1.0.0");
    expect(currentSkillVersion("echo")).toBe("4.0.0");
    expect(currentSkillVersion("bravo")).toBeNull(); // no current version
    expect(currentSkillVersion("aaa")).toBeNull(); // below every name
    expect(currentSkillVersion("delta")).toBeNull(); // between two names
    expect(currentSkillVersion("zulu")).toBeNull(); // above every name
  });
});
