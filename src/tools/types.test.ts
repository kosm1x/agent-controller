import { describe, it, expect } from "vitest";
import { getToolAnnotations } from "./types.js";
import type { Tool } from "./types.js";

const baseTool = (overrides: Partial<Tool> = {}): Tool => ({
  name: "test_tool",
  definition: {
    type: "function" as const,
    function: {
      name: "test_tool",
      description: "test",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async () => "ok",
  ...overrides,
});

describe("getToolAnnotations", () => {
  it("returns conservative defaults when fields are absent", () => {
    const a = getToolAnnotations(baseTool());
    // Per MCP spec recommendations: unknown = treat as risky.
    expect(a.readOnlyHint).toBe(false);
    expect(a.destructiveHint).toBe(true);
    expect(a.idempotentHint).toBe(false);
    expect(a.openWorldHint).toBe(true);
    // mc-specific defaults
    expect(a.requiresConfirmation).toBe(false);
    expect(a.riskTier).toBe("low");
  });

  it("riskTier elevates to high when requiresConfirmation is true and riskTier is unset", () => {
    const a = getToolAnnotations(baseTool({ requiresConfirmation: true }));
    expect(a.requiresConfirmation).toBe(true);
    expect(a.riskTier).toBe("high");
  });

  it("explicit riskTier wins over the requiresConfirmation fallback", () => {
    const a = getToolAnnotations(
      baseTool({ requiresConfirmation: true, riskTier: "medium" }),
    );
    expect(a.riskTier).toBe("medium");
  });

  it("respects explicit annotations on a read-only tool", () => {
    const a = getToolAnnotations(
      baseTool({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }),
    );
    expect(a).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      requiresConfirmation: false,
      riskTier: "low",
    });
  });

  it("respects explicit annotations on a closed-world idempotent tool", () => {
    const a = getToolAnnotations(
      baseTool({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
    );
    expect(a.openWorldHint).toBe(false);
    expect(a.idempotentHint).toBe(true);
    expect(a.destructiveHint).toBe(false);
  });

  it("never returns undefined for any annotation field", () => {
    const a = getToolAnnotations(baseTool());
    for (const k of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const) {
      expect(typeof a[k]).toBe("boolean");
    }
  });

  it("returns a fresh object per call — mutating one result does not leak into the next", () => {
    // Behavior contract: callers (confirmation gates, logging layers) often
    // shallow-copy or tag the returned annotations. If getToolAnnotations ever
    // returned a shared default object, a downstream mutation would silently
    // corrupt subsequent reads. Guard against that regression.
    const tool = baseTool();
    const a = getToolAnnotations(tool);
    const b = getToolAnnotations(tool);
    expect(a).not.toBe(b); // distinct references
    (a as { readOnlyHint: boolean }).readOnlyHint = true;
    expect(b.readOnlyHint).toBe(false);
    const c = getToolAnnotations(tool);
    expect(c.readOnlyHint).toBe(false);
    expect(c.destructiveHint).toBe(true);
  });
});

describe("Annotation invariants on annotated tools", () => {
  // Each entry: { tool, expected: ToolAnnotations } — assertions a careful
  // caller can rely on. Tools listed here are the ones annotated in L2.
  const cases = [
    {
      file: "./builtin/file.js",
      tool: "fileReadTool",
      readOnly: true,
      destructive: false,
    },
    {
      file: "./builtin/file.js",
      tool: "fileWriteTool",
      readOnly: false,
      destructive: true, // silent overwrite
    },
    {
      file: "./builtin/file.js",
      tool: "fileDeleteTool",
      readOnly: false,
      destructive: true,
    },
    {
      file: "./builtin/file-convert.js",
      tool: "fileConvertTool",
      readOnly: false,
      destructive: true, // -y overwrites silently
    },
    {
      file: "./builtin/shell.js",
      tool: "shellTool",
      readOnly: false,
      destructive: true,
    },
    {
      file: "./builtin/jarvis-files.js",
      tool: "jarvisFileReadTool",
      readOnly: true,
      destructive: false,
    },
    {
      file: "./builtin/jarvis-files.js",
      tool: "jarvisFileWriteTool",
      readOnly: false,
      destructive: true, // silent overwrite
    },
    {
      file: "./builtin/jarvis-files.js",
      tool: "jarvisFileDeleteTool",
      readOnly: false,
      destructive: true,
    },
    {
      file: "./builtin/google-gmail.js",
      tool: "gmailSendTool",
      readOnly: false,
      destructive: true, // sent email is irreversible
    },
    {
      file: "./builtin/web-read.js",
      tool: "webReadTool",
      readOnly: true,
      destructive: false,
    },
    {
      file: "./builtin/web-search.js",
      tool: "webSearchTool",
      readOnly: true,
      destructive: false,
    },
    {
      file: "./builtin/code-search.js",
      tool: "grepTool",
      readOnly: true,
      destructive: false,
    },
    {
      file: "./builtin/http.js",
      tool: "httpTool",
      readOnly: false,
      destructive: true,
    },
  ];

  for (const c of cases) {
    it(`${c.tool}: readOnly=${c.readOnly}, destructive=${c.destructive}`, async () => {
      const mod = (await import(c.file)) as Record<string, Tool>;
      const t = mod[c.tool];
      expect(t).toBeDefined();
      const a = getToolAnnotations(t);
      expect(a.readOnlyHint).toBe(c.readOnly);
      expect(a.destructiveHint).toBe(c.destructive);
    });
  }

  it("readOnly tools are never destructive (logical consistency)", async () => {
    for (const c of cases.filter((x) => x.readOnly === true)) {
      const mod = (await import(c.file)) as Record<string, Tool>;
      const t = mod[c.tool];
      const a = getToolAnnotations(t);
      expect(a.destructiveHint).toBe(false);
    }
  });

  it("requiresConfirmation tools are never readOnly (logical consistency)", async () => {
    let positiveCases = 0;
    for (const c of cases) {
      const mod = (await import(c.file)) as Record<string, Tool>;
      const t = mod[c.tool];
      if (t.requiresConfirmation) {
        positiveCases++;
        expect(t.readOnlyHint ?? false).toBe(false);
      }
    }
    // Sanity: the cases array MUST include at least one requiresConfirmation
    // tool — without that, the invariant above never fires.
    expect(positiveCases).toBeGreaterThan(0);
  });

  it("riskTier:'high' implies destructiveHint:true (logical consistency)", async () => {
    for (const c of cases) {
      const mod = (await import(c.file)) as Record<string, Tool>;
      const t = mod[c.tool];
      const annotations = getToolAnnotations(t);
      if (annotations.riskTier === "high") {
        expect(annotations.destructiveHint).toBe(true);
      }
    }
  });

  it("readOnlyHint:true implies riskTier !== 'high' (logical consistency)", async () => {
    for (const c of cases) {
      const mod = (await import(c.file)) as Record<string, Tool>;
      const t = mod[c.tool];
      const annotations = getToolAnnotations(t);
      if (annotations.readOnlyHint) {
        expect(annotations.riskTier).not.toBe("high");
      }
    }
  });
});
