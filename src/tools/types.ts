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
   * If true, the tool's full schema is NOT sent to the LLM by default.
   * Only the name + description are included in a deferred catalog.
   * When the LLM calls a deferred tool, the executor returns the full
   * parameter schema so the LLM can retry with correct arguments.
   * Saves context tokens for rarely-used tools. (OpenClaude pattern)
   */
  readonly deferred?: boolean;
  /** Execute the tool with parsed arguments. Returns result string. */
  execute(args: Record<string, unknown>): Promise<string>;
}
