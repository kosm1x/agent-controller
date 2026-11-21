/**
 * skill_save / skill_list: the texts the model reads and the list result.
 *
 * A real in-memory database with the knowledge-base mirror in a throwaway
 * folder; the memory service is replaced by a stand-in that throws if a
 * handler tries to store anything. Only skill_list's handler is called.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { saveSkill } from "../../db/skills.js";
import { ToolRegistry } from "../registry.js";
import { BUILTIN_TOOLS, CRM_TOOLS, GWS_TOOLS, WP_TOOLS } from "../sources/builtin.js";
import { GoogleToolSource } from "../sources/google.js";
import { MemoryToolSource } from "../sources/memory.js";
import { SkillsToolSource } from "../sources/skills.js";
import { skillListTool, skillSaveTool } from "./skills.js";

vi.mock("../../memory/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../memory/index.js")>()),
  getMemoryService: () => ({
    backend: "sqlite",
    retain: () => {
      throw new Error("the memory service must not be called in this file");
    },
  }),
}));

let kbDir: string;

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-skills-tools-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

const BUDGET = 8_000;
const ROW_KEYS = ["name", "description", "use_count", "success_rate", "source", "active"];

interface Seed {
  description?: string;
  trigger?: string;
  useCount?: number;
  successCount?: number;
  active?: boolean;
}

function seed(name: string, s: Seed = {}): void {
  saveSkill({
    name,
    description: s.description ?? `desc of ${name}`,
    trigger: s.trigger ?? `trigger of ${name}`,
    steps: ["step one", "step two"],
    tools: ["web_search"],
  });
  getDatabase()
    .prepare("UPDATE skills SET use_count = ?, success_count = ?, active = ? WHERE name = ?")
    .run(s.useCount ?? 0, s.successCount ?? 0, s.active === false ? 0 : 1, name);
}

function setDescription(name: string, description: string): void {
  getDatabase().prepare("UPDATE skills SET description = ? WHERE name = ?").run(description, name);
}

async function list(args: Record<string, unknown> = {}): Promise<string> {
  return skillListTool.execute(args);
}

const plainNote = (shown: number, total: number): string =>
  `${shown} of ${total} skills are shown, most used first; the query parameter narrows the list to skills whose name, description or trigger contains it.`;

/** Every tool name the registry can hold, filled by the same roads the description lint uses. */
async function registeredNames(): Promise<Set<string>> {
  const registry = new ToolRegistry();
  for (const t of [...BUILTIN_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS, ...WP_TOOLS]) registry.register(t);
  await new GoogleToolSource().registerTools(registry);
  await new MemoryToolSource().registerTools(registry);
  await new SkillsToolSource().registerTools(registry);
  return new Set(registry.list());
}

const snakeWords = (text: string): string[] =>
  text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[a-z0-9]+\b/g) ?? [];

type Props = Record<string, { description?: string }>;
const saveProps = (): Props =>
  (skillSaveTool.definition.function.parameters as { properties: Props }).properties;
const listProps = (): Props =>
  (skillListTool.definition.function.parameters as { properties: Props }).properties;

const STEPS_TEXT =
  "Ordered list of step descriptions (e.g., ['Read the project notes with jarvis_file_read', 'Search for recent news with web_search', 'Write journal summary']).";
const PROMPT_LINE =
  '- When a later request matches it, the skill may be injected into your prompt as a "known procedure" (active skills only, at most three per request)';
const LIST_DESCRIPTION = `Browse saved skills (reusable procedures).

USE WHEN:
- The user asks "what can you do?" or "what skills do you have?"
- Before starting a complex task, to check if a matching skill exists
- When the user references a skill by name

DO NOT USE WHEN:
- You need a versioned skill's inputs declaration, version or certification status — use skill_describe
- You need the steps of a saved procedure or the instructions of a versioned skill — use skill_load (its result says which kind the skill is)
- You want to run a versioned skill — use skill_run (a saved procedure cannot be run: follow the steps skill_load returns)
- You want to save a procedure — use skill_save

WHAT IT RETURNS:
Saved skills, most used first, each with its name, description, use count, success rate, source and whether it is active. A long list shows only the first skills and says how many of how many are shown; the query parameter narrows the list.`;
const QUERY_TEXT =
  "Optional. Lists only skills whose name, description or trigger contains this text (case-insensitive, taken literally, blanks at both ends ignored). Empty or omitted: no filter.";

