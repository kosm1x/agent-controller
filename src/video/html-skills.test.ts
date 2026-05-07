import { describe, it, expect } from "vitest";
import {
  HTML_COMPOSE_SKILL_GATE,
  HTML_COMPOSE_HOUSE_STYLE,
  HTML_COMPOSE_VISUAL_STYLES,
  HTML_COMPOSE_SKILLS,
  htmlCompositionSkillSection,
} from "./html-skills.js";

describe("HTML composition skill catalogs", () => {
  it("skill gate names the tool, the trigger phrasing, and the network constraint", () => {
    expect(HTML_COMPOSE_SKILL_GATE).toContain("video_html_compose");
    expect(HTML_COMPOSE_SKILL_GATE).toContain("/root/tmp-video-html/");
    expect(HTML_COMPOSE_SKILL_GATE).toMatch(/data: URIs/);
    expect(HTML_COMPOSE_SKILL_GATE).toMatch(/HARD CONSTRAINTS/);
  });

  it("house style covers the four vocabulary axes (frame rate / viewport / duration / typography)", () => {
    expect(HTML_COMPOSE_HOUSE_STYLE).toMatch(/24fps/);
    expect(HTML_COMPOSE_HOUSE_STYLE).toMatch(/1920x1080/);
    expect(HTML_COMPOSE_HOUSE_STYLE).toMatch(/200-600ms/);
    expect(HTML_COMPOSE_HOUSE_STYLE).toMatch(/WCAG AA/);
  });

  it("visual styles include the documented preset names", () => {
    for (const preset of [
      "EDITORIAL",
      "DOCUMENTARY",
      "HYPE",
      "DATA-VIZ",
      "BRUTALIST",
      "MINIMAL",
    ]) {
      expect(HTML_COMPOSE_VISUAL_STYLES).toContain(preset);
    }
  });
});

describe("htmlCompositionSkillSection", () => {
  it("concatenates all three catalogs with blank-line separators", () => {
    const section = htmlCompositionSkillSection();
    expect(section).toContain(HTML_COMPOSE_SKILL_GATE);
    expect(section).toContain(HTML_COMPOSE_HOUSE_STYLE);
    expect(section).toContain(HTML_COMPOSE_VISUAL_STYLES);
    // Expect at least one blank line between catalogs
    expect(section.match(/\n\n/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("HTML_COMPOSE_SKILLS — v7.5 Skill Evolution Engine surface", () => {
  it("exposes one entry per catalog with stable surface keys", () => {
    expect(HTML_COMPOSE_SKILLS).toHaveLength(3);
    const surfaces = HTML_COMPOSE_SKILLS.map((s) => s.surface);
    expect(surfaces).toEqual([
      "html-compose-skill-gate",
      "html-compose-house-style",
      "html-compose-visual-styles",
    ]);
  });

  it("each entry has a non-empty label and content", () => {
    for (const entry of HTML_COMPOSE_SKILLS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.content.length).toBeGreaterThan(0);
    }
  });
});

describe("video_html_compose tool description includes the skill gate", () => {
  it("description references skill gate content (post-wiring)", async () => {
    const { videoHtmlComposeTool } = await import("../tools/builtin/video.js");
    const desc = videoHtmlComposeTool.definition.function.description ?? "";
    expect(desc).toContain("video_html_compose");
    // A few load-bearing strings that must survive into the assembled description
    expect(desc).toContain("HARD CONSTRAINTS");
    expect(desc).toContain("EDITORIAL");
    expect(desc).toContain("WCAG AA");
  });
});
