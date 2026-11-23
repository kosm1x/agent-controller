/**
 * Memory tool source — registers the memory tools.
 *
 * Two modes: "all" registers memory_search, memory_store, memory_reflect,
 * memory_kg_query and memory_forget; "backend_independent" registers
 * memory_search, memory_kg_query and memory_forget, which work on the local
 * store too.
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";

export type MemoryToolMode = "all" | "backend_independent";

export class MemoryToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest;

  constructor(private readonly mode: MemoryToolMode = "all") {
    this.manifest = {
      name: "memory",
      version: "1.1.0",
      description:
        mode === "all"
          ? "Memory tools (search, store, reflect, kg_query, forget) — Hindsight backend"
          : "Memory tools that work on either store (search, kg_query, forget)",
    };
  }

  async initialize(): Promise<void> {
    // Nothing to set up.
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    const {
      memorySearchTool,
      memoryStoreTool,
      memoryReflectTool,
      memoryKgQueryTool,
      memoryForgetTool,
    } = await import("../builtin/memory.js");

    const tools =
      this.mode === "all"
        ? [
            memorySearchTool,
            memoryStoreTool,
            memoryReflectTool,
            memoryKgQueryTool,
            memoryForgetTool,
          ]
        : [memorySearchTool, memoryKgQueryTool, memoryForgetTool];
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
