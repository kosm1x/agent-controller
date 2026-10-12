/**
 * The tool population the model-swap eval gate offers the model.
 *
 * Production (`src/index.ts`) registers the builtin source plus Google, MCP,
 * memory and skills sources, and the builtin source itself adds its WordPress,
 * CRM and gws groups only when their env vars are set. The gate used to add
 * the builtin source alone, so every Google tool (a separate source) was
 * unreachable and the WP/CRM/gws groups came and went with the inherited env.
 *
 * Here every source that registers deterministically is added unconditionally:
 * `registerTools()` only builds definitions — no env value is read, no service
 * is contacted (`initialize()` is skipped: Google's only checks env presence),
 * and the probe never executes a tool. MCP-server tools stay out: they exist
 * only once their server processes run, so they are reported unreachable.
 */

import type { ToolRegistry } from "../tools/registry.js";
import type { ScopePattern } from "./types.js";

export async function registerEvalGateTools(
  registry: ToolRegistry,
): Promise<void> {
  const { BuiltinToolSource, WP_TOOLS, CRM_TOOLS, GWS_TOOLS } =
    await import("../tools/sources/builtin.js");
  const { GoogleToolSource } = await import("../tools/sources/google.js");
  const { SkillsToolSource } = await import("../tools/sources/skills.js");
  const { MemoryToolSource } = await import("../tools/sources/memory.js");

  await new BuiltinToolSource().registerTools(registry);
  for (const tool of [...WP_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS]) {
    registry.register(tool);
  }
  await new GoogleToolSource().registerTools(registry);
  await new SkillsToolSource().registerTools(registry);
  // Production's mode while the memory backend is not Hindsight (the default).
  await new MemoryToolSource("backend_independent").registerTools(registry);
}

/**
 * S6 WS3a: the record-derived scope groups, wired exactly as boot does
 * (`src/index.ts`). The MCP config is LOADED (no server is spawned) only for
 * the record server ids. The gate scores scope with a pattern LIST
 * (`SandboxConfig.scopePatternOverrides`, else a frozen copy of
 * `CODE_SCOPE_PATTERNS`), so the derived regexes come back as
 * `scopePatternOverrides` = code patterns + derived ones (undefined when no
 * record declares a group: the gate then runs exactly as before). The
 * classifier-prompt line is registered but no gate case reads it: it stays
 * unmeasured until a prompt scorer exists (queue 3j). MCP tools are never
 * registered here, so a derived group's tool list is empty in the gate.
 * Call once, after `registerEvalGateTools`, before any case runs.
 */
export async function wireEvalGateProjectScopeGroups(
  registry: ToolRegistry,
): Promise<{ names: string[]; scopePatternOverrides?: ScopePattern[] }> {
  const { McpToolSource } = await import("../tools/sources/mcp.js");
  const { wireProjectScopeGroups } = await import("../projects/scope-wiring.js");
  const { listProjects } = await import("../db/projects.js");
  const { CODE_SCOPE_PATTERNS } = await import("../messaging/scope.js");
  const mcp = new McpToolSource();
  let serverIds = new Map<string, string[]>();
  try {
    await mcp.initialize();
    serverIds = mcp.recordServerIds();
  } catch (err) {
    console.warn(
      `[eval-gate] MCP config not loaded (${err instanceof Error ? err.message : String(err)}); derived groups get no server ids`,
    );
  }
  const derived = wireProjectScopeGroups(listProjects("active"), serverIds, () => registry.list());
  return {
    names: derived.groups.map((g) => g.name),
    ...(derived.regexes.length > 0 && {
      scopePatternOverrides: [...CODE_SCOPE_PATTERNS, ...derived.regexes],
    }),
  };
}
