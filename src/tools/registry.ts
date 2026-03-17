/**
 * Tool registry — manages available tools for runners.
 */

import type { ToolDefinition } from "../inference/adapter.js";
import type { Tool } from "./types.js";

/** Compute Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

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

  /**
   * Find the closest matching tool name via normalization + fuzzy match.
   * Returns null if no match within 30% edit distance.
   */
  findClosest(name: string): string | null {
    const normalized = name.toLowerCase().replace(/[-\s]/g, "_");
    if (this.tools.has(normalized)) return normalized;

    let best: string | null = null;
    let bestDist = Infinity;
    const maxDist = Math.ceil(normalized.length * 0.3);

    for (const registered of this.tools.keys()) {
      const dist = levenshtein(normalized, registered);
      if (dist < bestDist && dist <= maxDist) {
        bestDist = dist;
        best = registered;
      }
    }
    return best;
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

  /** MCP tools that require confirmation (can't be tagged via interface). */
  private static readonly DESTRUCTIVE_MCP_TOOLS = new Set([
    "commit__delete_item",
  ]);

  /** Execute a tool by name. */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    if (
      tool.requiresConfirmation ||
      ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(name)
    ) {
      console.warn(
        `[tools] ⚠️ Destructive tool called: ${name} — args: ${JSON.stringify(args).slice(0, 200)}`,
      );
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
