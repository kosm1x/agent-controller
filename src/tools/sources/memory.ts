/**
 * Memory tool source — registers the memory tools.
 *
 * Two modes (2026-09-12): "all" needs the Hindsight backend (search / store /
 * reflect go through the memory service); "backend_independent" registers
 * only the tools that read SQLite / pgvector directly (memory_kg_query,
 * memory_forget). Before this, the WHOLE source was skipped when Hindsight
 * was off — which is production since the SQLite cutover — so those two
 * tools were never registered at all ("registry holds 232", not 233).
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
          : "Memory tools that need no Hindsight (kg_query, forget)",
    };
  }

  async initialize(): Promise<void> {
    // Hindsight availability already checked before this source is added
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
        : [memoryKgQueryTool, memoryForgetTool];
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
