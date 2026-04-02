/**
 * Loop guards for inferWithTools — extracted for testability.
 *
 * Each guard is a pure function that takes the current round state and
 * returns a verdict. The main loop in adapter.ts orchestrates them.
 */

import type { ToolCall } from "./adapter.js";

// ---------------------------------------------------------------------------
// READ_ONLY_TOOLS set
// ---------------------------------------------------------------------------

/** Tools that are purely observational. Used by the analysis paralysis guard. */
const READ_ONLY_TOOLS = new Set([
  // Filesystem
  "file_read",
  "grep",
  "glob",
  "list_dir",
  // Web & documents
  "web_search",
  "web_read",
  "exa_search",
  "rss_read",
  "pdf_read",
  "hf_spaces",
  // Memory & facts
  "memory_search",
  "user_fact_list",
  "skill_list",
  // Google (read-only subset)
  "gmail_search",
  "gmail_read",
  "gsheets_read",
  "gdocs_read",
  "gdrive_list",
  "calendar_list",
  // WordPress (read-only subset)
  "wp_list_posts",
  "wp_read_post",
  "wp_categories",
  "wp_pages",
  "wp_plugins",
  "wp_settings",
  // COMMIT (read-only subset)
  "commit__get_daily_snapshot",
  "commit__get_hierarchy",
  "commit__list_tasks",
  "commit__list_goals",
  "commit__list_objectives",
  "commit__search_journal",
  "commit__list_ideas",
  // Projects, evolution, introspection & CRM
  "project_list",
  "project_get",
  "task_history",
  "crm_query",
  "evolution_get_data",
  // Gemini (read-only subset)
  "gemini_research",
  // Browser observation — click/fill/scroll/evaluate are action tools
  "browser__goto",
  "browser__markdown",
  "browser__links",
  "browser__semantic_tree",
  "browser__structuredData",
  "browser__interactiveElements",
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

// ---------------------------------------------------------------------------
// Error detection regex
// ---------------------------------------------------------------------------

/** Regex matching common error indicators in tool results. */
export const ERROR_RESULT_RE =
  /\b(?:error|failed|failure|not found|denied|unauthorized|forbidden|does not exist|no such file|ENOENT|EACCES|EPERM|timed?\s?out)\b|"(?:error|status)":\s*(?:4\d{2}|5\d{2})\b/i;

// ---------------------------------------------------------------------------
// Guard functions
// ---------------------------------------------------------------------------

/** Check if ALL tool calls in a round are read-only. Empty → false. */
export function allToolCallsReadOnly(
  toolCalls: Array<{ function: { name: string } }>,
): boolean {
  if (toolCalls.length === 0) return false;
  return toolCalls.every((tc) => isReadOnlyTool(tc.function.name));
}

/** Check if ALL tool results contain error indicators. Empty → false. */
export function allResultsAreErrors(
  results: Array<{ content: string | unknown }>,
): boolean {
  if (results.length === 0) return false;
  return results.every(
    (r) => typeof r.content === "string" && ERROR_RESULT_RE.test(r.content),
  );
}

/** Build a tool call signature for repeat detection. */
export function buildToolSignature(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
    .sort()
    .join("|");
}

/**
 * Detect consecutive repeat: same tool signature as last round.
 * Returns the new repeat count (0 = reset, N = consecutive matches).
 */
export function checkConsecutiveRepeats(
  currentSig: string,
  lastSig: string,
  currentCount: number,
): number {
  return currentSig === lastSig ? currentCount + 1 : 0;
}

/**
 * Detect stale loop: all results < 300 chars and only 1 tool called.
 * Returns the new consecutive count (0 = reset, N = consecutive).
 */
export function checkStaleLoop(
  toolResults: Array<{ content: string | unknown }>,
  toolCallCount: number,
  currentCount: number,
): number {
  const allSmall = toolResults.every(
    (r) => typeof r.content === "string" && r.content.length < 300,
  );
  return allSmall && toolCallCount === 1 ? currentCount + 1 : 0;
}

/**
 * Detect analysis paralysis: all tools read-only with no uncalled action tools.
 * Returns the new consecutive count (0 = reset, N = consecutive).
 */
export function checkAnalysisParalysis(
  toolCalls: ToolCall[],
  calledToolNames: Set<string>,
  availableNonReadOnly: Set<string>,
  currentCount: number,
): number {
  if (toolCalls.length === 0 || !allToolCallsReadOnly(toolCalls)) return 0;
  const hasUncalledActionTools =
    availableNonReadOnly.size > 0 &&
    [...availableNonReadOnly].some((t) => !calledToolNames.has(t));
  if (hasUncalledActionTools) return currentCount; // don't increment — still gathering
  return currentCount + 1;
}

/**
 * Detect persistent failure: all results are errors.
 * Returns the new consecutive count (0 = reset, N = consecutive).
 */
export function checkPersistentFailure(
  toolResults: Array<{ content: string | unknown }>,
  currentCount: number,
): number {
  if (toolResults.length === 0) return 0;
  return allResultsAreErrors(toolResults) ? currentCount + 1 : 0;
}

/** Check if token budget exceeded. */
export function isTokenBudgetExceeded(
  promptTokens: number,
  budget: number,
): boolean {
  return budget < Infinity && promptTokens >= budget;
}
