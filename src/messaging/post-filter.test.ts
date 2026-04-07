import { describe, it, expect } from "vitest";
import { scanForAIPatterns } from "./post-filter.js";

describe("scanForAIPatterns", () => {
  it("detects Tier 1 words", () => {
    const result = scanForAIPatterns(
      "Let me delve into the landscape of this tapestry.",
    );
    expect(result.flagCount).toBeGreaterThanOrEqual(3);
    expect(result.flags.some((f) => f.includes("delve"))).toBe(true);
  });

  it("detects chatbot artifacts", () => {
    const result = scanForAIPatterns("I hope this helps! Great question!");
    expect(result.flagCount).toBeGreaterThanOrEqual(2);
  });

  it("detects reasoning chain leaks", () => {
    const result = scanForAIPatterns(
      "Let me think step by step. Breaking this down...",
    );
    expect(result.flagCount).toBeGreaterThanOrEqual(2);
  });

  it("detects transition filler", () => {
    const result = scanForAIPatterns(
      "Moreover, this is important. Furthermore, we should note. In conclusion, it works.",
    );
    expect(result.flagCount).toBeGreaterThanOrEqual(3);
  });

  it("returns zero flags for clean text", () => {
    const result = scanForAIPatterns(
      "The system processes 500 requests per second with 99.9% uptime.",
    );
    expect(result.flagCount).toBe(0);
  });

  it("preserves original text (no modification)", () => {
    const original = "This text delves into the landscape.";
    const result = scanForAIPatterns(original);
    expect(result.text).toBe(original);
  });
});
