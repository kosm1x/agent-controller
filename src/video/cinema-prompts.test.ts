import { describe, it, expect } from "vitest";
import {
  CAMERA_MODIFIERS,
  LIGHTING_STYLES,
  MOOD_ARCHETYPES,
  validateCatalogs,
} from "./cinema-prompts.js";

describe("cinema-prompts catalogs", () => {
  it("all catalogs are non-empty", () => {
    expect(CAMERA_MODIFIERS.length).toBeGreaterThan(0);
    expect(LIGHTING_STYLES.length).toBeGreaterThan(0);
    expect(MOOD_ARCHETYPES.length).toBeGreaterThan(0);
  });

  it("catalog ids are unique within each catalog", () => {
    const ids = (arr: readonly { id: string }[]) =>
      new Set(arr.map((x) => x.id));
    expect(ids(CAMERA_MODIFIERS).size).toBe(CAMERA_MODIFIERS.length);
    expect(ids(LIGHTING_STYLES).size).toBe(LIGHTING_STYLES.length);
    expect(ids(MOOD_ARCHETYPES).size).toBe(MOOD_ARCHETYPES.length);
  });

  it("prompt_fragment never contains unfilled {{placeholder}} syntax", () => {
    const result = validateCatalogs();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("every entry has non-empty label + tagline + prompt_fragment + best_for", () => {
    for (const m of [
      ...CAMERA_MODIFIERS,
      ...LIGHTING_STYLES,
      ...MOOD_ARCHETYPES,
    ]) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.tagline.length).toBeGreaterThan(0);
      expect(m.prompt_fragment.length).toBeGreaterThan(0);
      expect(m.best_for.length).toBeGreaterThan(0);
    }
  });
});
