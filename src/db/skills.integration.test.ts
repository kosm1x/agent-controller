/**
 * Skills registry on the real schema through initDatabase(":memory:"): the
 * `name` UNIQUE that drives the upsert, the NOT NULL JSON columns and the
 * usage counters that `getUnderperformingSkills` divides only exist in the
 * real table, so every statement of the module runs against it here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "./index.js";
import {
  saveSkill,
  getSkill,
  listSkills,
  incrementSkillUsage,
  deactivateSkill,
  getUnderperformingSkills,
  findSkillsByKeywords,
} from "./skills.js";
import type { SkillInput } from "./skills.js";

const OLD = "2000-01-01 00:00:00";

function input(name: string, over: Partial<SkillInput> = {}): SkillInput {
  return {
    name,
    description: `does ${name}`,
    trigger: `when ${name}`,
    steps: ["first", "second"],
    tools: ["tool_a"],
    ...over,
  };
}

/** Set the usage counters directly so rates are exact. */
function setUsage(skillId: string, uses: number, successes: number): void {
  db.prepare(
    "UPDATE skills SET use_count = ?, success_count = ? WHERE skill_id = ?",
  ).run(uses, successes, skillId);
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("saveSkill / getSkill", () => {
  it("inserts one row with JSON steps and tools, defaults, and returns its skill_id", () => {
    const id = saveSkill(input("weekly review"));
    const row = db.prepare("SELECT * FROM skills").all();
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      skill_id: id,
      name: "weekly review",
      description: "does weekly review",
      trigger_text: "when weekly review",
      steps: '["first","second"]',
      tools: '["tool_a"]',
      source: "manual",
      active: 1,
      use_count: 0,
      success_count: 0,
      last_used: null,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getSkill("weekly review")?.skill_id).toBe(id);
    expect(getSkill(id)?.name).toBe("weekly review");
    expect(getSkill("missing")).toBeNull();
  });

  // A second save of the same name updates the content columns in place: the
  // skill keeps its id and its usage counters.
  it("a second save of the same name keeps id and counters, replaces content", () => {
    const id = saveSkill(input("triage"));
    setUsage(id, 7, 5);
    db.prepare("UPDATE skills SET updated_at = ? WHERE skill_id = ?").run(
      OLD,
      id,
    );
    const again = saveSkill(
      input("triage", {
        description: "new description",
        trigger: "new trigger",
        steps: ["only"],
        tools: [],
        source: "refined",
      }),
    );
    expect(again).toBe(id);
    const rows = db.prepare("SELECT * FROM skills").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skill_id: id,
      description: "new description",
      trigger_text: "new trigger",
      steps: '["only"]',
      tools: "[]",
      source: "refined",
      use_count: 7,
      success_count: 5,
    });
    expect((rows[0] as { updated_at: string }).updated_at).not.toBe(OLD);
  });

  it.todo(
    "a second save of a deactivated skill reactivates it, as the deactivate tool's description says",
  );
});

describe("listSkills", () => {
  it("orders by use_count descending and filters on the active flag", () => {
    const a = saveSkill(input("alpha"));
    const b = saveSkill(input("bravo"));
    const c = saveSkill(input("charlie"));
    setUsage(a, 1, 0);
    setUsage(b, 9, 0);
    setUsage(c, 5, 0);
    deactivateSkill(c);
    expect(listSkills().map((s) => s.name)).toEqual([
      "bravo",
      "charlie",
      "alpha",
    ]);
    expect(listSkills({ active: true }).map((s) => s.name)).toEqual([
      "bravo",
      "alpha",
    ]);
    expect(listSkills({ active: false }).map((s) => s.name)).toEqual([
      "charlie",
    ]);
  });
});

describe("incrementSkillUsage / deactivateSkill", () => {
  it("a success bumps both counters and stamps last_used; a failure bumps use_count only", () => {
    const ok = saveSkill(input("ok"));
    const bad = saveSkill(input("bad"));
    incrementSkillUsage(ok, true);
    incrementSkillUsage(ok, true);
    incrementSkillUsage(bad, false);
    expect(getSkill(ok)).toMatchObject({ use_count: 2, success_count: 2 });
    const stamp = db
      .prepare("SELECT last_used FROM skills WHERE skill_id = ?")
      .get(ok) as { last_used: string };
    expect(stamp.last_used).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(getSkill(bad)).toMatchObject({
      use_count: 1,
      success_count: 0,
      last_used: null,
    });
  });

  it("touches only the named skill", () => {
    const a = saveSkill(input("alpha"));
    const b = saveSkill(input("bravo"));
    incrementSkillUsage(a, true);
    deactivateSkill(a);
    expect(getSkill(a)).toMatchObject({ use_count: 1, active: 0 });
    expect(getSkill(b)).toMatchObject({ use_count: 0, active: 1 });
  });
});

describe("getUnderperformingSkills", () => {
  it("returns active skills at or above minUses below the rate, worst first", () => {
    const rates: Array<[string, number, number, boolean]> = [
      ["quarter", 4, 1, true], // 0.25 — in
      ["three-quarters", 4, 3, true], // 0.75 — above the rate
      ["too-few", 2, 0, true], // below minUses
      ["inactive", 5, 0, false], // inactive
      ["zero", 10, 0, true], // 0.0 — in, worst
      ["boundary", 3, 1, true], // exactly minUses, 0.33 — in
    ];
    for (const [name, uses, successes, active] of rates) {
      const id = saveSkill(input(name));
      setUsage(id, uses, successes);
      if (!active) deactivateSkill(id);
    }
    expect(getUnderperformingSkills(3, 0.5).map((s) => s.name)).toEqual([
      "zero",
      "quarter",
      "boundary",
    ]);
  });
});

describe("findSkillsByKeywords", () => {
  it("matches any long keyword in trigger_text or name, ignoring case, active only, top three by use", () => {
    const rows: Array<[string, string, number, boolean]> = [
      ["Weekly Review", "plan the week", 1, true],
      ["inbox", "Clean the INBOX daily", 5, true],
      ["budget", "monthly budget check", 3, true],
      ["review-old", "weekly digest", 9, false],
      ["calendar", "weekly calendar sweep", 2, true],
      ["unrelated", "nothing here", 50, true],
    ];
    for (const [name, trigger, uses, active] of rows) {
      const id = saveSkill(input(name, { trigger }));
      setUsage(id, uses, 0);
      if (!active) deactivateSkill(id);
    }
    expect(
      findSkillsByKeywords("weekly inbox budget").map((s) => s.name),
    ).toEqual(["inbox", "budget", "calendar"]);
    expect(findSkillsByKeywords("REVIEW").map((s) => s.name)).toEqual([
      "Weekly Review",
    ]);
    expect(findSkillsByKeywords("do it now")).toEqual([]);
  });
});
