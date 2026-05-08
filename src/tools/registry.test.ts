/**
 * Tool registry tests — findClosest() for tool call repair.
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import { getToolAnnotations } from "./types.js";
import type { Tool } from "./types.js";
import {
  BUILTIN_TOOLS,
  SOCIAL_TOOLS,
  CRM_TOOLS,
  GWS_TOOLS,
  WP_TOOLS,
} from "./sources/builtin.js";
// Tools registered by GoogleToolSource — these live in builtin/*.ts but get
// registered through a separate ToolSource (gated on Google OAuth env vars).
import {
  gmailSendTool,
  gmailSearchTool,
  gmailReadTool,
} from "./builtin/google-gmail.js";
import {
  gdriveListTool,
  gdriveCreateTool,
  gdriveShareTool,
  gdriveDeleteTool,
  gdriveMoveTool,
  gdriveUploadTool,
  gdriveDownloadTool,
} from "./builtin/google-drive.js";
import {
  calendarListTool,
  calendarCreateTool,
  calendarUpdateTool,
} from "./builtin/google-calendar.js";
import {
  gsheetsReadTool,
  gsheetsWriteTool,
  gdocsReadTool,
  gdocsReadFullTool,
  gdocsWriteTool,
  gdocsReplaceTool,
  gslidesReadTool,
  gslidesCreateTool,
  gtasksCreateTool,
} from "./builtin/google-docs.js";
// Tools registered by MemoryToolSource (Hindsight backend).
import {
  memorySearchTool,
  memoryStoreTool,
  memoryReflectTool,
  memoryKgQueryTool,
} from "./builtin/memory.js";
// Tools registered by SkillsToolSource.
import { skillSaveTool, skillListTool } from "./builtin/skills.js";

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

// ---------------------------------------------------------------------------
// v7.6 Spine 4 — MCP annotation coverage push.
//
// Asserts every production tool has all 4 hints set EXPLICITLY (no relying
// on the conservative defaults from getToolAnnotations). Until this lands,
// audit-claim metrics segmenting by destructive-vs-readonly are muted by
// the unannotated population's collapse to "destructiveHint=true /
// readOnlyHint=false".
//
// Sources covered: builtin, WP, CRM, GWS, social. The MCP source registers
// upstream-defined schemas at runtime (xpoz/browser/etc.) — those are out
// of scope for this file because their hints come from the upstream
// definition, not our codebase.
// ---------------------------------------------------------------------------

describe("MCP annotation coverage (v7.6 Spine 4)", () => {
  // Every tool a real production deployment could register, across all
  // ToolSources we own. (MCP source registers upstream-defined schemas at
  // runtime — out of scope.)
  const ALL_TOOLS: Tool[] = [
    // BuiltinToolSource family
    ...BUILTIN_TOOLS,
    ...SOCIAL_TOOLS,
    ...CRM_TOOLS,
    ...GWS_TOOLS,
    ...WP_TOOLS,
    // GoogleToolSource — gated on GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
    gmailSendTool,
    gmailSearchTool,
    gmailReadTool,
    gdriveListTool,
    gdriveCreateTool,
    gdriveShareTool,
    gdriveDeleteTool,
    gdriveMoveTool,
    gdriveUploadTool,
    gdriveDownloadTool,
    calendarListTool,
    calendarCreateTool,
    calendarUpdateTool,
    gsheetsReadTool,
    gsheetsWriteTool,
    gdocsReadTool,
    gdocsReadFullTool,
    gdocsWriteTool,
    gdocsReplaceTool,
    gslidesReadTool,
    gslidesCreateTool,
    gtasksCreateTool,
    // MemoryToolSource — gated on Hindsight availability
    memorySearchTool,
    memoryStoreTool,
    memoryReflectTool,
    memoryKgQueryTool,
    // SkillsToolSource — always available
    skillSaveTool,
    skillListTool,
  ];

  it("every production tool has all 4 MCP hints explicitly set (no defaults)", () => {
    const missing: string[] = [];
    for (const tool of ALL_TOOLS) {
      const fields: Array<keyof Tool> = [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ];
      const absent = fields.filter((f) => tool[f] === undefined);
      if (absent.length > 0) {
        missing.push(`${tool.name}: missing [${absent.join(", ")}]`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Tools missing MCP annotations:\n  ${missing.join("\n  ")}`,
      );
    }
  });

  it("readOnlyHint=true implies destructiveHint=false (logical invariant)", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.readOnlyHint === true) {
        expect(
          tool.destructiveHint,
          `${tool.name} is readOnly but destructiveHint is not false`,
        ).toBe(false);
      }
    }
  });

  it("requiresConfirmation=true implies readOnlyHint!=true (logical invariant)", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.requiresConfirmation === true) {
        expect(
          tool.readOnlyHint,
          `${tool.name} requiresConfirmation but is marked readOnly`,
        ).not.toBe(true);
      }
    }
  });

  it("riskTier='high' implies destructiveHint=true (logical invariant)", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.riskTier === "high") {
        expect(
          tool.destructiveHint,
          `${tool.name} has riskTier=high but destructiveHint is not true`,
        ).toBe(true);
      }
    }
  });

  it("getToolAnnotations returns no defaults for any production tool", () => {
    // Defensive cross-check: if any field falls back to the default branch
    // in getToolAnnotations (e.g., openWorldHint defaulting to true via ??),
    // it means the source tool didn't set that field. The above test catches
    // this directly; this is the consumer-side mirror.
    const defaultFallbacks: string[] = [];
    for (const tool of ALL_TOOLS) {
      const a = getToolAnnotations(tool);
      if (a.readOnlyHint && tool.readOnlyHint === undefined) {
        defaultFallbacks.push(`${tool.name}: readOnly fell back to default`);
      }
      // Same for destructive — check that the source field is set, not
      // that it matches the default value.
      const fields = [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const;
      for (const f of fields) {
        if (tool[f] === undefined) {
          defaultFallbacks.push(`${tool.name}: ${f} relied on default`);
        }
      }
    }
    if (defaultFallbacks.length > 0) {
      throw new Error(
        `Tools relying on getToolAnnotations defaults:\n  ${defaultFallbacks.slice(0, 10).join("\n  ")}`,
      );
    }
  });

  it("coverage statistic — at least 180 production tools annotated", () => {
    // Sanity check on the source-of-truth count. If this drops, either a
    // tool was removed (update the threshold) or a regression unannotated
    // some tools (find and re-annotate).
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(180);
  });
});
