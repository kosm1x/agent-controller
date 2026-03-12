/**
 * Tool registry — manages available tools for runners.
 */

import type { ToolDefinition } from "../inference/adapter.js";
import type { Tool } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Register a tool. Replaces if name already exists. */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Get a tool by name. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get tool definitions for LLM function calling. Optionally filter by name list. */
  getDefinitions(names?: string[]): ToolDefinition[] {
    if (names && names.length > 0) {
      return names
        .map((n) => this.tools.get(n))
        .filter((t): t is Tool => t !== undefined)
        .map((t) => t.definition);
    }
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Execute a tool by name. */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    return tool.execute(args);
  }

  /** List registered tool names. */
  list(): string[] {
    return Array.from(this.tools.keys());
  }
}

/** Global tool registry singleton. */
export const toolRegistry = new ToolRegistry();
