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
import { skillDescribeTool } from "./builtin/skill-describe.js";
import { skillLoadTool } from "./builtin/skill-load.js";
import { skillRunTool } from "./builtin/skill-run.js";

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
    // v7.7 Spine 3 Phase 4 B2: dispatch surface (L1/L2/execute trio)
    skillDescribeTool,
    skillLoadTool,
    skillRunTool,
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

  it("coverage statistic — production tool count must be exactly tracked", () => {
    // Round-1 audit W3 fix (Spine 4): pin exact count. Loose `>= 180` allowed
    // up to 6 tools to silently regress out of the registry. If a new tool is
    // added or removed, this test trips and the maintainer must update the
    // expected count intentionally — same forcing-function as the syntactic
    // regex-source guards used in earlier spines.
    // 2026-05-15: 186 → 188 (queue #17 — batch_write + batch_delete added).
    // 2026-05-19: 188 → 189 (v7.7 Spine 1 Phase 2a — submit_report added).
    // 2026-05-19: 189 → 192 (v7.7 Spine 3 Phase 4 B2 — skill_describe +
    //                        skill_load + skill_run added per spec §7 L1/L2/exec).
    expect(ALL_TOOLS.length).toBe(192);
  });

  // ──────────────────────────────────────────────────────────────────
  // Sprint 1 R-2 — Tool description length guardrail
  // ──────────────────────────────────────────────────────────────────
  //
  // Smaller tool descriptions = smaller prompts on every fast turn = faster
  // TTFT. T-02 baseline showed mean 50.7 tools loaded per fast task; if mean
  // description is 1500 chars (~375 tokens), catalog is ~19K tokens/task.
  // The guardrail forces any tool above DESC_THRESHOLD to be either trimmed
  // OR explicitly exempted with a reason — same forcing-function as the
  // count invariant above. Bulk trimming of currently-exempted tools is
  // queued for Sprint 2 (see TOOL_DESC_EXCEPTIONS entries below).
  //
  // Threshold of 1500 chars is the current conservative bar — high enough
  // that none of today's truly-load-bearing tool descriptions need surgery.
  // Sprint 2 can lower it once exceptions are trimmed.

  const DESC_THRESHOLD = 1500;
  // Sprint 2 target: lower DESC_THRESHOLD to 1200 once the exception list is
  // trimmed. The current 1500 produces a manageable list (15 outliers); 1200
  // would surface 11 additional tools that are reasonable trim candidates.

  // Exceptions: tool names that legitimately exceed DESC_THRESHOLD. Each
  // entry has a `maxLen` (per-tool ceiling) AND `reason`. The per-tool
  // ceiling closes a one-sided guardrail: without it, an already-exempted
  // tool could grow without bound (audit W1). `maxLen` is the current
  // length + a small slack; growth past it requires either a deliberate
  // raise or a trim — same forcing function as the exact-count test above.
  const TOOL_DESC_EXCEPTIONS: Record<
    string,
    { maxLen: number; reason: string }
  > = {
    // 15 outliers as of 2026-05-23 (Sprint 1 R-2 ship). Each retains its
    // detailed description because it encodes load-bearing routing/safety
    // semantics the LLM consults turn-by-turn (permanent-vs-transient error
    // policy, safety aborts, parent-FK resolution, batch caps, idempotency,
    // confirmation flows, etc.).
    //
    // Sprint 2 first targets the >2500-char outliers — halving those three
    // alone trims ~5400 chars from the catalog. maxLen = current_len + 50
    // slack (lets minor edits pass without re-tripping the test).
    video_html_compose: {
      maxLen: 5328,
      reason: "HTML/CSS composition rules + render policy",
    },
    northstar_sync: {
      maxLen: 2978,
      reason:
        "4-phase sync architecture + LWW + safety abort (2026-05-12 incident)",
    },
    infographic_generate: {
      maxLen: 2601,
      reason: "chart taxonomy + spec validation + format constraints",
    },
    google_workspace_cli: {
      maxLen: 2644,
      reason: "dispatch routing across Google Workspace APIs",
    },
    submit_report: {
      maxLen: 2174,
      reason: "quality-gate ritual instructions for report drafts",
    },
    wp_publish: {
      maxLen: 2107,
      reason: "WordPress publish policy + idempotency rules",
    },
    hf_generate: {
      maxLen: 2067,
      reason: "HuggingFace task taxonomy + model selection guidance",
    },
    user_fact_set: {
      maxLen: 1977,
      reason: "fact-persistence policy + conflict-resolution rules",
    },
    gdrive_download: {
      maxLen: 1839,
      reason: "binary-vs-export disambiguation + size limits",
    },
    skill_run: {
      maxLen: 1795,
      reason: "skill invocation contract + arg-validation rules",
    },
    jarvis_file_write: {
      maxLen: 1989,
      reason: "KB write policy + tag conventions + path rules",
    },
    jarvis_file_read: {
      maxLen: 1630,
      reason: "KB read modes (by path vs by tags) + result shape",
    },
    jarvis_files_batch_write: {
      maxLen: 1668,
      reason: "batch write contract + cap + partial-error policy",
    },
    jarvis_files_batch_delete: {
      maxLen: 1648,
      reason: "batch delete contract + confirmation + precious-path scan",
    },
    gemini_research: {
      maxLen: 1597,
      reason: "Gemini Q&A research mode + document reference shape",
    },
  };

  it("every production tool has description ≤ DESC_THRESHOLD chars OR is documented in TOOL_DESC_EXCEPTIONS", () => {
    const violations: Array<{ name: string; len: number }> = [];
    for (const tool of ALL_TOOLS) {
      const desc = tool.definition.function.description ?? "";
      const name = tool.definition.function.name;
      if (desc.length > DESC_THRESHOLD && !(name in TOOL_DESC_EXCEPTIONS)) {
        violations.push({ name, len: desc.length });
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} tool description(s) exceed ${DESC_THRESHOLD} chars without exception:\n  ` +
          violations
            .sort((a, b) => b.len - a.len)
            .map((v) => `${v.name} (${v.len} chars)`)
            .join("\n  ") +
          `\n\nEither trim the description, or add an entry to TOOL_DESC_EXCEPTIONS with { maxLen, reason }.`,
      );
    }
  });

  it("documented exceptions are still valid (each references a tool in ALL_TOOLS)", () => {
    const allToolNames = new Set(
      ALL_TOOLS.map((t) => t.definition.function.name),
    );
    const stale = Object.keys(TOOL_DESC_EXCEPTIONS).filter(
      (n) => !allToolNames.has(n),
    );
    if (stale.length > 0) {
      throw new Error(
        `Stale entries in TOOL_DESC_EXCEPTIONS (no matching tool):\n  ` +
          stale.join("\n  ") +
          `\n\nRemove these entries from the exception list.`,
      );
    }
  });

  it("exempted tools must actually exceed DESC_THRESHOLD (no stale 'safety net' entries)", () => {
    // Catches the dual case: a tool was exempted, later trimmed below
    // threshold, but the exception was forgotten. Forces clean-up.
    const tooSmall: Array<{ name: string; len: number }> = [];
    for (const tool of ALL_TOOLS) {
      const name = tool.definition.function.name;
      if (name in TOOL_DESC_EXCEPTIONS) {
        const desc = tool.definition.function.description ?? "";
        if (desc.length <= DESC_THRESHOLD) {
          tooSmall.push({ name, len: desc.length });
        }
      }
    }
    if (tooSmall.length > 0) {
      throw new Error(
        `Exempted tools no longer exceed ${DESC_THRESHOLD} chars (exception is stale):\n  ` +
          tooSmall.map((v) => `${v.name} (${v.len} chars)`).join("\n  ") +
          `\n\nRemove these tools from TOOL_DESC_EXCEPTIONS.`,
      );
    }
  });

  it("exempted tools must not exceed their per-entry maxLen (drift cap — audit W1)", () => {
    // Closes the one-sided guardrail: without this, an already-exempted
    // tool's description could grow without bound while the other three
    // tests still pass. Per-entry maxLen forces a deliberate raise (and
    // implicit re-review) any time a long description gets longer.
    const overgrown: Array<{ name: string; len: number; maxLen: number }> = [];
    for (const tool of ALL_TOOLS) {
      const name = tool.definition.function.name;
      const entry = TOOL_DESC_EXCEPTIONS[name];
      if (entry) {
        const desc = tool.definition.function.description ?? "";
        if (desc.length > entry.maxLen) {
          overgrown.push({ name, len: desc.length, maxLen: entry.maxLen });
        }
      }
    }
    if (overgrown.length > 0) {
      throw new Error(
        `Exempted tool description(s) grew past their per-entry maxLen:\n  ` +
          overgrown
            .map((v) => `${v.name}: ${v.len} chars (cap ${v.maxLen})`)
            .join("\n  ") +
          `\n\nEither trim back below maxLen, or deliberately raise maxLen in TOOL_DESC_EXCEPTIONS.`,
      );
    }
  });
});
