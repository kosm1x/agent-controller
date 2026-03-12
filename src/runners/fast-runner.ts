/**
 * Fast Runner — In-process LLM + tool loop.
 *
 * Sends a task description to the LLM with available tools. The LLM calls tools,
 * results are appended, and it loops until a text-only response or max rounds.
 * Fastest runner type — no containers, no planning overhead.
 */

import { inferWithTools } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { toolRegistry } from "../tools/registry.js";
import { registerRunner } from "../dispatch/dispatcher.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";

const SYSTEM_PROMPT = `You are a task execution agent. You have access to tools to accomplish the user's task.

Instructions:
- Use the available tools to complete the task.
- Be thorough but efficient — use the minimum number of tool calls needed.
- When you have enough information to answer, respond with a clear, concise result.
- If a tool fails, try an alternative approach or explain what went wrong.`;

const MAX_ROUNDS = 10;

export const fastRunner: Runner = {
  type: "fast",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();

    // Get tool definitions for requested tools (or all if none specified)
    const definitions = toolRegistry.getDefinitions(input.tools);
    if (definitions.length === 0) {
      return {
        success: false,
        error: "No tools available. Register tools before running fast tasks.",
        durationMs: Date.now() - start,
      };
    }

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Task: ${input.title}\n\n${input.description}`,
      },
    ];

    try {
      const result = await inferWithTools(
        messages,
        definitions,
        (name, args) => toolRegistry.execute(name, args),
        MAX_ROUNDS,
      );

      return {
        success: true,
        output: result.content,
        tokenUsage: {
          promptTokens: result.totalUsage.prompt_tokens,
          completionTokens: result.totalUsage.completion_tokens,
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  },
};

// Auto-register on import
registerRunner(fastRunner);