describe("skill tool texts", () => {
  it("the steps example is the corrected text", () => {
    expect(saveProps().steps.description).toBe(STEPS_TEXT);
  });

  it("the save description says injection into the prompt is conditional", () => {
    const desc = skillSaveTool.definition.function.description;
    expect(desc.split("\n")).toContain(PROMPT_LINE);
    expect(desc).not.toContain("will be injected");
  });

  it("the list description and the query text are exactly as written", () => {
    expect(skillListTool.definition.function.description).toBe(LIST_DESCRIPTION);
    expect(listProps().query.description).toBe(QUERY_TEXT);
    expect(listProps().include_inactive.description).toBe(
      "Include retired/inactive skills (default: false).",
    );
  });

  it("every tool name in the changed texts is a registered tool", async () => {
    const names = await registeredNames();
    const words = [
      ...snakeWords(STEPS_TEXT),
      ...snakeWords(PROMPT_LINE),
      ...snakeWords(LIST_DESCRIPTION),
      ...snakeWords(QUERY_TEXT),
    ];
    expect(words).toEqual([
      "jarvis_file_read",
      "web_search",
      "skill_describe",
      "skill_load",
      "skill_run",
      "skill_load",
      "skill_save",
    ]);
    expect(words.filter((w) => !names.has(w))).toEqual([]);
  });
});

