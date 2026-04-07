/**
 * Tool registry tests — findClosest() for tool call repair.
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

function makeTool(name: string, opts?: { deferred?: boolean }): Tool {
  return {
    name,
    deferred: opts?.deferred,
    definition: {
      type: "function" as const,
      function: {
        name,
        description: `Tool ${name}`,
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
        },
      },
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

// ---------------------------------------------------------------------------
// Deferred tool expansion (v6.4 OH2)
// ---------------------------------------------------------------------------

describe("deferred tool expansion", () => {
  it("getDefinitions excludes deferred tools when excludeDeferred=true", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("web_search"));
    reg.register(makeTool("gmail_send", { deferred: true }));
    reg.register(makeTool("gmail_read", { deferred: true }));

    const all = reg.getDefinitions();
    expect(all).toHaveLength(3);

    const nonDeferred = reg.getDefinitions(undefined, true);
    expect(nonDeferred).toHaveLength(1);
    expect(nonDeferred[0].function.name).toBe("web_search");
  });

  it("getDefinitions with name filter + excludeDeferred", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("web_search"));
    reg.register(makeTool("gmail_send", { deferred: true }));

    const filtered = reg.getDefinitions(["web_search", "gmail_send"], true);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].function.name).toBe("web_search");
  });

  it("getDeferredCatalog returns text catalog for deferred tools only", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("web_search"));
    reg.register(makeTool("gmail_send", { deferred: true }));
    reg.register(makeTool("gmail_read", { deferred: true }));

    const catalog = reg.getDeferredCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog).toContain("[DEFERRED TOOLS]");
    expect(catalog).toContain("gmail_send");
    expect(catalog).toContain("gmail_read");
    expect(catalog).not.toContain("web_search");
  });

  it("getDeferredCatalog returns null when no deferred tools", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("web_search"));

    expect(reg.getDeferredCatalog()).toBeNull();
  });

  it("getDeferredCatalog respects name filter", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("gmail_send", { deferred: true }));
    reg.register(makeTool("gmail_read", { deferred: true }));

    const catalog = reg.getDeferredCatalog(["gmail_send"]);
    expect(catalog).toContain("gmail_send");
    expect(catalog).not.toContain("gmail_read");
  });

  it("get() returns deferred tool with deferred flag for expansion check", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("gmail_send", { deferred: true }));

    const tool = reg.get("gmail_send");
    expect(tool).toBeDefined();
    expect(tool!.deferred).toBe(true);
    expect(tool!.definition.function.parameters).toBeDefined();
  });

  it("get() returns non-deferred tool without deferred flag", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("web_search"));

    const tool = reg.get("web_search");
    expect(tool).toBeDefined();
    expect(tool!.deferred).toBeUndefined();
  });

  it("execute() works on deferred tools (expansion unlocks execution)", async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("gmail_send", { deferred: true }));

    // Deferred tools can still be executed via registry — the deferral
    // only affects schema inclusion, not executability
    await expect(reg.execute("gmail_send", { input: "test" })).resolves.toBe(
      "ok",
    );
  });
});
