/**
 * Inference and tool loop tuning constants.
 *
 * Consolidated from hardcoded values scattered across adapter.ts and fast-runner.ts.
 * All values have env var overrides for tuning without code changes.
 */

const int = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
};

// --- Tool result handling ---
/** Max chars per tool result in conversation — prevents prompt bloat. */
export const MAX_TOOL_RESULT_CHARS = int("MAX_TOOL_RESULT_CHARS", 12_000);
/** Max chars per tool result in wrap-up context — more aggressive. */
export const WRAPUP_TOOL_RESULT_CHARS = int("WRAPUP_TOOL_RESULT_CHARS", 1_500);

// --- Loop guards ---
/** Identical tool call signature repeats before breaking. */
export const MAX_CONSECUTIVE_REPEATS = int("MAX_CONSECUTIVE_REPEATS", 2);
/** Consecutive rounds with all-small results before stale-loop break. */
export const STALE_LOOP_THRESHOLD = int("STALE_LOOP_THRESHOLD", 5);
/** Consecutive read-only rounds before analysis paralysis break. */
export const ANALYSIS_PARALYSIS_THRESHOLD = int(
  "ANALYSIS_PARALYSIS_THRESHOLD",
  5,
);
/** Consecutive all-error rounds before persistent failure advisory. */
export const PERSISTENT_FAILURE_THRESHOLD = int(
  "PERSISTENT_FAILURE_THRESHOLD",
  4,
);

// --- Token budgets (fast-runner) ---
/** Token budget for fast (non-coding) tasks. */
export const TOKEN_BUDGET_FAST = int("TOKEN_BUDGET_FAST", 28_000);
/** Token budget for coding tasks. */
export const TOKEN_BUDGET_CODING = int("TOKEN_BUDGET_CODING", 30_000);
/** Max inference rounds for fast tasks. */
export const MAX_ROUNDS_DEFAULT = int("MAX_ROUNDS_DEFAULT", 20);
/** Max inference rounds for coding tasks. */
export const MAX_ROUNDS_CODING = int("MAX_ROUNDS_CODING", 22);

// --- Hallucination guard ---
/** Token budget headroom threshold for retry (0-1). */
export const HALLUCINATION_RETRY_HEADROOM = 0.85;
