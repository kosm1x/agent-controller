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
  /** Execute the tool with parsed arguments. Returns result string. */
  execute(args: Record<string, unknown>): Promise<string>;
}
