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

  /**
   * Get tool definitions for LLM function calling. Optionally filter by name list.
   * When `excludeDeferred` is true, tools marked `deferred: true` are omitted —
   * use `getDeferredCatalog()` to include them as a text summary instead.
   */
  getDefinitions(names?: string[], excludeDeferred = false): ToolDefinition[] {
    let tools: Tool[];
    if (names && names.length > 0) {
      tools = names
        .map((n) => this.tools.get(n))
        .filter((t): t is Tool => t !== undefined);
    } else {
      tools = Array.from(this.tools.values());
    }
    if (excludeDeferred) {
      tools = tools.filter((t) => !t.deferred);
    }
    return tools.map((t) => t.definition);
  }

  /**
   * Build a text catalog of deferred tools (name + description only).
   * Injected as a system message so the LLM knows these tools exist
   * but doesn't carry their full parameter schemas in context.
   * Returns null if no deferred tools match the scope.
   */
  getDeferredCatalog(names?: string[]): string | null {
    let tools: Tool[];
    if (names && names.length > 0) {
      tools = names
        .map((n) => this.tools.get(n))
        .filter((t): t is Tool => t !== undefined && t.deferred === true);
    } else {
      tools = Array.from(this.tools.values()).filter((t) => t.deferred);
    }
    if (tools.length === 0) return null;
    const lines = tools.map((t) => {
      let line = `- **${t.name}**: ${t.definition.function.description.slice(0, 120)}`;
      // v6.4 CL1.4: Append trigger phrases so the LLM matches informal requests
      if (t.triggerPhrases && t.triggerPhrases.length > 0) {
        line += ` [triggers: ${t.triggerPhrases.join(", ")}]`;
      }
      return line;
    });
    return `[DEFERRED TOOLS] The following tools are available but their full schemas are not loaded. Call any of them by name — the system will return the parameter schema so you can retry with correct arguments.\n\n${lines.join("\n")}`;
  }

  /** MCP tools that require confirmation (can't be tagged via interface). */
  private static readonly DESTRUCTIVE_MCP_TOOLS = new Set<string>([]);

  /** Check if a tool is in the hard-blocked destructive MCP set. */
  isDestructiveMcp(name: string): boolean {
    return ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(name);
  }

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

  /**
   * CCP5: Get effective risk tier for a tool.
   * Priority: explicit riskTier > requiresConfirmation (→ high) > default (low).
   */
  getEffectiveRiskTier(name: string): "low" | "medium" | "high" {
    const tool = this.tools.get(name);
    if (!tool) return "low";
    if (tool.riskTier) return tool.riskTier;
    if (tool.requiresConfirmation) return "high";
    if (ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(name)) return "high";
    return "low";
  }

  /** Execute a tool by name. */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    // CCP5: Tiered risk assessment gate.
    const riskTier = this.getEffectiveRiskTier(name);

    // HIGH: Block until explicitly unlocked (confirmation required)
    if (
      (riskTier === "high" || ToolRegistry.DESTRUCTIVE_MCP_TOOLS.has(name)) &&
      !this.destructiveUnlocked.has(name)
    ) {
      log.warn(
        { tool: name, riskTier, args: JSON.stringify(args).slice(0, 200) },
        "destructive tool BLOCKED (no confirmation)",
      );
      return JSON.stringify({
        error: "CONFIRMATION_REQUIRED",
        message:
          "PAUSE — this tool requires user confirmation before execution. " +
          "Present the items to delete (name, type, count) and ask: '¿Los elimino?' or 'Shall I delete these?' " +
          "The user will confirm on the next message, and the tool will execute. Do NOT say you lack the tool.",
        tool: name,
      });
    }

    // HIGH + MEDIUM: Log warning for audit trail
    if (riskTier === "high" || riskTier === "medium") {
      log.warn(
        { tool: name, riskTier, args: JSON.stringify(args).slice(0, 200) },
        "destructive tool called",
      );
    }
    // LOW: Silent proceed
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
