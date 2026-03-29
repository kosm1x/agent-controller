/**
 * Tool registry — manages available tools for runners.
 */

import type { ZodType } from "zod";
import type { ToolDefinition } from "../inference/adapter.js";
import type { Tool } from "./types.js";
import { toolMetrics } from "../observability/tool-metrics.js";
import { createLogger } from "../lib/logger.js";
import { jsonSchemaToZod, validateArgs } from "./schema-validator.js";

const log = createLogger("tools");

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
  private readonly schemas = new Map<string, ZodType>();

  /** Register a tool. Compiles its JSON Schema to Zod for validation. */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    try {
      const schema = jsonSchemaToZod(
        tool.definition.function.parameters as Record<string, unknown>,
      );
      if (schema) this.schemas.set(tool.name, schema);
    } catch {
      // Schema conversion failed — tool will execute without validation
    }
  }

  /** Validate args against a tool's compiled Zod schema. */
  validate(
    name: string,
    args: Record<string, unknown>,
  ): { success: true } | { success: false; error: string } {
    const schema = this.schemas.get(name);
    if (!schema) return { success: true }; // no schema = passthrough
    return validateArgs(schema, args);
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
  /** Common LLM misnaming patterns → correct tool name. */
  private static readonly TOOL_ALIASES: Record<string, string> = {
    gsheets_update: "gsheets_write",
    sheets_write: "gsheets_write",
    sheets_update: "gsheets_write",
    sheets_read: "gsheets_read",
    google_sheets_write: "gsheets_write",
    google_sheets_read: "gsheets_read",
    send_email: "gmail_send",
    email_send: "gmail_send",
    search_web: "web_search",
    read_file: "file_read",
    write_file: "file_write",
    edit_file: "file_edit",
  };

  findClosest(name: string): string | null {
    const normalized = name.toLowerCase().replace(/[-\s]/g, "_");
    if (this.tools.has(normalized)) return normalized;

    // Check common aliases before fuzzy matching
    const alias = ToolRegistry.TOOL_ALIASES[normalized];
    if (alias && this.tools.has(alias)) return alias;

    let best: string | null = null;
    let bestDist = Infinity;
    const maxDist = Math.ceil(normalized.length * 0.3);

    for (const registered of this.tools.keys()) {
      // Never fuzzy-match to destructive tools — defense in depth
      if (ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(registered)) continue;
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

  /**
   * Tracks whether destructive tools have been "unlocked" for the current
   * execution cycle. Call `unlockDestructive(name)` after verifying user
   * confirmation in the conversation history.
   */
  private destructiveUnlocked = new Set<string>();

  /** Unlock a destructive tool for execution (call after confirming with user). */
  unlockDestructive(name: string): void {
    this.destructiveUnlocked.add(name);
  }

  /** Reset destructive locks — call at the start of each task/chat turn. */
  resetDestructiveLocks(): void {
    this.destructiveUnlocked.clear();
  }

  /** Execute a tool by name. */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    // Mechanical gate: block destructive MCP tools unless explicitly unlocked.
    // The LLM must ask for user confirmation first; the runner unlocks after
    // seeing the confirmation in conversation history.
    if (
      ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(name) &&
      !this.destructiveUnlocked.has(name)
    ) {
      log.warn(
        { tool: name, args: JSON.stringify(args).slice(0, 200) },
        "destructive tool BLOCKED (no confirmation)",
      );
      return JSON.stringify({
        error: "CONFIRMATION_REQUIRED",
        message:
          "This is a destructive action. You MUST show the user what will be affected and ask for explicit confirmation BEFORE calling this tool. Present the item name, type, and consequences, then wait for user approval.",
        tool: name,
      });
    }
    if (
      tool.requiresConfirmation ||
      ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(name)
    ) {
      log.warn(
        { tool: name, args: JSON.stringify(args).slice(0, 200) },
        "destructive tool called",
      );
    }
    const start = Date.now();
    try {
      const result = await tool.execute(args);
      toolMetrics.record(name, Date.now() - start, true);
      return result;
    } catch (err) {
      toolMetrics.record(name, Date.now() - start, false);
      throw err;
    }
  }

  /** List registered tool names. */
  list(): string[] {
    return Array.from(this.tools.keys());
  }
}

/** Global tool registry singleton. */
export const toolRegistry = new ToolRegistry();
