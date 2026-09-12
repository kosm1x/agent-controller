/**
 * The expect grammar and the write-time refusal of an expectation that cannot
 * fail. The refused table is the LIVE ledger of 2026-09-12 (task_gates rows
 * recorded MET in enforce mode); the kept table is every other live shape.
 */
import { describe, expect, it } from "vitest";
import {
  compareNumber,
  isComparatorExpect,
  isUnsettleableExpect,
  lastNumber,
  parseExpect,
  regexNamesALiteral,
} from "./expect.js";

describe("parseExpect", () => {
  it("reads the comparator forms, case-insensitive, with decimals and signs", () => {
    expect(parseExpect("gte 10")).toEqual({ kind: "cmp", op: "gte", value: 10 });
    expect(parseExpect(" GT 0 ")).toEqual({ kind: "cmp", op: "gt", value: 0 });
    expect(parseExpect("lte 3.5")).toEqual({ kind: "cmp", op: "lte", value: 3.5 });
    expect(parseExpect("neq -1")).toEqual({ kind: "cmp", op: "neq", value: -1 });
    expect(parseExpect("between 2 4")).toEqual({ kind: "between", lo: 2, hi: 4 });
  });

  it("keeps regex and substring on the raw text — pre-grammar behaviour", () => {
    expect(parseExpect("/PASS/i")).toEqual({ kind: "regex", pattern: "PASS", flags: "i" });
    expect(parseExpect("8/8 passed")).toEqual({ kind: "substring", text: "8/8 passed" });
    expect(parseExpect(" 200")).toEqual({ kind: "substring", text: " 200" });
    expect(isComparatorExpect("gt 0")).toBe(true);
    expect(isComparatorExpect("Plan de Acción")).toBe(false);
  });
});

describe("lastNumber / compareNumber", () => {
  it("takes the last non-empty line only when it is a bare number", () => {
    expect(lastNumber("header\n  42 \n\n")).toBe(42);
    expect(lastNumber("3.25")).toBe(3.25);
    expect(lastNumber("-7\n")).toBe(-7);
    expect(lastNumber("n = 5")).toBeNull();
    expect(lastNumber("5 rows")).toBeNull();
    expect(lastNumber("1e3")).toBeNull();
    expect(lastNumber("")).toBeNull();
    expect(lastNumber("42\nerror: boom")).toBeNull();
  });

  it("applies every operator; between is inclusive on both ends", () => {
    const c = (s: string, n: number) => {
      const p = parseExpect(s);
      if (p.kind !== "cmp" && p.kind !== "between") throw new Error(s);
      return compareNumber(p, n);
    };
    expect(c("gte 3", 3)).toBe(true);
    expect(c("gte 3", 2.9)).toBe(false);
    expect(c("gt 0", 0)).toBe(false);
    expect(c("gt 0", 0.1)).toBe(true);
    expect(c("lte 2", 2)).toBe(true);
    expect(c("lt 2", 2)).toBe(false);
    expect(c("eq 200", 200)).toBe(true);
    expect(c("eq 200", 201)).toBe(false);
    expect(c("neq 0", 0)).toBe(false);
    expect(c("between 2 4", 2)).toBe(true);
    expect(c("between 2 4", 4)).toBe(true);
    expect(c("between 2 4", 4.01)).toBe(false);
  });
});

