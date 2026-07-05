/**
 * Parse JSON out of raw LLM output.
 *
 * LLMs wrap JSON in ```json fences or surrounding prose despite
 * instructions. This extracts a fenced block if present, tries a direct
 * parse, then falls back to the outermost {...} / [...] span. Replaces the
 * hand-rolled fence-strip + parse duplicated across builtin tools
 * (dashboard, seo-*, ads-*, knowledge-map).
 */

import { errMsg } from "./err-msg.js";

/**
 * @throws Error (descriptive, with a 200-char excerpt) when no parseable
 *   JSON is found. Callers with silent-fallback semantics try/catch this.
 */
export function parseJsonFromLlm<T>(text: string): T {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  const candidate = (fence ? fence[1] : trimmed).trim();

  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    // Prose-wrapped output: extract the outermost {...} or [...] span.
    const first = candidate.search(/[{[]/);
    if (first >= 0) {
      const closer = candidate[first] === "{" ? "}" : "]";
      const last = candidate.lastIndexOf(closer);
      if (last > first) {
        try {
          return JSON.parse(candidate.slice(first, last + 1)) as T;
        } catch {
          /* fall through to the descriptive error */
        }
      }
    }
    throw new Error(
      `LLM output is not valid JSON (${errMsg(err)}): ${trimmed.slice(0, 200)}`,
    );
  }
}
