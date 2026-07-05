import { describe, it, expect } from "vitest";
import { defineTool } from "./define-tool.js";

describe("defineTool", () => {
  it("derives definition.function.name from the single name declaration", () => {
    const tool = defineTool({
      name: "example_tool",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      description: "An example.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return "{}";
      },
    });
    expect(tool.name).toBe("example_tool");
    expect(tool.definition.function.name).toBe("example_tool");
    expect(tool.definition.type).toBe("function");
    expect(tool.definition.function.description).toBe("An example.");
  });

  it("passes hints and mc-specific fields through unchanged", () => {
    const tool = defineTool({
      name: "risky_tool",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      requiresConfirmation: true,
      riskTier: "high",
      deferred: true,
      triggerPhrases: ["do the thing"],
      description: "Risky.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return "{}";
      },
    });
    expect(tool.readOnlyHint).toBe(false);
    expect(tool.destructiveHint).toBe(true);
    expect(tool.idempotentHint).toBe(false);
    expect(tool.openWorldHint).toBe(true);
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.riskTier).toBe("high");
    expect(tool.deferred).toBe(true);
    expect(tool.triggerPhrases).toEqual(["do the thing"]);
  });

  it("wires execute through untouched", async () => {
    const tool = defineTool({
      name: "echo_tool",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      description: "Echo.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return JSON.stringify(args);
      },
    });
    expect(await tool.execute({ a: 1 })).toBe('{"a":1}');
  });
});
