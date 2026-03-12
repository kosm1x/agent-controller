/**
 * Heavy Runner — In-process Plan-Execute-Reflect.
 *
 * Delegates to the Prometheus orchestrator for multi-step tasks that
 * require planning, goal decomposition, and reflection.
 */

import { registerRunner } from "../dispatch/dispatcher.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import { orchestrate } from "../prometheus/orchestrator.js";

export const heavyRunner: Runner = {
  type: "heavy",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();

    try {
      const result = await orchestrate(
        input.taskId,
        `${input.title}\n\n${input.description}`,
        undefined,
        input.tools,
      );

      return {
        success: result.success,
        output: {
          content: result.reflection.summary,
          score: result.reflection.score,
          learnings: result.reflection.learnings,
        },
        tokenUsage: {
          promptTokens: result.tokenUsage.promptTokens,
          completionTokens: result.tokenUsage.completionTokens,
        },
        durationMs: Date.now() - start,
        goalGraph: result.goalGraph,
        trace: result.trace,
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
registerRunner(heavyRunner);