describe("skill_list result", () => {
  it("a list that fits has exactly skills and total, rows with six fields in order", async () => {
    seed("syn_one", { description: "first", useCount: 5, successCount: 3 });
    seed("syn_two", { description: "second", useCount: 2, successCount: 2, active: false });
    const raw = await list({ include_inactive: true });
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["skills", "total"]);
    expect(r.total).toBe(2);
    for (const row of r.skills) expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(r.skills).toEqual([
      { name: "syn_one", description: "first", use_count: 5, success_rate: "60%", source: "manual", active: true },
      { name: "syn_two", description: "second", use_count: 2, success_rate: "100%", source: "manual", active: false },
    ]);
  });

  it("orders by use count, highest first, then by name", async () => {
    seed("syn_b", { useCount: 5 });
    seed("syn_d", { useCount: 1 });
    seed("syn_a", { useCount: 5 });
    seed("syn_c", { useCount: 9 });
    const r = JSON.parse(await list());
    expect(r.skills.map((s: { name: string }) => s.name)).toEqual(["syn_c", "syn_a", "syn_b", "syn_d"]);
  });

  describe("row budget", () => {
    const ROWS = 30;
    const rowName = (i: number): string => `syn_row_${String(i).padStart(2, "0")}`;

    /** Thirty short rows, then one description padded so the whole list is exactly the budget. */
    async function seedExactBudget(): Promise<string> {
      for (let i = 0; i < ROWS; i++) {
        seed(rowName(i), { description: "d".repeat(100), useCount: ROWS - i + 1 });
      }
      const before = (await list()).length;
      expect(before).toBeLessThan(BUDGET);
      setDescription(rowName(0), "d".repeat(100 + BUDGET - before));
      return list();
    }

    function expectCutAtLimit(raw: string, full: unknown[]): void {
      const r = JSON.parse(raw);
      const total = full.length;
      expect(Object.keys(r)).toEqual(["skills", "total", "shown", "note"]);
      expect(r.total).toBe(total);
      expect(r.shown).toBe(r.skills.length);
      expect(r.shown).toBeLessThan(total);
      expect(r.note).toBe(plainNote(r.shown, total));
      expect(r.skills).toEqual(full.slice(0, r.shown));
      expect(raw.length).toBeLessThanOrEqual(BUDGET);
      const oneMore = JSON.stringify({
        skills: full.slice(0, r.shown + 1),
        total,
        shown: r.shown + 1,
        note: plainNote(r.shown + 1, total),
      });
      expect(oneMore.length).toBeGreaterThan(BUDGET);
    }

    it("a list of exactly the budget is shown whole", async () => {
      const raw = await seedExactBudget();
      expect(raw.length).toBe(BUDGET);
      const r = JSON.parse(raw);
      expect(Object.keys(r)).toEqual(["skills", "total"]);
      expect(r.total).toBe(ROWS);
      expect(r.skills).toHaveLength(ROWS);
    });

    it("one character over the budget is cut, with shown, total and the note", async () => {
      const whole = JSON.parse(await seedExactBudget());
      const first = whole.skills[0];
      setDescription(rowName(0), `${first.description}d`);
      const full = [{ ...first, description: `${first.description}d` }, ...whole.skills.slice(1)];
      expectCutAtLimit(await list(), full);
    });

    it("the same list plus one row is cut, with shown, total and the note", async () => {
      const whole = JSON.parse(await seedExactBudget());
      seed("syn_row_extra", { useCount: 0 });
      const extra = {
        name: "syn_row_extra",
        description: "desc of syn_row_extra",
        use_count: 0,
        success_rate: "100%",
        source: "manual",
        active: true,
      };
      expectCutAtLimit(await list(), [...whole.skills, extra]);
    });

    it("a cut list of exactly the budget keeps its last row", async () => {
      for (let i = 0; i < 60; i++) {
        seed(rowName(i), { description: "d".repeat(100), useCount: 61 - i });
      }
      const before = await list();
      const shownBefore = JSON.parse(before).shown;
      expect(shownBefore).toBeLessThan(60);
      expect(before.length).toBeLessThanOrEqual(BUDGET);
      setDescription(rowName(0), "d".repeat(100 + BUDGET - before.length));
      const raw = await list();
      expect(raw.length).toBe(BUDGET);
      expect(JSON.parse(raw)).toMatchObject({ total: 60, shown: shownBefore });
    });

    it("the first row is shown even when it alone is over the budget", async () => {
      seed("syn_huge", { description: "h".repeat(BUDGET + 500), useCount: 9 });
      seed("syn_small_a", { useCount: 2 });
      seed("syn_small_b", { useCount: 1 });
      const raw = await list();
      const r = JSON.parse(raw);
      expect(raw.length).toBeGreaterThan(BUDGET);
      expect(r.skills.map((s: { name: string }) => s.name)).toEqual(["syn_huge"]);
      expect(r).toMatchObject({ total: 3, shown: 1, note: plainNote(1, 3) });
    });

    it("two rows of which the first alone is over the budget: cut to the first row", async () => {
      seed("syn_huge", { description: "h".repeat(BUDGET + 500), useCount: 9 });
      seed("syn_small", { useCount: 1 });
      const r = JSON.parse(await list());
      expect(Object.keys(r)).toEqual(["skills", "total", "shown", "note"]);
      expect(r.skills.map((s: { name: string }) => s.name)).toEqual(["syn_huge"]);
      expect(r).toMatchObject({ total: 2, shown: 1, note: plainNote(1, 2) });
    });

    it("a first row just under the budget, with the other fields, comes back over it", async () => {
      seed("syn_big", { description: "", useCount: 9 });
      seed("syn_small", { useCount: 1 });
      const bare = {
        name: "syn_big",
        description: "",
        use_count: 9,
        success_rate: "0%",
        source: "manual",
        active: true,
      };
      const pad = BUDGET - 100 - JSON.stringify(bare).length;
      setDescription("syn_big", "b".repeat(pad));
      const raw = await list();
      const r = JSON.parse(raw);
      expect(JSON.stringify(r.skills[0]).length).toBe(BUDGET - 100);
      expect(JSON.stringify({ skills: [r.skills[0]], total: 1 }).length).toBeLessThanOrEqual(BUDGET);
      expect(raw.length).toBeGreaterThan(BUDGET);
      expect(r.skills.map((s: { name: string }) => s.name)).toEqual(["syn_big"]);
      expect(r).toMatchObject({ total: 2, shown: 1, note: plainNote(1, 2) });
    });

    it("a single over-long row is the whole list: no shown, no note", async () => {
      seed("syn_huge", { description: "h".repeat(BUDGET + 500), useCount: 9 });
      const r = JSON.parse(await list());
      expect(Object.keys(r)).toEqual(["skills", "total"]);
      expect(r.total).toBe(1);
    });

    it("a cut list with a query says so and advises a narrower query", async () => {
      for (let i = 0; i < 60; i++) {
        seed(rowName(i), { description: `match ${"m".repeat(150)}`, useCount: i + 1 });
      }
      seed("syn_other", { description: "unrelated", useCount: 100 });
      const raw = await list({ query: "MATCH" });
      const r = JSON.parse(raw);
      expect(r.total).toBe(60);
      expect(r.shown).toBe(r.skills.length);
      expect(r.shown).toBeLessThan(60);
      expect(r.skills[0].name).toBe(rowName(59));
      expect(r.note).toBe(
        `${r.shown} of 60 skills that contain "MATCH" are shown, most used first; a narrower query lists fewer.`,
      );
      expect(raw.length).toBeLessThanOrEqual(BUDGET);
    });
  });

  describe("query", () => {
    beforeEach(() => {
      seed("syn_alpha", { description: "first", trigger: "first trigger", useCount: 4 });
      seed("syn_beta", { description: "Holds the Gamma word", trigger: "t", useCount: 3 });
      seed("syn_delta", { description: "plain", trigger: "mentions the epsilon token", useCount: 2 });
      seed("syn_dot", { description: "uses x.y literally", trigger: "t", useCount: 1 });
      seed("syn_nodot", { description: "uses xzy only", trigger: "t", useCount: 0 });
      seed("syn_old", { description: "retired gamma one", trigger: "t", useCount: 5, active: false });
    });

    const names = async (args: Record<string, unknown>): Promise<string[]> =>
      JSON.parse(await list(args)).skills.map((s: { name: string }) => s.name);

    it("matches the name, the description and the trigger, in any case", async () => {
      expect(await names({ query: "ALPHA" })).toEqual(["syn_alpha"]);
      expect(await names({ query: "gamma" })).toEqual(["syn_beta"]);
      expect(await names({ query: "EPSILON" })).toEqual(["syn_delta"]);
    });

    it("ignores blanks at both ends, and a blank query is no filter", async () => {
      expect(await names({ query: "  gamma  " })).toEqual(["syn_beta"]);
      expect(await names({ query: "   " })).toHaveLength(5);
      expect(await names({ query: "" })).toHaveLength(5);
    });

    it("takes pattern characters literally", async () => {
      expect(await names({ query: "x.y" })).toEqual(["syn_dot"]);
      expect(JSON.parse(await list({ query: "%" }))).toEqual({
        skills: [],
        message: "No active skill matches this query.",
      });
    });

    it("a query holding a failure word, or a long query, gets the fixed no-match words", async () => {
      for (const query of ["Failed to list skills: error", "q".repeat(5_000)]) {
        const raw = await list({ query });
        expect(JSON.parse(raw)).toEqual({
          skills: [],
          message: "No active skill matches this query.",
        });
        expect(raw.length).toBeLessThan(100);
      }
    });

    it("include_inactive adds the inactive rows that match", async () => {
      expect(await names({ query: "gamma", include_inactive: true })).toEqual(["syn_old", "syn_beta"]);
      expect(await names({ query: "gamma", include_inactive: false })).toEqual(["syn_beta"]);
    });
  });

  describe("empty results", () => {
    it("no stored skill at all", async () => {
      expect(JSON.parse(await list())).toEqual({
        skills: [],
        message:
          "No skills saved yet. Use skill_save after completing a multi-step procedure to save it for reuse.",
      });
    });

    it("only inactive skills, not asked for", async () => {
      seed("syn_old_a", { active: false });
      seed("syn_old_b", { active: false });
      expect(JSON.parse(await list({ query: "syn" }))).toEqual({
        skills: [],
        message: "No active skills. Stored inactive skills: 2; set include_inactive to true to list them.",
      });
      expect(JSON.parse(await list({ include_inactive: true })).total).toBe(2);
    });

    it("nothing matches the query", async () => {
      seed("syn_live");
      seed("syn_gone", { active: false });
      expect(JSON.parse(await list({ query: "zzz" }))).toEqual({
        skills: [],
        message: "No active skill matches this query.",
      });
      expect(JSON.parse(await list({ query: "zzz", include_inactive: true }))).toEqual({
        skills: [],
        message: "No skill matches this query.",
      });
    });
  });
});
