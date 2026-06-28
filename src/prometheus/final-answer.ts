import type { ExecutionResult } from "./types.js";

/**
 * Reconstruct the agent's final answer / report from a Prometheus run by
 * joining the per-goal text answers (`GoalResult.result`, set to the LLM's
 * `finalContent` in executor.ts) in execution order.
 *
 * Why this exists: the heavy runner's `output.content` is the REFLECTOR's
 * 1-3 sentence meta-assessment (reflector.ts — e.g. "Heuristic score: 0.63.
 * 2/3 goals completed."), NOT what the agent produced. Persisting that for a
 * ritual's `persistResult` would store the reflector paraphrase instead of the
 * actual report. The agent's real output lives in
 * `executionResults.goalResults[*].result`; this collects it.
 *
 * Returns null when no goal produced text (e.g. every goal failed before
 * answering) so callers can skip storing an empty/junk memory.
 */
export function collectFinalAnswer(
  execResults: ExecutionResult,
): string | null {
  const parts: string[] = [];
  for (const goal of Object.values(execResults.goalResults)) {
    const text = goal.result?.trim();
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
