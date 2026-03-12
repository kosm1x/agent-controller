/**
 * Tests for shared type utilities.
 */

import { describe, it, expect } from "vitest";
import { parseLLMJson, defaultConfig } from "./types.js";

describe("parseLLMJson", () => {
  it("should parse plain JSON", () => {
    const result = parseLLMJson<{ key: string }>('{"key": "value"}');
    expect(result.key).toBe("value");
  });

  it("should strip ```json fences", () => {
    const input = '```json\n{"goals": []}\n```';
    const result = parseLLMJson<{ goals: unknown[] }>(input);
    expect(result.goals).toEqual([]);
  });

  it("should strip ``` fences without language", () => {
    const input = '```\n{"data": 42}\n```';
    const result = parseLLMJson<{ data: number }>(input);
    expect(result.data).toBe(42);
  });

  it("should handle whitespace around fences", () => {
    const input = '  ```json\n{"ok": true}\n```  ';
    const result = parseLLMJson<{ ok: boolean }>(input);
    expect(result.ok).toBe(true);
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseLLMJson("not json at all")).toThrow("invalid JSON");
  });

  it("should throw on empty input", () => {
    expect(() => parseLLMJson("")).toThrow();
  });
});

describe("defaultConfig", () => {
  it("should return sensible defaults", () => {
    const config = defaultConfig();
    expect(config.maxTurns).toBe(50);
    expect(config.maxReplans).toBe(3);
    expect(config.replanThresholds.toolFailureRate).toBe(0.5);
    expect(config.replanThresholds.goalBlocked).toBe(true);
  });

  it("should accept overrides", () => {
    const config = defaultConfig({ maxTurns: 10 });
    expect(config.maxTurns).toBe(10);
    expect(config.maxReplans).toBe(3); // unchanged
  });
});
