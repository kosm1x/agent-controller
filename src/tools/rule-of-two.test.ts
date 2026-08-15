/**
 * Rule of Two (V8.5 Phase 5.2) — classification coverage, the structural
 * single-tool rule, run-level composition, and the run context.
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry.js";
import {
  BUILTIN_TOOLS,
  CRM_TOOLS,
  GWS_TOOLS,
  WP_TOOLS,
} from "./sources/builtin.js";
import { GoogleToolSource } from "./sources/google.js";
import { MemoryToolSource } from "./sources/memory.js";
import { SkillsToolSource } from "./sources/skills.js";
import { readFileSync } from "fs";
import { getMcpToolHints } from "../mcp/annotations.js";
import { getToolAnnotations, type Tool } from "./types.js";
import {
  RULE_OF_TWO_CLASSIFICATION,
  RULE_OF_TWO_MCP_OVERRIDES,
  RULE_OF_TWO_PREFIX_DEFAULTS,
  enterRunToolContext,
  outsideRunToolContext,
  isRuleOfTwoClassified,
  isTrifectaByName,
  priorRunTools,
  recordRunTool,
  resolveRuleOfTwo,
  ruleOfTwoState,
} from "./rule-of-two.js";

/** Every host-defined tool the live registry can hold (all env-gated groups included). */
async function allHostTools(): Promise<Tool[]> {
  const registry = new ToolRegistry();
  for (const t of [...BUILTIN_TOOLS, ...WP_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS])
    registry.register(t);
  await new GoogleToolSource().registerTools(registry);
  await new MemoryToolSource().registerTools(registry);
  await new SkillsToolSource().registerTools(registry);
  return registry.list().map((n) => registry.get(n)!);
}

function fake(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    definition: {
      type: "function",
      function: { name, description: "x", parameters: { type: "object" } },
    },
    execute: async () => "ok",
    ...extra,
  };
}

