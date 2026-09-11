import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getBestVariant, markVariantActivated, deserializeSandbox } = vi.hoisted(() => ({
  getBestVariant: vi.fn(),
  markVariantActivated: vi.fn(),
  deserializeSandbox: vi.fn(),
}));
vi.mock("./schema.js", () => ({ getBestVariant, markVariantActivated }));
vi.mock("./variant-store.js", () => ({ deserializeSandbox }));
vi.mock("../tools/registry.js", () => ({ toolRegistry: { get: () => undefined } }));

import { activateBestVariant } from "./activation.js";
import { DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";

const snapshot = [...DEFAULT_SCOPE_PATTERNS];

beforeEach(() => {
  DEFAULT_SCOPE_PATTERNS.length = 0;
  DEFAULT_SCOPE_PATTERNS.push(...snapshot);
  getBestVariant.mockReset();
  markVariantActivated.mockReset();
  deserializeSandbox.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
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

    getBestVariant.mockReturnValue({ variant_id: "v1", generation: 0, composite_score: 79.2, config_json: "{}" });
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
    getBestVariant.mockReturnValue({ variant_id: "var-tune-1775545200807", generation: 0, composite_score: 79.2, config_json: "{}" });
    deserializeSandbox.mockReturnValue({ scopePatternOverrides: aprilGroups.map((g) => ({ pattern: new RegExp(`\\b${g}-only\\b`, "i"), group: g })) });
    activateBestVariant();
    const utility = DEFAULT_SCOPE_PATTERNS.filter((p) => p.group === "utility");
    expect(utility.length).toBeGreaterThan(0);
    expect(utility.some((p) => p.pattern.test("verifica si kosmixx@gmail.com existe"))).toBe(true);
  });

  it("does nothing without a variant", () => {
    getBestVariant.mockReturnValue(null);
    expect(activateBestVariant()).toEqual({ activated: false });
    expect(DEFAULT_SCOPE_PATTERNS.length).toBe(snapshot.length);
  });
});
