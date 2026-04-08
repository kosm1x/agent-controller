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
  /** Execute the tool with parsed arguments. Returns result string. */
  execute(args: Record<string, unknown>): Promise<string>;
}
