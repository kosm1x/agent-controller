import { describe, it, expect } from "vitest";
import { STEALTH_SCRIPTS } from "./stealth.js";

describe("stealth patches", () => {
  it("has 5 stealth scripts", () => {
    expect(STEALTH_SCRIPTS).toHaveLength(5);
  });

  it("patches document.hasFocus", () => {
    expect(STEALTH_SCRIPTS[0]).toContain("hasFocus");
  });

  it("patches visibilityState", () => {
    expect(STEALTH_SCRIPTS[1]).toContain("visibilityState");
  });

  it("patches navigator.webdriver", () => {
    expect(STEALTH_SCRIPTS[2]).toContain("webdriver");
  });

  it("patches navigator.connection", () => {
    expect(STEALTH_SCRIPTS[3]).toContain("connection");
    expect(STEALTH_SCRIPTS[3]).toContain("4g");
  });

  it("patches performance.memory", () => {
    expect(STEALTH_SCRIPTS[4]).toContain("memory");
    expect(STEALTH_SCRIPTS[4]).toContain("jsHeapSizeLimit");
  });

  it("all scripts are non-empty strings", () => {
    for (const script of STEALTH_SCRIPTS) {
      expect(typeof script).toBe("string");
      expect(script.length).toBeGreaterThan(10);
    }
  });
});
