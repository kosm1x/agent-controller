/**
 * Shared single-line truncation for display strings.
 * Moved from src/lib/v8-2/judgment-format.ts (efficiency-refactor Phase 2a).
 */

/** Collapse whitespace and cap at n chars (… elision). */
export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}
