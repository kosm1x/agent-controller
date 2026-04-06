import { describe, it, expect } from "vitest";
import {
  BACKGROUND_CATALOG,
  isCached,
  listCachedBackgrounds,
} from "./backgrounds.js";

describe("BACKGROUND_CATALOG", () => {
  it("has 5 pre-seeded backgrounds", () => {
    expect(BACKGROUND_CATALOG).toHaveLength(5);
  });

  it("each entry has name, url, credit, description", () => {
    for (const entry of BACKGROUND_CATALOG) {
      expect(entry.name).toBeTruthy();
      expect(entry.url).toBeTruthy();
      expect(entry.credit).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  it("names are unique", () => {
    const names = BACKGROUND_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes expected entries", () => {
    const names = BACKGROUND_CATALOG.map((e) => e.name);
    expect(names).toContain("ocean-waves");
    expect(names).toContain("city-timelapse");
    expect(names).toContain("abstract-particles");
  });
});

describe("isCached", () => {
  it("returns false for non-existent background", () => {
    expect(isCached("nonexistent-background-xyz")).toBe(false);
  });
});

describe("listCachedBackgrounds", () => {
  it("returns array (possibly empty)", () => {
    const result = listCachedBackgrounds();
    expect(Array.isArray(result)).toBe(true);
  });
});
