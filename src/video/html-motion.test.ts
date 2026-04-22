import { describe, it, expect } from "vitest";
import {
  HTML_MOTION_PATTERNS,
  HTML_MOTION_IDS,
  getMotionPattern,
  catalogToPrompt,
  validateCatalog,
} from "./html-motion.js";

describe("html-motion catalog", () => {
  it("validates without throw", () => {
    expect(() => validateCatalog()).not.toThrow();
  });

  it("has at least 12 patterns", () => {
    expect(HTML_MOTION_PATTERNS.length).toBeGreaterThanOrEqual(12);
  });

  it("all IDs are unique", () => {
    const ids = new Set(HTML_MOTION_PATTERNS.map((p) => p.id));
    expect(ids.size).toBe(HTML_MOTION_PATTERNS.length);
  });

  it("HTML_MOTION_IDS mirrors catalog", () => {
    expect(HTML_MOTION_IDS).toEqual(HTML_MOTION_PATTERNS.map((p) => p.id));
  });

  it("getMotionPattern returns entry when id matches", () => {
    const fade = getMotionPattern("fade-in");
    expect(fade?.label).toBe("Fade in");
    expect(fade?.css).toContain("@keyframes fade-in");
  });

  it("getMotionPattern returns undefined for missing id", () => {
    expect(getMotionPattern("nonexistent-id-xyz")).toBeUndefined();
  });

  it("catalogToPrompt returns prompt-friendly string with verbatim fragments", () => {
    const prompt = catalogToPrompt(4);
    expect(prompt).toContain("fade-in");
    expect(prompt.split("\n").length).toBeGreaterThanOrEqual(5);
  });

  it("no entry contains unresolved placeholder syntax", () => {
    for (const p of HTML_MOTION_PATTERNS) {
      expect(p.prompt_fragment).not.toMatch(/\{\{.*?\}\}/);
      expect(p.css).not.toMatch(/\{\{.*?\}\}/);
    }
  });

  it("every prompt_fragment is non-empty and descriptive", () => {
    for (const p of HTML_MOTION_PATTERNS) {
      expect(p.prompt_fragment.length).toBeGreaterThan(10);
    }
  });

  it("every CSS snippet mentions a selector or keyframe", () => {
    for (const p of HTML_MOTION_PATTERNS) {
      expect(p.css).toMatch(/@keyframes|\.\w/);
    }
  });
});
