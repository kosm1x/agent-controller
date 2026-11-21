/**
 * The cache-break marker of the Jarvis system prompt, and the helper that
 * strips it.
 *
 * A leaf module: it imports nothing, so a module can import these names
 * without loading the message router. The router re-exports both names for
 * its existing callers.
 */

/**
 * v8 S1: Cache-break marker. Splits the system prompt into a stable prefix
 * (P1 + P2 sections — same across all tasks for this user) and a variable
 * suffix (P3 + P4 — scope-conditional + per-call data). Runners that want to
 * exploit the prompt cache split on this marker and emit the halves as
 * separate system messages, with stable content first. Runners that don't
 * (heavy/nanoclaw/swarm) replace the marker with a single newline and treat
 * description as one blob — no regression vs pre-S1 behavior.
 *
 * Format chosen to be unambiguous (HTML comment line) and unlikely to collide
 * with real persona/KB content. Versioned so future changes can be detected.
 */
export const CACHE_BREAK_MARKER = "\n<!--CACHE_BREAK_v1-->\n";

/**
 * Strip the cache-break marker, replacing it with a single newline.
 * Use at any boundary where `description` text is exposed to a consumer
 * that doesn't honor the split (A2A peers, persistence, dashboard, classifier).
 * The fast-runner chat branch is the only consumer that splits on the marker;
 * everywhere else this helper makes the description look as if S1 didn't exist.
 */
export function stripCacheMarker(text: string): string {
  return text.includes(CACHE_BREAK_MARKER)
    ? text.replace(CACHE_BREAK_MARKER, "\n")
    : text;
}
