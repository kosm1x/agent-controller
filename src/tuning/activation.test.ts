import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getValidVariants, markVariantActivated, deserializeSandbox } = vi.hoisted(() => ({
  getValidVariants: vi.fn(),
  markVariantActivated: vi.fn(),
  deserializeSandbox: vi.fn(),
}));
vi.mock("./schema.js", () => ({ getValidVariants, markVariantActivated }));
vi.mock("./variant-store.js", () => ({ deserializeSandbox }));
vi.mock("../tools/registry.js", () => ({ toolRegistry: { get: () => undefined } }));

import { activateBestVariant, fingerprintVerdict } from "./activation.js";
import { scopeFingerprint } from "./fingerprint.js";
import { DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";

const snapshot = [...DEFAULT_SCOPE_PATTERNS];

beforeEach(() => {
  DEFAULT_SCOPE_PATTERNS.length = 0;
  DEFAULT_SCOPE_PATTERNS.push(...snapshot);
  getValidVariants.mockReset();
  getValidVariants.mockReturnValue([]);
  markVariantActivated.mockReset();
  deserializeSandbox.mockReset();
  delete process.env.TUNING_REQUIRE_FINGERPRINT;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  DEFAULT_SCOPE_PATTERNS.length = 0;
  DEFAULT_SCOPE_PATTERNS.push(...snapshot);
});

describe("activateBestVariant — scope pattern overrides merge by group (2026-09-11)", () => {
  it("replaces only the groups the variant carries and keeps every other group's code defaults", () => {
    const codeGroups = new Set(snapshot.map((p) => p.group));
    expect(codeGroups.has("utility")).toBe(true);
    expect(codeGroups.has("google")).toBe(true);

    getValidVariants.mockReturnValue([{ variant_id: "v1", generation: 0, composite_score: 79.2, config_json: "{}" }]);
    deserializeSandbox.mockReturnValue({
      scopePatternOverrides: [
        { pattern: /\bgmail-from-variant\b/i, group: "google" },
        { pattern: /\bcoding-from-variant\b/i, group: "coding" },
      ],
    });

    const r = activateBestVariant();
    expect(r.activated).toBe(true);
    expect(markVariantActivated).toHaveBeenCalledWith("v1");

    const live = new Map<string, RegExp[]>();
    for (const p of DEFAULT_SCOPE_PATTERNS) live.set(p.group, [...(live.get(p.group) ?? []), p.pattern]);

    // Overridden groups: exactly the variant's patterns.
    expect(live.get("google")?.map(String)).toEqual(["/\\bgmail-from-variant\\b/i"]);
    expect(live.get("coding")?.map(String)).toEqual(["/\\bcoding-from-variant\\b/i"]);
    // Untouched groups: unchanged code defaults, none dropped.
    for (const g of codeGroups) {
      if (g === "google" || g === "coding") continue;
      const before = snapshot.filter((p) => p.group === g).map((p) => String(p.pattern));
      expect(live.get(g)?.map(String), g).toEqual(before);
    }
    expect(new Set(DEFAULT_SCOPE_PATTERNS.map((p) => p.group))).toEqual(codeGroups);
  });

  it("the April-2026 shape (17 groups, no utility) no longer hides email_verify's group", () => {
    const aprilGroups = ["browser", "coding", "crm", "destructive", "google", "intel", "meta", "northstar_journal",
      "northstar_read", "northstar_write", "research", "schedule", "social", "specialty", "teaching", "video", "wordpress"];
    getValidVariants.mockReturnValue([{ variant_id: "var-tune-1775545200807", generation: 0, composite_score: 79.2, config_json: "{}" }]);
    deserializeSandbox.mockReturnValue({ scopePatternOverrides: aprilGroups.map((g) => ({ pattern: new RegExp(`\\b${g}-only\\b`, "i"), group: g })) });
    activateBestVariant();
    const utility = DEFAULT_SCOPE_PATTERNS.filter((p) => p.group === "utility");
    expect(utility.length).toBeGreaterThan(0);
    expect(utility.some((p) => p.pattern.test("verifica si kosmixx@gmail.com existe"))).toBe(true);
  });

  it("does nothing without a variant", () => {
    getValidVariants.mockReturnValue([]);
    expect(activateBestVariant()).toEqual({ activated: false });
    expect(DEFAULT_SCOPE_PATTERNS.length).toBe(snapshot.length);
  });
});

describe("activateBestVariant — code fingerprint drift (2026-09-12)", () => {
  const overrides = [{ pattern: /\bgoogle-from-variant\b/i, group: "google" }];

  it("activates a variant whose fingerprint matches the pristine code patterns", () => {
    getValidVariants.mockReturnValue([
      { variant_id: "fresh", generation: 1, composite_score: 80, config_json: "{}", code_fingerprint: scopeFingerprint(["google"]) },
    ]);
    deserializeSandbox.mockReturnValue({ scopePatternOverrides: overrides });
    const r = activateBestVariant();
    expect(r).toEqual({ activated: true, variantId: "fresh", score: 80 });
    expect(DEFAULT_SCOPE_PATTERNS.filter((p) => p.group === "google").map((p) => String(p.pattern))).toEqual(["/\\bgoogle-from-variant\\b/i"]);
  });

  it("skips a STALE variant (code moved since generation) and falls through to the next match", () => {
    getValidVariants.mockReturnValue([
      { variant_id: "stale-best", generation: 2, composite_score: 90, config_json: "{}", code_fingerprint: "0".repeat(64) },
      { variant_id: "fresh-second", generation: 1, composite_score: 80, config_json: "{}", code_fingerprint: scopeFingerprint(["google"]) },
    ]);
    deserializeSandbox.mockReturnValue({ scopePatternOverrides: overrides });
    const r = activateBestVariant();
    expect(r.activated).toBe(true);
    expect(r.variantId).toBe("fresh-second");
    expect(r.skippedStale).toEqual(["stale-best"]);
    expect(markVariantActivated).toHaveBeenCalledTimes(1);
    expect(markVariantActivated).toHaveBeenCalledWith("fresh-second");
  });

  it("leaves the code defaults untouched when every candidate is stale", () => {
    getValidVariants.mockReturnValue([
      { variant_id: "stale", generation: 2, composite_score: 90, config_json: "{}", code_fingerprint: "0".repeat(64) },
    ]);
    deserializeSandbox.mockReturnValue({ scopePatternOverrides: overrides });
    const r = activateBestVariant();
    expect(r).toEqual({ activated: false, skippedStale: ["stale"] });
    expect(markVariantActivated).not.toHaveBeenCalled();
    expect(DEFAULT_SCOPE_PATTERNS.map((p) => String(p.pattern))).toEqual(snapshot.map((p) => String(p.pattern)));
  });

  it("a legacy row (no fingerprint) activates with a warning by default and is blocked by TUNING_REQUIRE_FINGERPRINT=true", () => {
    const legacy = { variant_id: "april", generation: 0, composite_score: 79, config_json: "{}", code_fingerprint: null };
    getValidVariants.mockReturnValue([legacy]);
    deserializeSandbox.mockReturnValue({ scopePatternOverrides: overrides });
    expect(activateBestVariant().activated).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("UNVERIFIED"));

    DEFAULT_SCOPE_PATTERNS.length = 0;
    DEFAULT_SCOPE_PATTERNS.push(...snapshot);
    markVariantActivated.mockReset();
    process.env.TUNING_REQUIRE_FINGERPRINT = "true";
    const r = activateBestVariant();
    expect(r).toEqual({ activated: false, skippedStale: ["april"] });
    expect(markVariantActivated).not.toHaveBeenCalled();
  });

  it("fingerprintVerdict: a variant with no scope surface always matches", () => {
    expect(fingerprintVerdict({ code_fingerprint: null }, [], true)).toBe("match");
    expect(fingerprintVerdict({ code_fingerprint: null }, ["google"], false)).toBe("legacy");
    expect(fingerprintVerdict({ code_fingerprint: null }, ["google"], true)).toBe("legacy_blocked");
    expect(fingerprintVerdict({ code_fingerprint: scopeFingerprint(["google"]) }, ["google"], true)).toBe("match");
    expect(fingerprintVerdict({ code_fingerprint: "x" }, ["google"], true)).toBe("stale");
  });
});
