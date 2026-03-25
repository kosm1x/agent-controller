import { describe, it, expect } from "vitest";
import { serializeSandbox, deserializeSandbox } from "./variant-store.js";
import type { SandboxConfig } from "./types.js";

describe("variant-store", () => {
  it("roundtrips empty sandbox", () => {
    const config: SandboxConfig = {};
    const json = serializeSandbox(config);
    const restored = deserializeSandbox(json);
    expect(restored).toEqual({});
  });

  it("roundtrips tool description overrides", () => {
    const config: SandboxConfig = {
      toolDescriptionOverrides: new Map([
        ["web_search", "Search the web for information"],
        ["memory_store", "Store a fact in memory"],
      ]),
    };

    const json = serializeSandbox(config);
    const restored = deserializeSandbox(json);

    expect(restored.toolDescriptionOverrides).toBeInstanceOf(Map);
    expect(restored.toolDescriptionOverrides!.size).toBe(2);
    expect(restored.toolDescriptionOverrides!.get("web_search")).toBe(
      "Search the web for information",
    );
    expect(restored.toolDescriptionOverrides!.get("memory_store")).toBe(
      "Store a fact in memory",
    );
  });

  it("roundtrips scope pattern overrides with /i flag", () => {
    const config: SandboxConfig = {
      scopePatternOverrides: [
        { pattern: /\b(docker|kubernetes)\b/i, group: "coding" },
        { pattern: /\b(gmail|email)\b/i, group: "email" },
      ],
    };

    const json = serializeSandbox(config);
    const restored = deserializeSandbox(json);

    expect(restored.scopePatternOverrides).toHaveLength(2);
    const coding = restored.scopePatternOverrides![0];
    expect(coding.group).toBe("coding");
    expect(coding.pattern).toBeInstanceOf(RegExp);
    expect(coding.pattern.flags).toContain("i");
    expect(coding.pattern.test("Docker")).toBe(true);
  });

  it("roundtrips combined overrides", () => {
    const config: SandboxConfig = {
      toolDescriptionOverrides: new Map([["foo", "bar"]]),
      scopePatternOverrides: [{ pattern: /test/i, group: "testing" }],
    };

    const json = serializeSandbox(config);
    const restored = deserializeSandbox(json);

    expect(restored.toolDescriptionOverrides!.get("foo")).toBe("bar");
    expect(restored.scopePatternOverrides).toHaveLength(1);
  });

  it("produces valid JSON", () => {
    const config: SandboxConfig = {
      toolDescriptionOverrides: new Map([["a", "b"]]),
    };
    const json = serializeSandbox(config);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
