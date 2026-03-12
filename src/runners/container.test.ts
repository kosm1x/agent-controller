/**
 * Container helpers unit tests.
 * Tests name generation and sentinel output parsing.
 */

import { describe, it, expect } from "vitest";
import {
  generateContainerName,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from "./container.js";

describe("generateContainerName", () => {
  it("should generate mc- prefixed names", () => {
    const name = generateContainerName("test");
    expect(name).toMatch(/^mc-test-\d+$/);
  });

  it("should sanitize special characters", () => {
    const name = generateContainerName("My Task!@#$");
    expect(name).toMatch(/^mc-my-task--\d+$/);
  });

  it("should truncate long prefixes", () => {
    const name = generateContainerName("a".repeat(100));
    // mc- + 30 chars max + - + timestamp
    expect(name.startsWith("mc-")).toBe(true);
    const parts = name.split("-");
    expect(parts[1].length).toBeLessThanOrEqual(30);
  });

  it("should use default prefix", () => {
    const name = generateContainerName();
    expect(name).toMatch(/^mc-task-\d+$/);
  });
});

describe("sentinel markers", () => {
  it("should have distinct start and end markers", () => {
    expect(OUTPUT_START_MARKER).not.toBe(OUTPUT_END_MARKER);
    expect(OUTPUT_START_MARKER).toContain("START");
    expect(OUTPUT_END_MARKER).toContain("END");
  });
});
