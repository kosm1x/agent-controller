/**
 * Tool interface for the built-in tool system.
 */

import type { ToolDefinition } from "../inference/adapter.js";

/** A tool that can be executed by runners. */
export interface Tool {
  /** Tool name (used in LLM function calling). */
  readonly name: string;
  /** OpenAI function-calling definition. */
  readonly definition: ToolDefinition;
  /** If true, LLM should confirm with user before executing (destructive/external action). */
  readonly requiresConfirmation?: boolean;
  /**
   * CCP5: Risk tier — graduated risk assessment (reversibility x impact).
   * HIGH: irreversible/external (email, delete, deploy) — blocks until confirmed.
   * MEDIUM: impactful but reversible (publish, write, update) — logs warning.
   * LOW: easily reversible (create draft, save fact) — silent.
   * Falls back to requiresConfirmation (→ "high") if not set.
   */
  readonly riskTier?: "low" | "medium" | "high";
  /**
   * If true, the tool's full schema is NOT sent to the LLM by default.
   * Only the name + description are included in a deferred catalog.
   * When the LLM calls a deferred tool, the executor returns the full
   * parameter schema so the LLM can retry with correct arguments.
   * Saves context tokens for rarely-used tools. (OpenClaude pattern)
   */
  readonly deferred?: boolean;
  /**
   * Natural-language phrases users might say to invoke this tool (v6.4 CL1.4).
   * Shown in deferred catalog to help the LLM match informal requests.
   * Example: ["manda un correo", "envía eso por mail", "send email"]
   */
  readonly triggerPhrases?: readonly string[];
  /**
   * MCP tool-annotation hints (v7.5 leftovers L2 / Session 69 anthropic
   * mcp-builder). Hints, not contracts — clients use them to reason about
   * side-effect safety. All four are optional; absent means "unknown".
   *
   * readOnlyHint: tool does NOT modify state (no FS write, DB mutation, or
   *   side-effecting external call). Implies destructiveHint = false.
   * destructiveHint: tool MAY perform an irreversible/destructive action
   *   (delete, send message, force-push). Should be true on any tool a
   *   careful caller would want to confirm before invoking.
   * idempotentHint: re-issuing the SAME call has no additional effect on
   *   system state beyond the first. Lets callers safely retry on
   *   transient failures.
   * openWorldHint: tool interacts with state outside the agent's bounded
   *   environment — network, FS, external services, third-party APIs.
   *   Implies the call's outcome may vary independent of arguments.
   */
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  /** Execute the tool with parsed arguments. Returns result string. */
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * Normalized annotation view of a tool — what MCP-spec clients (and the
 * registry's own invariant checker) consume. Always returns booleans;
 * `undefined` source fields collapse to safe defaults per the MCP spec
 * recommendations:
 *   readOnlyHint default false, destructiveHint default true,
 *   idempotentHint default false, openWorldHint default true.
 *
 * The unknown-state defaults are deliberately conservative — when a tool
 * hasn't been classified yet, treat it as the riskier alternative.
 *
 * No runtime path consults this helper today. Callers that opt in get a
 * single normalized view that includes the four MCP hints + mc-specific
 * `requiresConfirmation` and `riskTier` fields so safety reasoning doesn't
 * have to combine two surfaces.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  /** mc-specific: caller must confirm before invoking. */
  readonly requiresConfirmation: boolean;
  /** mc-specific: graduated risk tier; absent collapses to "low". */
  readonly riskTier: "low" | "medium" | "high";
}

export function getToolAnnotations(tool: Tool): ToolAnnotations {
  return {
    readOnlyHint: tool.readOnlyHint ?? false,
    destructiveHint: tool.destructiveHint ?? true,
    idempotentHint: tool.idempotentHint ?? false,
    openWorldHint: tool.openWorldHint ?? true,
    requiresConfirmation: tool.requiresConfirmation ?? false,
    riskTier: tool.riskTier ?? (tool.requiresConfirmation ? "high" : "low"),
  };
}
