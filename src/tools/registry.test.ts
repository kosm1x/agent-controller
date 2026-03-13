/**
 * Tool registry tests — findClosest() for tool call repair.
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
function makeTool(name: string) {
  return {
    name,
    definition: {
      type: "function" as const,
      function: { name, description: `Tool ${name}`, parameters: {} },
    },
    execute: async () => "ok",
  };
}

describe("ToolRegistry.findClosest", () => {
  it("should return null when no tools registered", () => {
    const reg = new ToolRegistry();
    expect(reg.findClosest("shell_exec")).toBeNull();
  });

  it("should exact-match after normalization (lowercase + hyphen→underscore)", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("shell_exec"));

    expect(reg.findClosest("Shell_Exec")).toBe("shell_exec");
    expect(reg.findClosest("shell-exec")).toBe("shell_exec");
    expect(reg.findClosest("SHELL_EXEC")).toBe("shell_exec");
    expect(reg.findClosest("shell exec")).toBe("shell_exec");
  });

  it("should fuzzy-match within 30% edit distance", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("file_read"));
    reg.register(makeTool("file_write"));
    reg.register(makeTool("shell_exec"));

    // "file_reed" → 1 edit from "file_read" (9 chars, 30% = 2.7)
    expect(reg.findClosest("file_reed")).toBe("file_read");

    // "shell_exce" → 2 edits from "shell_exec" (10 chars, 30% = 3)
    expect(reg.findClosest("shell_exce")).toBe("shell_exec");
  });

  it("should reject matches beyond 30% edit distance", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("shell_exec"));

    // "xyz" is too far from "shell_exec"
    expect(reg.findClosest("xyz")).toBeNull();

    // "completely_different" is too far
    expect(reg.findClosest("completely_different")).toBeNull();
  });

  it("should return best match among multiple candidates", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("file_read"));
    reg.register(makeTool("file_write"));

    // "file_reab" is 1 edit from file_read, 3 from file_write
    expect(reg.findClosest("file_reab")).toBe("file_read");
  });
});
