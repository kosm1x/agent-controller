import { describe, it, expect } from "vitest";
import { createSignalIntelligence } from "./signal-intelligence.js";

// 2026-11-20: Step 2 was titled "3 parallel scans" over a list of seven
// searches, and Step 0 said to "only supplement with web searches for gaps";
// the runs that ended with concerns ran fewer exa_search calls than the list
// holds. These tests pin the intent, not the sentences: the title's count
// matches the list, the title and the lead tell the model to run all of them,
// and no sentence makes the searches conditional on gaps.

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
/** The count written directly before the word "searches" (digit or word). */
const COUNT_RE = new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\s+searches\\b`, "i");
/** A statement that every listed search runs: "run every one", "run all seven searches", "every one of". */
const RUN_ALL_RE = /\brun(?:ning)?\s+(?:every|all|each)\b|\bevery\s+one\b|\ball\s+(?:\w+\s+)?searches\b/i;
/** The old conditional: searches only to fill gaps in the depot. */
const ONLY_FOR_GAPS_RE = /only\s+supplement|\bonly\b[^.\n]*\bfor\s+gaps\b/i;

const toNumber = (token: string): number =>
  /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token.toLowerCase()]!;
const countIn = (text: string): number | null => {
  const m = COUNT_RE.exec(text);
  return m ? toNumber(m[1]!) : null;
};

const prompt = (): string => createSignalIntelligence("2026-11-20").description;

function step2(): { title: string; lead: string; body: string } {
  const d = prompt();
  const start = d.indexOf("## Step 2:");
  expect(start, "Step 2 heading").toBeGreaterThanOrEqual(0);
  const next = d.indexOf("\n## Step", start + 1);
  const section = d.slice(start, next === -1 ? undefined : next);
  const [titleLine, ...rest] = section.split("\n");
  const lead = rest.find((l) => l.trim() !== "") ?? "";
  return { title: titleLine!.slice("## Step 2:".length), lead, body: rest.join("\n") };
}

/** Numbered search items, grouped under the tool named by the `Use <tool>` line above them. */
function listedSearches(body: string): Array<{ n: number; tool: string }> {
  const items: Array<{ n: number; tool: string }> = [];
  let tool = "";
  for (const line of body.split("\n")) {
    const use = /^Use (\w+)/.exec(line);
    if (use) tool = use[1]!;
    const item = /^(\d+)\. /.exec(line);
    if (item) items.push({ n: Number(item[1]), tool });
  }
  return items;
}

describe("createSignalIntelligence — Step 2 runs every listed search", () => {
  it("the title's count equals the number of listed searches", () => {
    const { title, body } = step2();
    const count = countIn(title);
    expect(count, `no "<N> searches" in Step 2 title: ${title}`).not.toBeNull();
    expect(count).toBe(listedSearches(body).length);
  });

  it("the title and the lead both say to run all of the searches", () => {
    const { title, lead } = step2();
    expect(title).toMatch(RUN_ALL_RE);
    expect(lead).toMatch(RUN_ALL_RE);
  });

  it("a count stated in the lead equals the list (no count is fine)", () => {
    const { lead, body } = step2();
    const count = countIn(lead);
    if (count !== null) expect(count).toBe(listedSearches(body).length);
  });

  it("no sentence makes the searches conditional on gaps in the depot", () => {
    expect(prompt()).not.toMatch(ONLY_FOR_GAPS_RE);
  });

  it("the searches are numbered 1..N in order", () => {
    const searches = listedSearches(step2().body);
    expect(searches.map((s) => s.n)).toEqual(searches.map((_, i) => i + 1));
  });

  it("lists four exa_search and three web_search searches", () => {
    const searches = listedSearches(step2().body);
    expect(searches.filter((s) => s.tool === "exa_search")).toHaveLength(4);
    expect(searches.filter((s) => s.tool === "web_search")).toHaveLength(3);
  });
});
