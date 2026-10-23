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
  opts?: { source?: "swarm-root" },
): string | null {
  const parts: string[] = [];
  let delimited = 0;
  for (const goal of Object.values(execResults.goalResults)) {
    const raw = goal.result?.trim();
    if (!raw) continue;
    const d = extractDeliverable(raw);
    const text = d.text.trim();
    if (!text) continue;
    if (d.delimited) delimited++;
    parts.push(text);
  }
  if (parts.length === 0) return null;
  // Adoption readout for the <deliverable> contract: counts only, no content.
  // The swarm root joins children whose markers their own run already
  // stripped, so its line carries no `delimited` count (queue 3p readout
  // 2026-10-23: it read delimited=0 and polluted the readout).
  if (opts?.source === "swarm-root") {
    console.info(
      `[final-answer] source=swarm-root goals=${parts.length} (children, already extracted)`,
    );
  } else {
    console.info(`[final-answer] goals=${parts.length} delimited=${delimited}`);
  }
  return parts.join("\n\n");
}

const DELIVERABLE_BLOCK = /<deliverable\b[^>]*>([\s\S]*?)<\/deliverable\s*>/gi;
const DELIVERABLE_MARKER = /<\/?deliverable\b[^>]*>/gi;

/**
 * A goal's `result` is the WHOLE final assistant turn, lead-in narration
 * ("I have comprehensive, verified evidence…") included. The executor prompt
 * asks for the user-facing part between `<deliverable>` … `</deliverable>`
 * (matched case-insensitively, attributes allowed); this returns the LAST
 * NON-EMPTY well-formed block, trimmed. No such block → the full text
 * (`delimited: false`), so an answer written without the markers is never
 * lost. Every path strips stray markers (unclosed, nested, empty blocks) so
 * none reaches chat.
 */
export function extractDeliverable(text: string): {
  text: string;
  delimited: boolean;
} {
  let last: string | undefined;
  for (const m of text.matchAll(DELIVERABLE_BLOCK)) {
    const body = m[1].replace(DELIVERABLE_MARKER, "").trim();
    if (body) last = body;
  }
  return last
    ? { text: last, delimited: true }
    : { text: text.replace(DELIVERABLE_MARKER, ""), delimited: false };
}
