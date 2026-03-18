/**
 * Skills tool source — registers skill save/list tools (SQLite-backed).
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
    version: "1.0.0",
    description: "Saved skill tools (save, list)",
  };

  async initialize(): Promise<void> {
    // Skills are SQLite-backed, always available
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    const { skillSaveTool, skillListTool } =
      await import("../builtin/skills.js");

    const tools = [skillSaveTool, skillListTool];
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