describe("Rule of Two — classification coverage (both directions)", () => {
  it("every host-defined tool has an EXPLICIT classification (no true/true fallback)", async () => {
    const tools = await allHostTools();
    expect(tools.length).toBeGreaterThan(150);
    const missing = tools
      .map((t) => t.name)
      .filter((n) => !Object.hasOwn(RULE_OF_TWO_CLASSIFICATION, n));
    expect(
      missing,
      `unclassified builtin tools: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every classification key names a real host-defined tool (no dead entries)", async () => {
    const names = new Set((await allHostTools()).map((t) => t.name));
    const dead = Object.keys(RULE_OF_TWO_CLASSIFICATION).filter(
      (k) => !names.has(k),
    );
    expect(dead, `stale classification keys: ${dead.join(", ")}`).toEqual([]);
  });

  it("MCP prefix defaults cover every server id in mcp-servers.json", () => {
    const cfg = JSON.parse(readFileSync("mcp-servers.json", "utf-8")) as
      | { mcpServers?: Record<string, unknown> }
      | Record<string, unknown>;
    const ids = Object.keys(
      (cfg as { mcpServers?: Record<string, unknown> }).mcpServers ?? cfg,
    );
    expect(ids.length).toBeGreaterThan(0);
    const prefixes = RULE_OF_TWO_PREFIX_DEFAULTS.map(([p]) => p);
    for (const id of ids)
      expect(
        prefixes,
        `MCP server '${id}' has no Rule-of-Two prefix default — its non-readOnly tools would ALL flip to high/confirm`,
      ).toContain(`${id}__`);
    expect(isRuleOfTwoClassified("browser__goto")).toBe(true);
    expect(isRuleOfTwoClassified("unknown-server__thing")).toBe(false);
  });

  it("every MCP per-tool override names a tool under a known prefix", () => {
    const prefixes = RULE_OF_TWO_PREFIX_DEFAULTS.map(([p]) => p);
    for (const name of Object.keys(RULE_OF_TWO_MCP_OVERRIDES))
      expect(prefixes.some((p) => name.startsWith(p)), name).toBe(true);
  });

  it("prototype-chain names never classify (qa W1): unknown = riskier, and not 'classified'", () => {
    for (const n of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(resolveRuleOfTwo({ name: n }), n).toEqual({
        untrustedInput: true,
        sensitiveAccess: true,
      });
      expect(isRuleOfTwoClassified(n), n).toBe(false);
      expect(isTrifectaByName(n), n).toBe(true);
    }
  });
});

/**
 * The 43 MCP tool names the live registry held at the 2026-08-14 20:39 boot
 * (browser 10 + graphify-code 7 + xpoz 5 + playwright 21 lazy). MCP tools
 * never enter `allHostTools()`, so the trifecta pin below covers them via
 * this fixture with the SAME hints `McpManager` applies (`getMcpToolHints`).
 * Add names here when a server grows; the pin tells you which flipped.
 */
const LIVE_MCP_NAMES = [
  ...["click", "evaluate", "fill", "goto", "interactiveElements", "links", "markdown", "scroll", "semantic_tree", "structuredData"].map((t) => `browser__${t}`),
  ...["get_community", "get_neighbors", "get_node", "god_nodes", "graph_stats", "query_graph", "shortest_path"].map((t) => `graphify-code__${t}`),
  ...["xpoz_get_digest", "xpoz_get_history", "xpoz_get_job_status", "xpoz_get_topics", "xpoz_trigger_run"].map((t) => `xpoz__${t}`),
  ...["browser_click", "browser_close", "browser_console_messages", "browser_drag", "browser_evaluate", "browser_file_upload", "browser_fill_form", "browser_handle_dialog", "browser_hover", "browser_navigate", "browser_navigate_back", "browser_network_requests", "browser_press_key", "browser_resize", "browser_run_code_unsafe", "browser_select_option", "browser_snapshot", "browser_tabs", "browser_take_screenshot", "browser_type", "browser_wait_for"].map((t) => `playwright__${t}`),
];

function mcpFixtureTool(name: string): Tool {
  const hints = getMcpToolHints(name);
  return fake(name, {
    deferred: false,
    ...(hints && {
      readOnlyHint: hints.readOnlyHint,
      destructiveHint: hints.destructiveHint,
      idempotentHint: hints.idempotentHint,
      openWorldHint: hints.openWorldHint,
    }),
  });
}

describe("Rule of Two — MCP registry (live-name fixture, qa C1)", () => {
  it("fixture has 43 names, all classified via override or prefix", () => {
    expect(LIVE_MCP_NAMES).toHaveLength(43);
    for (const n of LIVE_MCP_NAMES) expect(isRuleOfTwoClassified(n), n).toBe(true);
  });

  it("NO MCP tool is a single-tool trifecta and none changes effective tier", () => {
    const flips: string[] = [];
    for (const n of LIVE_MCP_NAMES) {
      const t = mcpFixtureTool(n);
      const a = getToolAnnotations(t);
      expect(a.ruleOfTwoTrifecta, `${n} is a trifecta`).toBe(false);
      const declared = t.riskTier ?? (t.requiresConfirmation ? "high" : "low");
      if (a.riskTier !== declared) flips.push(`${n} ${declared}→${a.riskTier}`);
    }
    expect(flips).toEqual([]);
  });

  it("xpoz trigger/status are B-only overrides; xpoz reads keep A+B", () => {
    expect(resolveRuleOfTwo({ name: "xpoz__xpoz_trigger_run" })).toEqual({
      untrustedInput: false,
      sensitiveAccess: true,
    });
    expect(resolveRuleOfTwo({ name: "xpoz__xpoz_get_digest" })).toEqual({
      untrustedInput: true,
      sensitiveAccess: true,
    });
    // Mutation-verify: without the override the trigger (a destructive verb) WOULD flip.
    const noOverride = getToolAnnotations(
      fake("xpoz__xpoz_trigger_run", {
        readOnlyHint: false,
        untrustedInputHint: true,
        sensitiveAccessHint: true,
      }),
    );
    expect(noOverride.riskTier).toBe("high");
  });
});

describe("Rule of Two — resolveRuleOfTwo precedence + pinned rulings", () => {
  it("unknown name ⇒ true/true (unknown = riskier)", () => {
    expect(resolveRuleOfTwo({ name: "totally_unknown" })).toEqual({
      untrustedInput: true,
      sensitiveAccess: true,
    });
  });
  it("prefix default applies to MCP-namespaced names", () => {
    expect(resolveRuleOfTwo({ name: "browser__goto" })).toEqual({
      untrustedInput: true,
      sensitiveAccess: false,
    });
    expect(resolveRuleOfTwo({ name: "graphify-code__query_graph" })).toEqual({
      untrustedInput: false,
      sensitiveAccess: true,
    });
  });
  it("explicit tool fields override the table", () => {
    expect(
      resolveRuleOfTwo({
        name: "gmail_read",
        untrustedInputHint: false,
        sensitiveAccessHint: false,
      }),
    ).toEqual({ untrustedInput: false, sensitiveAccess: false });
  });
  it("KB reads are TRUSTED tier (operator ruling 2026-08-15): B only, never A", () => {
    for (const n of [
      "jarvis_file_read",
      "jarvis_file_search",
      "jarvis_file_list",
      "memory_search",
      "knowledge_map",
    ]) {
      expect(resolveRuleOfTwo({ name: n }), n).toEqual({
        untrustedInput: false,
        sensitiveAccess: true,
      });
    }
  });
  it("ingest edges and mail reads are A+B; shell is B only (args-borne residual)", () => {
    expect(resolveRuleOfTwo({ name: "kb_ingest_pdf_structured" })).toEqual({
      untrustedInput: true,
      sensitiveAccess: true,
    });
    expect(resolveRuleOfTwo({ name: "gmail_read" })).toEqual({
      untrustedInput: true,
      sensitiveAccess: true,
    });
    expect(resolveRuleOfTwo({ name: "shell_exec" })).toEqual({
      untrustedInput: false,
      sensitiveAccess: true,
    });
    expect(resolveRuleOfTwo({ name: "web_search" })).toEqual({
      untrustedInput: true,
      sensitiveAccess: false,
    });
  });
});

describe("Rule of Two — structural single-tool rule (Layer 1)", () => {
  it("the single-tool trifecta set over the real registry is EXACTLY the reviewed five", async () => {
    // Pinned deliberately: adding a trifecta tool changes live confirm behavior
    // (riskTier high) and must be a reviewed change to this list.
    const tools = await allHostTools();
    const trifecta = tools
      .filter((t) => getToolAnnotations(t).ruleOfTwoTrifecta)
      .map((t) => t.name)
      .sort();
    expect(trifecta).toEqual([
      "google_workspace_cli",
      "jarvis_dev",
      "kb_ingest_pdf_structured",
      "skill_run",
      "wp_raw_api",
    ]);
    for (const n of trifecta) expect(isTrifectaByName(n)).toBe(true);
    expect(isTrifectaByName("gmail_send")).toBe(false);
    expect(isTrifectaByName("gmail_read")).toBe(true); // A∧B (C assumed for a gated write)
  });

  it("trifecta ⇒ riskTier high + requiresConfirmation even when the definition says low", () => {
    const t = fake("t_low", {
      riskTier: "low",
      readOnlyHint: false,
      untrustedInputHint: true,
      sensitiveAccessHint: true,
    });
    const a = getToolAnnotations(t);
    expect(a.ruleOfTwoTrifecta).toBe(true);
    expect(a.riskTier).toBe("high");
    expect(a.requiresConfirmation).toBe(true);
    // Mutation-verify: drop ONE property and the rule releases.
    const ro = getToolAnnotations(fake("t_ro", { ...t, readOnlyHint: true }));
    expect(ro.ruleOfTwoTrifecta).toBe(false);
    expect(ro.riskTier).toBe("low");
    expect(ro.requiresConfirmation).toBe(false);
    const noA = getToolAnnotations(
      fake("t_noA", { ...t, untrustedInputHint: false }),
    );
    expect(noA.riskTier).toBe("low");
  });

  it("the live delta: four previously low/medium tools become high; jarvis_dev already was", async () => {
    const byName = new Map((await allHostTools()).map((t) => [t.name, t]));
    const declared = (n: string) => {
      const t = byName.get(n)!;
      return t.riskTier ?? (t.requiresConfirmation ? "high" : "low");
    };
    // These pin the DECLARED tiers so the delta stays documented; if you raise
    // a declared tier deliberately, update this pin — nothing about the Rule
    // of Two itself is broken by that.
    const pin =
      "declared-tier delta pin (update if the definition changed on purpose)";
    expect(declared("google_workspace_cli"), pin).toBe("low");
    expect(declared("kb_ingest_pdf_structured"), pin).toBe("low");
    expect(declared("skill_run"), pin).toBe("medium");
    expect(declared("wp_raw_api"), pin).toBe("medium");
    expect(declared("jarvis_dev"), pin).toBe("high");
    for (const n of [
      "google_workspace_cli",
      "kb_ingest_pdf_structured",
      "skill_run",
      "wp_raw_api",
      "jarvis_dev",
    ])
      expect(getToolAnnotations(byName.get(n)!).riskTier, n).toBe("high");
    // Non-trifecta high-frequency tools keep their declared tier — no friction change.
    expect(getToolAnnotations(byName.get("shell_exec")!).riskTier).toBe("low");
    expect(getToolAnnotations(byName.get("jarvis_file_read")!).riskTier).toBe(
      "low",
    );
  });

  it("ToolRegistry.getEffectiveRiskTier delegates to the resolver (no path around the rule)", () => {
    const registry = new ToolRegistry();
    registry.register(
      fake("sneaky", {
        riskTier: "low",
        readOnlyHint: false,
        untrustedInputHint: true,
        sensitiveAccessHint: true,
      }),
    );
    expect(registry.getEffectiveRiskTier("sneaky")).toBe("high");
    expect(registry.annotationsOf("sneaky")?.ruleOfTwoTrifecta).toBe(true);
    expect(registry.annotationsOf("nope")).toBeUndefined();
  });
});

describe("Rule of Two — run-level composition (Layer 2)", () => {
  const registry = new ToolRegistry();
  registry.register(
    fake("readmail", {
      readOnlyHint: true,
      untrustedInputHint: true,
      sensitiveAccessHint: true,
    }),
  );
  registry.register(
    fake("sendmail", {
      readOnlyHint: false,
      untrustedInputHint: false,
      sensitiveAccessHint: true,
    }),
  );
  registry.register(
    fake("fetchweb", {
      readOnlyHint: true,
      untrustedInputHint: true,
      sensitiveAccessHint: false,
    }),
  );
  registry.register(
    fake("postweb", {
      readOnlyHint: false,
      untrustedInputHint: false,
      sensitiveAccessHint: false,
    }),
  );
  const resolve = (n: string) => registry.annotationsOf(n);

  it("A+B read then C write ⇒ trifecta; each alone is not", () => {
    expect(ruleOfTwoState(["readmail"], resolve).trifecta).toBe(false);
    expect(ruleOfTwoState(["sendmail"], resolve).trifecta).toBe(false);
    expect(ruleOfTwoState(["readmail", "sendmail"], resolve)).toEqual({
      untrustedInput: true,
      sensitiveAccess: true,
      stateChange: true,
      trifecta: true,
    });
  });
  it("A+C without B is allowed (web in, web out, no private data)", () => {
    expect(ruleOfTwoState(["fetchweb", "postweb"], resolve).trifecta).toBe(
      false,
    );
  });
  it("an unknown name counts as all three (fail toward demotion)", () => {
    expect(ruleOfTwoState(["ghost"], resolve).trifecta).toBe(true);
    expect(ruleOfTwoState([], resolve).trifecta).toBe(false);
  });

  it("run context: prior tools accumulate in order; UNDEFINED outside a run (fail-closed signal)", async () => {
    expect(priorRunTools()).toBeUndefined();
    recordRunTool("outside"); // no-op outside a run
    expect(priorRunTools()).toBeUndefined();
    await enterRunToolContext("task-1", async () => {
      expect(priorRunTools()).toEqual([]);
      recordRunTool("readmail");
      expect(priorRunTools()).toEqual(["readmail"]);
      recordRunTool("sendmail");
      recordRunTool("readmail"); // set semantics
      expect(priorRunTools()).toEqual(["readmail", "sendmail"]);
    });
    expect(priorRunTools()).toBeUndefined();
  });

  it("nested dispatch INHERITS the parent's set (swarm sub-tasks compose; qa W2)", async () => {
    await enterRunToolContext("parent", async () => {
      recordRunTool("readmail");
      await enterRunToolContext("child", async () => {
        expect(priorRunTools()).toEqual(["readmail"]); // child sees parent's prior
        recordRunTool("sendmail");
      });
      expect(priorRunTools()).toEqual(["readmail", "sendmail"]); // parent sees child's
    });
    // Sibling contexts started OUTSIDE each other do not share.
    await enterRunToolContext("solo", async () => {
      expect(priorRunTools()).toEqual([]);
    });
  });

  it("outsideRunToolContext drops the ambient store (queue drain, qa R2 W-A): no inherit, no leak-back", async () => {
    await enterRunToolContext("finishing-run", async () => {
      recordRunTool("gmail_read");
      await outsideRunToolContext(async () => {
        expect(priorRunTools()).toBeUndefined(); // dequeued task sees NO foreign prior
        recordRunTool("stray"); // no-op outside a run
        await enterRunToolContext("dequeued", async () => {
          expect(priorRunTools()).toEqual([]); // fresh session, not the finishing run's
          recordRunTool("sendmail");
        });
      });
      expect(priorRunTools()).toEqual(["gmail_read"]); // nothing leaked back
    });
  });

  it("ToolRegistry.execute records the run's tools (prior snapshot precedes the call)", async () => {
    const seen: string[][] = [];
    const reg = new ToolRegistry();
    reg.register(
      fake("a", {
        execute: async () => (seen.push([...(priorRunTools() ?? [])]), "1"),
      }),
    );
    reg.register(
      fake("b", {
        execute: async () => (seen.push([...(priorRunTools() ?? [])]), "2"),
      }),
    );
    await enterRunToolContext("task-2", async () => {
      await reg.execute("a", {});
      await reg.execute("b", {});
    });
    // Inside `a`, `a` is already recorded (recorded before dispatch) but `b` is not.
    expect(seen).toEqual([["a"], ["a", "b"]]);
  });
});
