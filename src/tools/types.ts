/**
 * Tool interface for the built-in tool system.
 */

import type { ToolDefinition } from "../inference/adapter.js";
import { resolveRuleOfTwo } from "./rule-of-two.js";

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
  /**
   * Rule-of-Two properties (V8.5 Phase 5.2, `rule-of-two.ts`). Explicit
   * fields override the name-keyed classification table; absent ⇒ table ⇒
   * MCP prefix default ⇒ true (unknown = riskier).
   *
   * untrustedInputHint: [A] the tool's INHERENT output carries free text
   *   authored outside the operator/Jarvis boundary (mail, web, shared docs,
   *   inbound messages, third-party feeds).
   * sensitiveAccessHint: [B] touches private operator data or a privileged
   *   system (KB, memories, mail, workspace, FS, shell, git, VPS, accounts).
   * [C] "changes state / communicates out" is `!readOnlyHint` — not repeated.
   */
  readonly untrustedInputHint?: boolean;
  readonly sensitiveAccessHint?: boolean;
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
 * Runtime consumers: `ToolRegistry.getEffectiveRiskTier` (interactive confirm
 * flow) and the V8.3 seed cross-check. Callers get a single normalized view
 * that includes the four MCP hints, the two Rule-of-Two hints + mc-specific
 * `requiresConfirmation` and `riskTier` fields so safety reasoning doesn't
 * have to combine two surfaces.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  /** Rule-of-Two [A] — see `Tool.untrustedInputHint`. */
  readonly untrustedInputHint: boolean;
  /** Rule-of-Two [B] — see `Tool.sensitiveAccessHint`. */
  readonly sensitiveAccessHint: boolean;
  /**
   * Rule-of-Two single-tool trifecta: [A] ∧ [B] ∧ [C]. When true the resolver
   * has already forced `riskTier:"high"` + `requiresConfirmation:true` below.
   */
  readonly ruleOfTwoTrifecta: boolean;
  /** mc-specific: caller must confirm before invoking. */
  readonly requiresConfirmation: boolean;
  /** mc-specific: graduated risk tier; absent collapses to "low". */
  readonly riskTier: "low" | "medium" | "high";
}

/**
 * The ONE runtime resolver for tool safety metadata. `ToolRegistry.
 * getEffectiveRiskTier` (which the interactive confirm flow in task-executor
 * reads) delegates here, so the Rule-of-Two structural rule below has no code
 * path around it: a tool that alone holds untrusted-input + sensitive-access +
 * state-change is `high`/confirm regardless of what its definition declares
 * (structural-safety-gate — the resolver refuses the safe-looking value).
 */
export function getToolAnnotations(tool: Tool): ToolAnnotations {
  const readOnlyHint = tool.readOnlyHint ?? false;
  const { untrustedInput, sensitiveAccess } = resolveRuleOfTwo(tool);
  const ruleOfTwoTrifecta = untrustedInput && sensitiveAccess && !readOnlyHint;
  const declaredTier =
    tool.riskTier ?? (tool.requiresConfirmation ? "high" : "low");
  return {
    readOnlyHint,
    destructiveHint: tool.destructiveHint ?? true,
    idempotentHint: tool.idempotentHint ?? false,
    openWorldHint: tool.openWorldHint ?? true,
    untrustedInputHint: untrustedInput,
    sensitiveAccessHint: sensitiveAccess,
    ruleOfTwoTrifecta,
    requiresConfirmation: ruleOfTwoTrifecta || (tool.requiresConfirmation ?? false),
    riskTier: ruleOfTwoTrifecta ? "high" : declaredTier,
  };
}
