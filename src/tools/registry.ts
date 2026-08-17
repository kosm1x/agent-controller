/**
 * Tool registry — manages available tools for runners.
 */

import type { ZodType } from "zod";
import type { ToolDefinition } from "../inference/adapter.js";
import type { Tool, ToolAnnotations } from "./types.js";
import { getToolAnnotations } from "./types.js";
import {
  currentRunOrigin,
  currentRunTaskId,
  priorRunTools,
  recordRunTool,
} from "./rule-of-two.js";
import { recordToolEvidence } from "../lib/v8-4/numbers.js";
import { toolMetrics } from "../observability/tool-metrics.js";
import { createLogger } from "../lib/logger.js";
import { jsonSchemaToZod, validateArgs } from "./schema-validator.js";
import {
  recordGatedExecution,
  shouldRecordGatedExecution,
} from "../lib/v8-3/gated-execution.js";

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
    } catch (e) {
      // Schema conversion failed — the tool will execute WITHOUT arg
      // validation. Log it: a silently-unvalidated tool is a latent misuse
      // trap (malformed LLM args reach the handler unchecked).
      log.warn(
        `schema compile failed for tool "${tool.name}" — running unvalidated: ${e instanceof Error ? e.message : String(e)}`,
      );
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

  // Blocking responsibility lives in task-executor (CCP5+CCP9).
  // Registry only handles execution + audit logging.

  /**
   * CCP5: Get effective risk tier for a tool.
   * Priority: Rule-of-Two single-tool trifecta (→ high, structural) >
   * explicit riskTier > requiresConfirmation (→ high) > default (low).
   * Delegates to `getToolAnnotations` — the one resolver — so the interactive
   * confirm flow (task-executor) cannot see a tier the resolver refused.
   */
  getEffectiveRiskTier(name: string): "low" | "medium" | "high" {
    const tool = this.tools.get(name);
    if (!tool) return "low";
    return getToolAnnotations(tool).riskTier;
  }

  /** Normalized annotations for a registered tool, or undefined if unknown. */
  annotationsOf(name: string): ToolAnnotations | undefined {
    const tool = this.tools.get(name);
    return tool ? getToolAnnotations(tool) : undefined;
  }

  /**
   * Execute a tool by name.
   *
   * V8.3 background seam (2026-08-08, gate-validity assessment): this is the
   * general tool-execution chokepoint — scheduled/ritual tasks (task-executor),
   * the Prometheus executor, and the claude-sdk MCP bridge all funnel here. A
   * tool that maps to an ACTIVE gated capability is recorded in the V8.3
   * decision ledger (audit-only: any ledger failure degrades to a direct
   * execute, the tool runs at most once, output is never swallowed). The
   * interactive confirm seam (`lib/v8-3/trigger.ts`) records its OWN decision
   * and passes `{v83: "skip"}` so one execution never lands two rows. The
   * check is O(1) map+env lookups when V8.3 is dormant or the tool is ungated.
   *
   * Source/thread label (2026-08-17): read from the run's origin (dispatcher
   * seeds it from `TaskSubmission.threadId`) — an operator chat turn that
   * calls a gated tool WITHOUT a confirmation gate ledgers as
   * `source:"operator"` on its thread key; scheduled/ritual/reaction runs and
   * calls outside any run stay `"background"`. This is a LABEL: every path to
   * a gated handler already funnels through this method (fast-runner via
   * task-executor, Prometheus, claude-sdk MCP bridge, trigger.ts) — see
   * `docs/planning/v8-3-seam-origin-plan.md` §1.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    opts?: { v83?: "skip" },
  ): Promise<string> {
    // Rule of Two (V8.5 Phase 5.2): a gated tool's seam sees the tools this
    // run invoked BEFORE this call (`undefined` outside a dispatcher run —
    // the pipeline fails closed on that); the call itself is recorded AFTER
    // the snapshot so a tool never counts as its own prior. Every call is
    // recorded (gated or not) so later gated calls see the full run.
    if (opts?.v83 !== "skip" && shouldRecordGatedExecution(name)) {
      const priorToolNames = priorRunTools();
      recordRunTool(name);
      const origin = currentRunOrigin();
      return recordGatedExecution(
        name,
        args,
        () => this.executeDirect(name, args),
        {
          source: origin.source,
          threadId: origin.threadId,
          priorToolNames,
          resolveToolAnnotations: (n) => this.annotationsOf(n),
        },
      );
    }
    recordRunTool(name);
    return this.executeDirect(name, args);
  }

  /** The unwrapped execution path (risk-tier audit log + metrics + dispatch). */
  private async executeDirect(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    // CCP5: Audit trail for risk-tiered tools. Blocking is handled by
    // task-executor (single responsibility — prevents dual-gate bugs).
    const riskTier = this.getEffectiveRiskTier(name);
    if (riskTier === "high" || riskTier === "medium") {
      log.warn(
        { tool: name, riskTier, args: JSON.stringify(args).slice(0, 200) },
        "destructive tool called",
      );
    }
    const start = Date.now();
    try {
      const result = await tool.execute(args);
      toolMetrics.record(name, Date.now() - start, true);
      // V8.4 numbers-provenance corpus: every tool result of the current run
      // (task id from the run-tool context; no-op outside a run). Digested +
      // capped inside the collector; freed by the dispatcher at completion.
      const runTaskId = currentRunTaskId();
      if (runTaskId) recordToolEvidence(runTaskId, result);
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
