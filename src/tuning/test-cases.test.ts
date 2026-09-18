import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnownExpectedKeys, assertScorableCase } from "./test-cases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("assertKnownExpectedKeys (2026-09-18)", () => {
  it("accepts the keys the scorers read", () => {
    expect(() =>
      assertKnownExpectedKeys("ok", {
        scope_groups: ["coding"],
        not_scope_groups: ["social"],
        tools: ["web_search"],
        not_tools: [],
        agent_type: "fast",
      }),
    ).not.toThrow();
  });

  it("refuses a misspelled key instead of scoring it as no-checks", () => {
    expect(() =>
      assertKnownExpectedKeys("sc-x", { scope_groups: [], forbidden_groups: ["wordpress"] }),
    ).toThrow(/sc-x: unknown expected key\(s\) forbidden_groups/);
  });

  it("the shipped seed-cases.json carries only known keys", () => {
    const cases = JSON.parse(
      readFileSync(resolve(__dirname, "seed-cases.json"), "utf-8"),
    ) as Array<{ case_id: string; expected: Record<string, unknown> }>;
    for (const c of cases) assertKnownExpectedKeys(c.case_id, c.expected);
    expect(cases.length).toBeGreaterThan(0);
  });
});

describe("assertScorableCase — an empty check set scores 1 for free (2026-09-18)", () => {
  it("refuses a scope case with no groups and no forbidden groups", () => {
    expect(() =>
      assertScorableCase("sc-empty", "scope_accuracy", { scope_groups: [] }),
    ).toThrow(/sc-empty \(scope_accuracy\): empty check set/);
  });

  it("accepts a scope case that only forbids", () => {
    expect(() =>
      assertScorableCase("sc-neg", "scope_accuracy", {
        scope_groups: [],
        not_scope_groups: ["wordpress"],
      }),
    ).not.toThrow();
  });

  it("refuses tool_selection without tools and classification without agent_type", () => {
    expect(() =>
      assertScorableCase("ts-empty", "tool_selection", { tools: [] }),
    ).toThrow(/empty check set/);
    expect(() => assertScorableCase("cl-empty", "classification", {})).toThrow(
      /empty check set/,
    );
  });

  it("refuses an unknown category (stored active, never scored)", () => {
    expect(() =>
      assertScorableCase("sc-typo", "scope_acuracy", { scope_groups: ["coding"] }),
    ).toThrow(/unknown category "scope_acuracy"/);
  });

  it("still refuses an unknown key", () => {
    expect(() =>
      assertScorableCase("sc-x", "scope_accuracy", { forbidden_groups: ["x"] }),
    ).toThrow(/unknown expected key/);
  });

  it("every shipped seed case is scorable", () => {
    const cases = JSON.parse(
      readFileSync(resolve(__dirname, "seed-cases.json"), "utf-8"),
    ) as Array<{ case_id: string; category: string; expected: Record<string, unknown> }>;
    for (const c of cases) assertScorableCase(c.case_id, c.category, c.expected);
  });
});
