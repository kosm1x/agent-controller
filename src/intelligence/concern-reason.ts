/**
 * Concern-reason classifier (Jarvis execution-improvement plan, Phase 0).
 *
 * `completed_with_concerns` fires on ~1/3 of tasks but is opaque — some are
 * genuine defects (turn-limit truncation, a tool withheld from scope mid-task),
 * many are soft caveats on otherwise-good output. Attaching a reason to the
 * outcome row makes the signal actionable: you can target the top defect class
 * instead of chasing an aggregate that hides real problems behind noise.
 *
 * Detection is intentionally conservative — only the two reasons we have
 * concrete production evidence for are actively emitted (task 7059 = max_turns,
 * tasks 5905/7060 = tool_scope_block). Everything else concern-flagged is
 * `partial`; clean/failed tasks are `none`. `ungrounded_claim` / `delivery_error`
 * are reserved in the taxonomy for when their markers are confirmed — we do NOT
 * guess at them, to avoid mislabeling good work.
 */

export type ConcernReason =
  | "max_turns"
  | "tool_scope_block"
  | "ungrounded_claim" // reserved — not yet emitted (no confirmed marker)
  | "delivery_error" // reserved — not yet emitted (no confirmed marker)
  | "partial"
  | "none";

const CONCERN_STATUSES = new Set([
  "completed_with_concerns",
  "needs_context",
  "blocked",
]);

// Unambiguous runner/SDK defect markers — their mere presence IS the defect, so
// they classify regardless of the final status (a truncated task may even have
// lost its STATUS line). `error_max_turns` is the SDK's internal marker; the
// tool-scope markers require an actual tool name (`\w*_\w+`) next to "scope" or
// the "activa … scope" framing — NOT bare "scope", which appears in ordinary
// content ("no tengo claro el scope del sprint").
const MAX_TURNS_MARKER_RE = /error_max_turns|turn[\s/]+budget limit/i;
const TOOL_SCOPE_MARKER_RE =
  /\bactiva(?:r)?\s+\w*_\w+\b[\s\S]{0,30}\bscope|no est[aá]\s+en\s+(?:el\s+)?scope|\bno tengo\s+\w*_\w+\b[\s\S]{0,40}\bscope/i;

// Natural-language phrasings that ALSO appear in ordinary content ("maximum
// number of turns in chess", "no tengo claro el scope"). Ambiguous, so they only
// count once the task actually landed with concerns — never on a clean success
// (qa 2026-07-04: gating these behind CONCERN_STATUSES stops the classifier from
// polluting the very metric Phase 0 exists to make trustworthy).
const MAX_TURNS_NL_RE =
  /maximum number of turns|reached\s+max\w*\s+turns|max(?:imum)?\s+iterations?\s+reached/i;
const TOOL_SCOPE_NL_RE = /\bno tengo\b[\s\S]{0,40}\ben (?:este|el)\s+scope\b/i;

/**
 * Classify why a task landed with concerns, from the runner output + error +
 * final status. Returns `none` for clean/failed tasks (failures carry their own
 * `error`); `partial` when concern-flagged but not one of the recognized defects.
 */
export function classifyConcernReason(
  status: string,
  output: string | null,
  error: string | null,
): ConcernReason {
  const text = `${output ?? ""}\n${error ?? ""}`;
  // Unambiguous markers classify on any status.
  if (MAX_TURNS_MARKER_RE.test(text)) return "max_turns";
  if (TOOL_SCOPE_MARKER_RE.test(text)) return "tool_scope_block";
  // Ambiguous natural-language signals only count on a genuinely concerned task.
  if (CONCERN_STATUSES.has(status)) {
    if (MAX_TURNS_NL_RE.test(text)) return "max_turns";
    if (TOOL_SCOPE_NL_RE.test(text)) return "tool_scope_block";
    return "partial";
  }
  return "none";
}
