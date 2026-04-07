/**
 * Tests for scope-classifier — CIRICD-based semantic scope classification.
 */

import { describe, it, expect } from "vitest";
import { parseScopeGroups } from "./scope-classifier.js";

describe("parseScopeGroups", () => {
  it("parses valid JSON array", () => {
    const result = parseScopeGroups('["northstar_read","google"]');
    expect(result).not.toBeNull();
    expect(result!.has("northstar_read")).toBe(true);
    expect(result!.has("google")).toBe(true);
    expect(result!.size).toBe(2);
  });

  it("parses empty array", () => {
    const result = parseScopeGroups("[]");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  it("filters invalid group names", () => {
    const result = parseScopeGroups('["coding","invalid_group","meta"]');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
    expect(result!.has("coding")).toBe(true);
    expect(result!.has("meta")).toBe(true);
  });

  it("handles markdown code fences", () => {
    const result = parseScopeGroups('```json\n["northstar_write"]\n```');
    expect(result).not.toBeNull();
    expect(result!.has("northstar_write")).toBe(true);
  });

  it("handles comma-separated format", () => {
    const result = parseScopeGroups("google, schedule, intel");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(3);
  });

  it("returns null for unparseable input", () => {
    expect(parseScopeGroups("I think you need google tools")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseScopeGroups("")).toBeNull();
  });

  it("handles single group as plain text", () => {
    const result = parseScopeGroups("coding");
    expect(result).not.toBeNull();
    expect(result!.has("coding")).toBe(true);
  });
});
