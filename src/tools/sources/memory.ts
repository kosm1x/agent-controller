/**
 * Memory tool source — registers Hindsight memory tools (conditional).
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";

export class MemoryToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "memory",
    version: "1.0.0",
    description: "Hindsight memory tools (search, store, reflect)",
  };

  async initialize(): Promise<void> {
    // Hindsight availability already checked before this source is added
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    const {
      memorySearchTool,
      memoryStoreTool,
      memoryReflectTool,
      memoryKgQueryTool,
    } = await import("../builtin/memory.js");

    const tools = [
      memorySearchTool,
      memoryStoreTool,
      memoryReflectTool,
      memoryKgQueryTool,
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
