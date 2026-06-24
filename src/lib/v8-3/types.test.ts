/**
 * V8.3 types — deriveReversibleDefault (the one behavioral helper in types.ts).
 *
 * `reversible_default` must follow ONLY from a named, concrete reversal mechanism:
 * sql_inverse / delete_inverse / tri_restore are auto-reversible; compensating
 * (operator-confirmed) and none (unknown) are NOT.
 */

import { describe, expect, it } from "vitest";
import { deriveReversibleDefault } from "./types.js";
import type { ReversalStrategy } from "./types.js";

describe("deriveReversibleDefault", () => {
  const cases: Array<[ReversalStrategy, boolean]> = [
    ["sql_inverse", true],
    ["delete_inverse", true],
    ["tri_restore", true],
    ["compensating", false],
    ["none", false],
  ];

  it.each(cases)("%s ⇒ %s", (strategy, expected) => {
    expect(deriveReversibleDefault(strategy)).toBe(expected);
  });

  it("only the three concrete-inverse strategies are auto-reversible", () => {
    const reversible = cases.filter(([, v]) => v).map(([s]) => s);
    expect(reversible.sort()).toEqual(
      ["delete_inverse", "sql_inverse", "tri_restore"].sort(),
    );
  });
});
