/**
 * Shared verdict-JSON extraction for critic LLM responses.
 *
 * Both S2 (`src/audit/critic.ts`) and S5 (`src/skills/critic.ts`) emit a
 * critic system prompt that asks for `{verdict, critique}` JSON and call
 * `infer()`. They share the same JSON-extraction discipline:
 *
 *   - accept pure JSON
 *   - tolerate a markdown code fence wrapping the JSON
 *   - tolerate surrounding prose by walking balanced `{...}` candidates
 *     and returning the FIRST one that parses to a valid verdict shape
 *   - reject empty / non-JSON / wrong-shape responses
 *
 * Per spec §8 ("build once, use twice"), extracted from the S2 critic so
 * S5 reuses it verbatim. NEITHER substrate's specific draft type leaks
 * into this module — it only handles the verdict surface.
 */

export type CriticVerdict = "pass" | "fail";

export interface CriticVerdictPayload {
  verdict: CriticVerdict;
  critique: string;
}

/**
 * Tolerant JSON parser for critic output. Returns `null` if `raw` cannot
 * be coerced into a `{verdict: 'pass'|'fail', critique: string}` shape.
 */
export function parseCriticVerdict(raw: string): CriticVerdictPayload | null {
  let candidate = raw;

  // Strip markdown fences.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) candidate = fenceMatch[1];

  // Greedy `{...}` over the whole string fails when the response embeds an
  // example JSON before the real verdict. Walk balanced `{...}` candidates and
  // return the FIRST one that parses to a valid verdict shape.
  for (const balanced of extractBalancedObjects(candidate)) {
    let obj: unknown;
    try {
      obj = JSON.parse(balanced);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const v = (obj as Record<string, unknown>).verdict;
    const c = (obj as Record<string, unknown>).critique;
    if (v !== "pass" && v !== "fail") continue;
    if (typeof c !== "string") continue;
    return { verdict: v, critique: c };
  }
  return null;
}

/**
 * Yield each top-level balanced `{...}` substring in scan order. Tracks
 * string literals (single/double-quoted) so `{` inside a JSON string
 * doesn't confuse depth counting. Backslash-escape aware.
 */
export function* extractBalancedObjects(s: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") {
        i += 1; // skip escaped char
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        yield s.slice(start, i + 1);
        start = -1;
      }
    }
  }
}
