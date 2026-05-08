/**
 * Runtime skill catalog tests — v7.6 Spine 5.
 *
 * Pins the invariants that make the catalog usable as a stable runtime
 * surface: ≥3 entries, no duplicate surface keys, every entry has all
 * four fields populated, and content references are coupled to the
 * upstream constants so renaming the source breaks the catalog test.
 */

import { describe, it, expect } from "vitest";
import {
  FIRST_PARTY_SKILLS,
  listFirstPartySkills,
  listSkillsForTools,
  findFirstPartySkill,
  groupFirstPartySkillsBySource,
  HTML_COMPOSE_SKILL_GATE,
  HTML_COMPOSE_HOUSE_STYLE,
  HTML_COMPOSE_VISUAL_STYLES,
  COCOON_PALETTE_DARK,
  COCOON_PALETTE_LIGHT,
  COCOON_LAYOUT_RULES,
} from "./catalog.js";
import type { FirstPartySkill } from "./catalog.js";

describe("FIRST_PARTY_SKILLS", () => {
  it("registers at least 3 skills (Spine 5 acceptance criterion)", () => {
    expect(FIRST_PARTY_SKILLS.length).toBeGreaterThanOrEqual(3);
  });

  it("registers exactly 6 skills as of v7.6 Spine 5", () => {
    // Pinned exact count so adding a skill is an explicit decision that
    // breaks this test and forces the author to update
    // mission-control/docs/audit/v7.6-skill-engine.md (round-1 audit L1).
    expect(FIRST_PARTY_SKILLS.length).toBe(6);
  });

  it("has globally unique surface keys", () => {
    const surfaces = FIRST_PARTY_SKILLS.map((s) => s.surface);
    const unique = new Set(surfaces);
    expect(unique.size).toBe(surfaces.length);
  });

  it("every entry has all five fields populated", () => {
    for (const skill of FIRST_PARTY_SKILLS) {
      expect(skill.surface).toBeTruthy();
      expect(skill.surface.length).toBeGreaterThan(0);
      expect(skill.label).toBeTruthy();
      expect(skill.label.length).toBeGreaterThan(0);
      expect(skill.content).toBeTruthy();
      expect(skill.content.length).toBeGreaterThan(0);
      expect(skill.source).toMatch(/^(html-compose|svg-diagram)$/);
      expect(skill.requiresTool).toBeTruthy();
      expect(skill.requiresTool.length).toBeGreaterThan(0);
    }
  });

  it("requiresTool maps to the correct upstream tool by source", () => {
    // html-compose skills must gate on video_html_compose; svg-diagram skills
    // must gate on diagram_generate. If a future upstream split changes the
    // parent-tool mapping this test pins the contract.
    for (const skill of FIRST_PARTY_SKILLS) {
      if (skill.source === "html-compose") {
        expect(skill.requiresTool).toBe("video_html_compose");
      } else if (skill.source === "svg-diagram") {
        expect(skill.requiresTool).toBe("diagram_generate");
      }
    }
  });

  it("requiresTool strings match the canonical Tool.name fields (round-2 audit M4)", async () => {
    // Catalog cannot import the tool modules directly without polluting its
    // import chain (heavy deps like child_process / playwright). We assert
    // equivalence at test time instead: a rename of the Tool's `name` field
    // still produces a loud test failure here even though there's no
    // typecheck-time link in production code.
    const { videoHtmlComposeTool } = await import("../tools/builtin/video.js");
    const { diagramGenerateTool } =
      await import("../tools/builtin/diagram-generate.js");
    const htmlSkill = findFirstPartySkill("html-compose-skill-gate");
    const svgSkill = findFirstPartySkill("svg-diagram-palette-dark");
    expect(htmlSkill?.requiresTool).toBe(videoHtmlComposeTool.name);
    expect(svgSkill?.requiresTool).toBe(diagramGenerateTool.name);
  });

  it("entries are frozen (round-1 audit M1, round-2 M6 — assert mutation throws not just isFrozen flag)", () => {
    // ESM modules are strict mode by default; mutating a frozen object throws.
    // Asserting the contract directly (not just the flag) so a future swap of
    // Object.freeze with Object.preventExtensions or Object.seal fails loudly.
    const target = FIRST_PARTY_SKILLS[0];
    expect(target).toBeDefined();
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(FIRST_PARTY_SKILLS)).toBe(true);
    expect(() => {
      (target as { surface: string }).surface = "mutated";
    }).toThrow();
    expect(() => {
      (FIRST_PARTY_SKILLS as FirstPartySkill[]).pop();
    }).toThrow();
  });

  it("surface keys are kebab-case ASCII", () => {
    for (const skill of FIRST_PARTY_SKILLS) {
      expect(skill.surface).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("content is sourced from the upstream constants (catalog never duplicates text)", () => {
    // Producer/consumer coupling — if upstream constants are renamed or
    // their content drifts from what the catalog ships, this fails.
    const gate = findFirstPartySkill("html-compose-skill-gate");
    expect(gate?.content).toBe(HTML_COMPOSE_SKILL_GATE);

    const houseStyle = findFirstPartySkill("html-compose-house-style");
    expect(houseStyle?.content).toBe(HTML_COMPOSE_HOUSE_STYLE);

    const visualStyles = findFirstPartySkill("html-compose-visual-styles");
    expect(visualStyles?.content).toBe(HTML_COMPOSE_VISUAL_STYLES);

    const paletteDark = findFirstPartySkill("svg-diagram-palette-dark");
    expect(paletteDark?.content).toBe(COCOON_PALETTE_DARK);

    const paletteLight = findFirstPartySkill("svg-diagram-palette-light");
    expect(paletteLight?.content).toBe(COCOON_PALETTE_LIGHT);

    const layoutRules = findFirstPartySkill("svg-diagram-layout-rules");
    expect(layoutRules?.content).toBe(COCOON_LAYOUT_RULES);
  });
});

describe("listFirstPartySkills", () => {
  it("returns a defensive copy", () => {
    const a = listFirstPartySkills();
    const b = listFirstPartySkills();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("mutating the returned array does not affect FIRST_PARTY_SKILLS", () => {
    const before = FIRST_PARTY_SKILLS.length;
    const list = listFirstPartySkills();
    list.pop();
    list.pop();
    expect(FIRST_PARTY_SKILLS.length).toBe(before);
    expect(listFirstPartySkills().length).toBe(before);
  });
});

describe("listSkillsForTools (round-1 audit H1 — tool-gated rendering)", () => {
  it("returns empty when no relevant tool is in scope", () => {
    expect(listSkillsForTools(["web_search", "memory_store"])).toEqual([]);
  });

  it("returns html-compose skills only when video_html_compose is scoped", () => {
    const filtered = listSkillsForTools(["video_html_compose"]);
    expect(filtered.length).toBe(3);
    expect(filtered.every((s) => s.source === "html-compose")).toBe(true);
  });

  it("returns svg-diagram skills only when diagram_generate is scoped", () => {
    const filtered = listSkillsForTools(["diagram_generate"]);
    expect(filtered.length).toBe(3);
    expect(filtered.every((s) => s.source === "svg-diagram")).toBe(true);
  });

  it("returns the full catalog when both parent tools are scoped", () => {
    const filtered = listSkillsForTools([
      "video_html_compose",
      "diagram_generate",
    ]);
    expect(filtered.length).toBe(FIRST_PARTY_SKILLS.length);
  });

  it("ignores unrelated tool names without false positives", () => {
    // Substring sanity — "video_html_compose_v2" should NOT match
    // "video_html_compose". Set lookup is exact equality.
    const filtered = listSkillsForTools(["video_html_compose_v2"]);
    expect(filtered.length).toBe(0);
  });
});

describe("findFirstPartySkill", () => {
  it("locates a skill by surface key", () => {
    const skill = findFirstPartySkill("html-compose-skill-gate");
    expect(skill).toBeDefined();
    expect(skill?.label).toBe("When to use video_html_compose");
  });

  it("returns undefined for unknown surface", () => {
    expect(findFirstPartySkill("nonexistent-skill")).toBeUndefined();
  });
});

describe("groupFirstPartySkillsBySource", () => {
  it("groups all skills under known source tags", () => {
    const grouped = groupFirstPartySkillsBySource();
    const total =
      grouped["html-compose"].length + grouped["svg-diagram"].length;
    expect(total).toBe(FIRST_PARTY_SKILLS.length);
  });

  it("html-compose group contains exactly 3 skills", () => {
    const grouped = groupFirstPartySkillsBySource();
    expect(grouped["html-compose"]).toHaveLength(3);
  });

  it("svg-diagram group contains exactly 3 skills", () => {
    const grouped = groupFirstPartySkillsBySource();
    expect(grouped["svg-diagram"]).toHaveLength(3);
  });

  it("returned arrays are own arrays (not shared with FIRST_PARTY_SKILLS)", () => {
    const grouped = groupFirstPartySkillsBySource();
    grouped["html-compose"].pop();
    expect(groupFirstPartySkillsBySource()["html-compose"]).toHaveLength(3);
  });
});
