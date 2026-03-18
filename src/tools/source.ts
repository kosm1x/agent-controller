/**
 * Tool Source plugin interface and manager.
 *
 * Formalizes how tool providers register into the ToolRegistry.
 * Each source has a lifecycle: initialize → register → health check → teardown.
 * Inspired by ComposioHQ/agent-orchestrator's plugin architecture.
 */

import type { ToolRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ToolSourceManifest {
  name: string;
  version: string;
  description: string;
}

export interface ToolSourceHealth {
  healthy: boolean;
  message?: string;
  checkedAt: string;
}

export interface ToolSource {
  readonly manifest: ToolSourceManifest;

  /** Initialize the source (validate config, establish connections). */
  initialize(): Promise<void>;

  /** Register tools into the provided registry. Returns tool names registered. */
  registerTools(registry: ToolRegistry): Promise<string[]>;

  /** Health check. Returns current health status. */
  healthCheck(): Promise<ToolSourceHealth>;

  /** Clean shutdown. Release connections, timers, etc. */
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ToolSourceManager {
  private sources = new Map<string, ToolSource>();
  private sourceTools = new Map<string, string[]>();

  /** Register a tool source. Does NOT initialize it. */
  addSource(source: ToolSource): void {
    this.sources.set(source.manifest.name, source);
  }

  /**
   * Initialize all registered sources and register their tools.
   * Sources are initialized in parallel for faster startup — each source's
   * initialize() + registerTools() runs concurrently. Registry.register()
   * is synchronous and safe to call from multiple async chains since each
   * source registers unique tool names.
   */
  async initAll(
    registry: ToolRegistry,
  ): Promise<{ initialized: number; failed: number; totalTools: number }> {
    let initialized = 0;
    let failed = 0;
    let totalTools = 0;

    const entries = Array.from(this.sources.entries());
    const results = await Promise.allSettled(
      entries.map(async ([name, source]) => {
        await source.initialize();
        const tools = await source.registerTools(registry);
        return { name, tools };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = entries[i][0];
      if (result.status === "fulfilled") {
        this.sourceTools.set(name, result.value.tools);
        totalTools += result.value.tools.length;
        initialized++;
        console.log(
          `[mc] Tool source "${name}" initialized (${result.value.tools.length} tools)`,
        );
      } else {
        failed++;
        this.sourceTools.set(name, []);
        const err = result.reason;
        console.error(
          `[mc] Tool source "${name}" failed to initialize:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { initialized, failed, totalTools };
  }

  /** Run health checks on all sources. */
  async healthCheckAll(): Promise<Record<string, ToolSourceHealth>> {
    const results: Record<string, ToolSourceHealth> = {};
    for (const [name, source] of this.sources) {
      try {
        results[name] = await source.healthCheck();
      } catch (err) {
        results[name] = {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        };
      }
    }
    return results;
  }

  /** Teardown all sources. */
  async teardownAll(): Promise<void> {
    for (const [name, source] of this.sources) {
      try {
        await source.teardown();
      } catch (err) {
        console.error(
          `[mc] Tool source "${name}" teardown error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /** Get source metadata for introspection. */
  getSources(): Array<
    ToolSourceManifest & { toolCount: number; tools: string[] }
  > {
    return Array.from(this.sources.entries()).map(([name, source]) => ({
      ...source.manifest,
      toolCount: this.sourceTools.get(name)?.length ?? 0,
      tools: this.sourceTools.get(name) ?? [],
    }));
  }
}
