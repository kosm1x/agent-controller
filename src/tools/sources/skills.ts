/**
 * Skills tool source — registers skill management + dispatch tools
 * (SQLite-backed).
 *
 * v7.7 Spine 3 Phase 4 B2 added the L1/L2/execute disclosure trio
 * (`skill_describe`, `skill_load`, `skill_run`) per spec §7 + §11 Mode 2.
 * All three default `deferred: true` so they don't bloat the prompt
 * until the LLM commits to inspecting / invoking a specific skill.
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";

export class SkillsToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "skills",
    version: "1.1.0",
    description:
      "Saved skill tools (save, list) + S5 dispatch (describe, load, run)",
  };

  async initialize(): Promise<void> {
    // Skills are SQLite-backed, always available
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    const { skillSaveTool, skillListTool } =
      await import("../builtin/skills.js");
    const { skillDescribeTool } = await import("../builtin/skill-describe.js");
    const { skillLoadTool } = await import("../builtin/skill-load.js");
    const { skillRunTool } = await import("../builtin/skill-run.js");

    const tools = [
      skillSaveTool,
      skillListTool,
      skillDescribeTool,
      skillLoadTool,
      skillRunTool,
    ];
    for (const tool of tools) {
      registry.register(tool);
    }
    return tools.map((t) => t.name);
  }

  async healthCheck(): Promise<ToolSourceHealth> {
    return { healthy: true, checkedAt: new Date().toISOString() };
  }

  async teardown(): Promise<void> {
    // No resources to release
  }
}
