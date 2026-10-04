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