describe("isUnsettleableExpect — the live ledger's can't-fail family is refused", () => {
  const refused: Array<[string, RegExp]> = [
    ["/[0-9]/", /names only digits/], // grep -c 'MODEL OUTPUT' … — met by the failure output 0
    ["/[1-9]/", /names only digits/],
    ["/[3-9]/", /names only digits/],
    ["/^[1-9][0-9]*$/m", /names only digits/], // four ritual COUNT(*) rows
    ["/[4-9]|1[0-9]/", /names only digits/],
    ["/\\d+/", /names only digits/],
    ["/^200$/", /names only digits/],
    ["/.*/", /names only digits/],
    ["0", /satisfied by the failure output "0"/],
    ["/(PASS)?/", /satisfied by the failure output ""/], // names a word but matches empty output
    ["/x*/", /satisfied by the failure output ""/],
    ["/ok|/", /satisfied by the failure output ""/],
    ["/0 errors|^0$/", /satisfied by the failure output "0"/],
    ["/^/", /names only digits/],
    ["goes up", /not a test/], // YOINK's own example — not a comparator word, but see below
    ["gte", /not a test/],
    ["gte ten", /not a test/],
    ["between 3", /not a test/],
    ["between 4 2", /empty range/],
    // qa R2 W1: a comparator that 0 and any count both satisfy
    ["gte 0", /cannot fail/],
    ["gt -1", /cannot fail/],
    ["neq -1", /cannot fail/],
    ["GTE 0.0", /cannot fail/],
    ["/(unclosed/", /not a valid/],
    // qa C1: group syntax is not a literal
    ["/^(?:[1-9][0-9]*)$/m", /names only digits/],
    ["/(?:[1-9])/", /names only digits/],
    ["/(?=\\d)\\d+/", /names only digits/],
    // qa C2: complements and escapes that any non-empty output satisfies
    ["/\\D/", /names only digits/],
    ["/[^0-9]/", /names only digits/],
    ["/[^\\d]/", /names only digits/],
    ["/[^0]/", /names only digits/],
    ["/[\\s]/", /names only digits/],
    ["/\\n/", /names only digits/],
    // qa W3/W4: near-misses that would silently become a never-matching substring
    ["/[0-9]/ ", /looks like a \/regex\//],
    ["/ok/I", /looks like a \/regex\//],
    ["gte5", /not a test/],
    ["gt0", /not a test/],
    // nested quantifiers: the runner refuses them, so the gate could never pass
    ["/(a+)+b/", /nested quantifiers/],
  ];
  for (const [text, why] of refused) {
    if (text === "goes up") continue; // plain words are a substring, allowed — pinned in the kept table
    it(`refuses ${JSON.stringify(text)}`, () => {
      expect(isUnsettleableExpect(text)).toMatch(why);
    });
  }

  const kept = [
    "gt 0",
    "gte 3",
    "eq 200",
    "eq 0",
    "lte 0",
    "lt 1",
    "neq 0",
    "between 0 0",
    "between 2 4",
    "lte 999999999",
    "200",
    "10",
    "Plan de Acción",
    "verify",
    "8/8 passed",
    "/Avg Δ/",
    "/[0-9a-f]{7}/",
    "/PASS/i",
    "/8\\/8 passed/",
    "/^w37$/",
    "/\\d+\\.\\d+/", // names a dot — a version string, not a bare count
    "/(?:ok|fail)/",
    "/active|caddy/",
    "/EXISTS|MISSING/",
    "/200.*json/",
    "goes up",
    "equal",
    "gtfo", // not a comparator word followed by a number
  ];
  for (const text of kept) {
    it(`keeps ${JSON.stringify(text)}`, () => {
      expect(isUnsettleableExpect(text)).toBeNull();
    });
  }

  it("mutation pin: /[0-9]/ against the failure output 0 is refused at write time, and gt 0 fails at check time", () => {
    expect(isUnsettleableExpect("/[0-9]/")).not.toBeNull();
    const p = parseExpect("gt 0");
    if (p.kind !== "cmp") throw new Error("gt 0 must parse as a comparator");
    expect(compareNumber(p, lastNumber("0")!)).toBe(false);
  });

  it("the failure-output probe uses the real shell shape (trailing newline) and the sandboxed matcher", () => {
    expect(isUnsettleableExpect("/zero|^0\\n$/")).toMatch(/satisfied by the failure output "0\\n"/);
    // A 420-char alternation bomb must come back bounded, not hang the API loop.
    const bomb = "/" + "(a|a|a|a|a|a|a|a|a|a)".repeat(20) + "/";
    const t0 = Date.now();
    isUnsettleableExpect(bomb);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("regexNamesALiteral strips only the non-literal machinery", () => {
    expect(regexNamesALiteral("(?:[1-9])")).toBe(false);
    expect(regexNamesALiteral("[^0-9]")).toBe(false);
    expect(regexNamesALiteral("\\D")).toBe(false);
    expect(regexNamesALiteral("(?:ok|fail)")).toBe(true);
    expect(regexNamesALiteral("[0-9]")).toBe(false);
    expect(regexNamesALiteral("^[1-9][0-9]*$")).toBe(false);
    expect(regexNamesALiteral("\\d{2,}")).toBe(false);
    expect(regexNamesALiteral("[0-9a-f]{7}")).toBe(true);
    expect(regexNamesALiteral("w3[0-9]")).toBe(true);
    expect(regexNamesALiteral("\\bok\\b")).toBe(true);
  });
});
