/**
 * defineTool() — single-declaration tool factory.
 *
 * The `Tool` interface carries the tool name twice: `tool.name` (registry
 * key) and `definition.function.name` (what the LLM sees). Hand-writing both
 * across ~194 tools is a sync hazard pinned only by the registry
 * name-equality invariant test. This factory derives the OpenAI
 * function-calling definition from a single `name` declaration so the two
 * can never diverge.
 *
 * New tools use this; existing tools migrate opportunistically (per file,
 * when touched). Failure returns are `JSON.stringify({ error: ... })` —
 * never "Error:" strings or {success:false}.
 */

import type { Tool } from "./types.js";

/**
 * Everything a `Tool` carries except the derived `definition`, plus the two
 * fields the definition is built from. The four MCP hint fields
 * (readOnlyHint / destructiveHint / idempotentHint / openWorldHint) and
 * deferred / riskTier / requiresConfirmation / triggerPhrases pass through
 * unchanged — typed via `Omit<Tool, "definition">` so any field added to
 * the Tool interface flows through automatically.
 */
export type DefineToolOptions = Omit<Tool, "definition"> & {
  /**
   * LLM-facing description. Follow the ACI principles (see CLAUDE.md):
   * when to use, when NOT to use, edge cases, boundaries with similar tools.
   */
  description: string;
  /** JSON Schema for the tool's parameters (OpenAI function-calling format). */
  parameters: Record<string, unknown>;
};

/** Build a `Tool` with `definition.function.name` derived from `name`. */
export function defineTool(options: DefineToolOptions): Tool {
  const { description, parameters, ...tool } = options;
  return {
    ...tool,
    definition: {
      type: "function",
      function: { name: tool.name, description, parameters },
    },
  };
}
