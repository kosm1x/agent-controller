/**
 * Dynamic adapter plugin registry.
 *
 * Manages the lifecycle of framework adapter plugins. Supports both built-in
 * adapters (auto-registered on import) and externally loaded plugins.
 *
 * Usage:
 * ```ts
 * import { adapterRegistry } from './registry';
 *
 * // Get an adapter
 * const adapter = adapterRegistry.get('prometheus');
 *
 * // Register a custom plugin
 * adapterRegistry.register({
 *   name: 'my-framework',
 *   version: '1.0.0',
 *   factory: () => new MyAdapter(),
 * });
 * ```
 */

import type { FrameworkAdapter, FrameworkMetadata } from "./types";
import { DefaultAdapter } from "./base";

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

/**
 * A plugin that can be registered with the adapter registry.
 *
 * Plugins provide a factory function that creates adapter instances on demand.
 * The registry calls the factory once per `get()` invocation (adapters are
 * not singletons unless the factory returns the same instance).
 */
export interface AdapterPlugin {
  /** Unique framework name this plugin handles (e.g. "crewai", "langgraph"). */
  readonly name: string;
  /** Semantic version of the plugin. */
  readonly version: string;
  /** Optional human-readable description. */
  readonly description?: string;
  /** Factory that creates a new adapter instance. */
  readonly factory: () => FrameworkAdapter;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Central registry for framework adapter plugins.
 *
 * Provides a type-safe way to register, look up, and enumerate adapters.
 * The registry is a singleton per process (survives HMR via globalThis).
 */
export class AdapterRegistry {
  private readonly plugins = new Map<string, AdapterPlugin>();

  /**
   * Register an adapter plugin.
   *
   * If a plugin with the same name already exists, it is replaced. This
   * allows hot-reloading and version upgrades at runtime.
   *
   * @param plugin - The plugin to register.
   * @throws {Error} If the plugin name is empty.
   */
  register(plugin: AdapterPlugin): void {
    if (!plugin.name || typeof plugin.name !== "string") {
      throw new Error("Plugin name is required and must be a non-empty string");
    }
    if (!plugin.factory || typeof plugin.factory !== "function") {
      throw new Error(
        `Plugin "${plugin.name}" must provide a factory function`,
      );
    }
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Get an adapter instance for a framework.
   *
   * Calls the plugin's factory function to create a new adapter. If no
   * plugin is registered for the given framework, falls back to a
   * `DefaultAdapter` with that framework name.
   *
   * @param framework - The framework identifier.
   * @returns A new adapter instance.
   */
  get(framework: string): FrameworkAdapter {
    const plugin = this.plugins.get(framework);
    if (plugin) {
      return plugin.factory();
    }

    // Fallback: return a generic DefaultAdapter for unknown frameworks.
    // This preserves backward compatibility — any framework string works.
    return new DefaultAdapter(
      framework,
      "1.0.0",
      `Auto-generated adapter for "${framework}"`,
    );
  }

  /**
   * Check whether a plugin is registered for a framework.
   *
   * @param framework - The framework identifier.
   * @returns `true` if a plugin is registered.
   */
  has(framework: string): boolean {
    return this.plugins.has(framework);
  }

  /**
   * List metadata for all registered plugins.
   *
   * @returns Array of metadata objects, one per registered plugin.
   */
  list(): FrameworkMetadata[] {
    const result: FrameworkMetadata[] = [];
    for (const plugin of this.plugins.values()) {
      // Ask the factory for an instance to read its metadata, or build
      // a lightweight metadata object from the plugin descriptor.
      result.push({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        features: [],
      });
    }
    return result;
  }

  /**
   * List the names of all registered frameworks.
   *
   * @returns Array of framework identifier strings.
   */
  listNames(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Remove a plugin from the registry.
   *
   * @param framework - The framework identifier to remove.
   * @returns `true` if the plugin was found and removed.
   */
  unregister(framework: string): boolean {
    return this.plugins.delete(framework);
  }

  /**
   * Remove all registered plugins.
   * Primarily useful for testing.
   */
  clear(): void {
    this.plugins.clear();
  }
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

/**
 * Built-in framework names and their descriptions.
 * Each gets a `DefaultAdapter` with the appropriate identity.
 */
const BUILTIN_FRAMEWORKS: ReadonlyArray<{
  name: string;
  version: string;
  description: string;
  features: string[];
}> = [
  {
    name: "generic",
    version: "1.0.0",
    description: "Generic adapter for unspecified frameworks",
    features: [],
  },
  {
    name: "openclaw",
    version: "1.0.0",
    description: "OpenClaw agent framework adapter",
    features: ["agent-sync", "session-management"],
  },
  {
    name: "crewai",
    version: "1.0.0",
    description: "CrewAI multi-agent framework adapter",
    features: ["crew-management", "role-based-agents"],
  },
  {
    name: "langgraph",
    version: "1.0.0",
    description: "LangGraph state-machine agent adapter",
    features: ["graph-execution", "state-persistence"],
  },
  {
    name: "autogen",
    version: "1.0.0",
    description: "Microsoft AutoGen multi-agent adapter",
    features: ["conversation-patterns", "code-execution"],
  },
  {
    name: "claude-sdk",
    version: "1.0.0",
    description: "Anthropic Claude SDK adapter",
    features: ["tool-use", "streaming"],
  },
];

/**
 * Create a fresh registry pre-loaded with built-in adapters.
 */
function createRegistryWithBuiltins(): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const fw of BUILTIN_FRAMEWORKS) {
    registry.register({
      name: fw.name,
      version: fw.version,
      description: fw.description,
      factory: () =>
        new DefaultAdapter(fw.name, fw.version, fw.description, fw.features),
    });
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js HMR)
// ---------------------------------------------------------------------------

const globalRegistry = globalThis as typeof globalThis & {
  __adapterRegistry?: AdapterRegistry;
};

/**
 * The global adapter registry singleton.
 *
 * Pre-loaded with built-in adapters for generic, openclaw, crewai,
 * langgraph, autogen, and claude-sdk. Additional plugins (e.g. Prometheus)
 * register themselves on import.
 */
export const adapterRegistry: AdapterRegistry =
  globalRegistry.__adapterRegistry ?? createRegistryWithBuiltins();

globalRegistry.__adapterRegistry = adapterRegistry;

// ---------------------------------------------------------------------------
// Convenience functions (backward-compatible API)
// ---------------------------------------------------------------------------

/**
 * Get an adapter for a framework.
 *
 * Drop-in replacement for the old `getAdapter(framework)` function.
 *
 * @param framework - The framework identifier.
 * @returns A new adapter instance.
 */
export function getAdapter(framework: string): FrameworkAdapter {
  return adapterRegistry.get(framework);
}

/**
 * List available adapter names.
 *
 * Drop-in replacement for the old `listAdapters()` function.
 */
export function listAdapters(): string[] {
  return adapterRegistry.listNames();
}
