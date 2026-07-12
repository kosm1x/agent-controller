/**
 * Canonical deliverable extraction — THE single source of truth for pulling
 * the user-facing text out of a runner result (V8.5 Phase 4.2).
 *
 * History that mandates this module: the router's `extractResultText` and
 * the dispatcher's `extractPersistText` were divergent copies with OPPOSITE
 * preference orders (router: text>output>result>finalAnswer>content;
 * persist: finalAnswer>content>text>result>output). Each order hid a bug
 * the other fixed — 2026-07-11 the router delivered the reflector's
 * meta-summary instead of the heavy agent's answer; 2026-07-12 the same
 * class recurred on nanoclaw. "Divergent extractors over the same shape are
 * the smell" (feedback_never_silent_reply_floor #6). Both call sites now
 * delegate here; do not re-implement field preference anywhere else.
 *
 * Canonical order:
 *   1. finalAnswer — the agent's actual report (collectFinalAnswer over
 *      per-goal answers). Always the deliverable when non-empty.
 *   2. text       — fast-runner / fast-path shape.
 *   3. output / result — legacy string carriers.
 *   4. content    — LAST: on heavy/nanoclaw this is the REFLECTOR's
 *      meta-summary about the work, not the work. Only deliverable when
 *      nothing better exists (e.g. finalAnswer collection produced null).
 */

const FIELD_ORDER = [
  "finalAnswer",
  "text",
  "output",
  "result",
  "content",
] as const;

/**
 * Extract the deliverable text from a runner result (object or string).
 * Strings that look like JSON are parsed and re-extracted (fast-runner
 * results arrive JSON-encoded on some paths). Returns null when nothing
 * usable is present — callers decide their own fallback (router: generic
 * line or JSON dump; persist: skip).
 */
export function extractDeliverableText(result: unknown): string | null {
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const inner = extractFromObject(parsed);
        if (inner) return inner;
        // JSON but no usable field — fall through to the raw string, which
        // is at least honest (matches the router's historical behavior).
      } catch {
        // Not JSON — the string itself is the deliverable
      }
    }
    return trimmed || null;
  }
  return extractFromObject(result);
}

function extractFromObject(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  for (const key of FIELD_ORDER) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * True when the result carries at least one canonical text field — the
 * guard the router's failure path uses so a text-less object never reaches
 * the operator as raw JSON.
 */
export function hasDeliverableField(result: unknown): boolean {
  if (typeof result === "string") return true;
  if (!result || typeof result !== "object") return false;
  const obj = result as Record<string, unknown>;
  return FIELD_ORDER.some((k) => typeof obj[k] === "string");
}
