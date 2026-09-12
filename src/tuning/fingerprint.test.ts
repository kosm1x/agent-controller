import { describe, expect, it } from "vitest";
import { overriddenGroups, scopeFingerprint } from "./fingerprint.js";
import { CODE_SCOPE_PATTERNS, DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";

const code = [
  { pattern: /\bgmail\b/i, group: "google" },
  { pattern: /\bcalendar\b/i, group: "google" },
  { pattern: /\bgit\b/i, group: "coding" },
  { pattern: /\bverifica\b/i, group: "utility" },
];

describe("scopeFingerprint", () => {
  it("is deterministic and independent of group order", () => {
    expect(scopeFingerprint(["google", "coding"], code)).toBe(
      scopeFingerprint(["coding", "google", "google"], code),
    );
  });

  it("changes when a code pattern of an overridden group changes", () => {
    const before = scopeFingerprint(["google"], code);
    const after = scopeFingerprint(["google"], [
      { pattern: /\bgmail|correo\b/i, group: "google" },
      ...code.slice(1),
    ]);
    expect(after).not.toBe(before);
  });

  it("ignores changes to groups the variant does not override", () => {
    const before = scopeFingerprint(["google"], code);
    const after = scopeFingerprint(["google"], [
      ...code.slice(0, 3),
      { pattern: /\bverifica|comprueba\b/i, group: "utility" },
    ]);
    expect(after).toBe(before);
  });

  it("defaults to the pristine CODE_SCOPE_PATTERNS, which is frozen and equals the module defaults at load", () => {
    expect(Object.isFrozen(CODE_SCOPE_PATTERNS)).toBe(true);
    expect(CODE_SCOPE_PATTERNS.map((p) => [p.group, String(p.pattern)])).toEqual(
      DEFAULT_SCOPE_PATTERNS.map((p) => [p.group, String(p.pattern)]),
    );
    expect(scopeFingerprint(["utility"])).toBe(scopeFingerprint(["utility"], CODE_SCOPE_PATTERNS));
  });

  it("overriddenGroups dedupes and sorts", () => {
    expect(overriddenGroups([{ group: "b" }, { group: "a" }, { group: "b" }])).toEqual(["a", "b"]);
    expect(overriddenGroups(undefined)).toEqual([]);
  });
});
