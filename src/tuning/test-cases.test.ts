import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnownExpectedKeys } from "./test-cases.js";

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
