/**
 * Inference and tool loop tuning constants.
 *
 * Consolidated from hardcoded values scattered across adapter.ts and fast-runner.ts.
 * All values have env var overrides for tuning without code changes.
 */

const int = (key: string, fallback: number): number => {
  const v = process.env[key];
  if (!v) return fallback;
  const parsed = parseInt(v, 10);
  return Number.isNaN(parsed) ? fallback : Math.max(parsed, 0);
};

const float = (key: string, fallback: number): number => {
  const v = process.env[key];
  if (!v) return fallback;
  const parsed = parseFloat(v);
  return Number.isNaN(parsed) ? fallback : parsed;
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
/** Token budget for coding tasks (read→write→test→iterate→commit→push needs room). */
export const TOKEN_BUDGET_CODING = int("TOKEN_BUDGET_CODING", 50_000);
/** Token budget for Playwright browser tasks (SPAs need more context). */
export const TOKEN_BUDGET_BROWSER = int("TOKEN_BUDGET_BROWSER", 40_000);
/** Max inference rounds for fast tasks. */
export const MAX_ROUNDS_DEFAULT = int("MAX_ROUNDS_DEFAULT", 20);
/** Max inference rounds for coding tasks (plan→code→test→iterate→commit→push). */
export const MAX_ROUNDS_CODING = int("MAX_ROUNDS_CODING", 35);
/** Max inference rounds for Playwright browser tasks (navigate+snapshot+click cycles). */
export const MAX_ROUNDS_BROWSER = int("MAX_ROUNDS_BROWSER", 35);

// --- Prompt size governance (CCP6) ---
/** Max tokens for the system prompt (sections + KB + facts). ~24K chars. */
export const SYSTEM_PROMPT_TOKEN_BUDGET = int(
  "SYSTEM_PROMPT_TOKEN_BUDGET",
  6000,
);

// --- Hallucination guard ---
/** Token budget headroom threshold for retry (0-1). */
export const HALLUCINATION_RETRY_HEADROOM = float(
  "HALLUCINATION_RETRY_HEADROOM",
  0.85,
);

// --- Circuit breaker ---
/** Failures within window to trip the breaker. */
export const CB_FAILURE_THRESHOLD = int("CB_FAILURE_THRESHOLD", 5);
/** Rolling window for counting failures (ms). */
export const CB_WINDOW_MS = int("CB_WINDOW_MS", 60_000);
/** Cooldown before HALF_OPEN probe (ms). */
export const CB_COOLDOWN_MS = int("CB_COOLDOWN_MS", 30_000);

// --- Doom-loop detection ---
/** Repeated text chunk hashes to trigger content-chanting alarm. */
export const DOOM_CHANTING_THRESHOLD = int("DOOM_CHANTING_THRESHOLD", 8);
/** Chunk size in chars for content-chanting sliding window. */
export const DOOM_CHANTING_CHUNK = int("DOOM_CHANTING_CHUNK", 200);
/** Identical (callHash, resultHash) pairs to trigger fingerprint alarm. */
export const DOOM_FINGERPRINT_THRESHOLD = int("DOOM_FINGERPRINT_THRESHOLD", 3);
/** Pairwise Jaccard similarity threshold (0-1) for text-stalled alarm. */
export const DOOM_JACCARD_THRESHOLD = float("DOOM_JACCARD_THRESHOLD", 0.85);
/** Number of recent LLM text responses to compare for Jaccard. */
export const DOOM_JACCARD_WINDOW = int("DOOM_JACCARD_WINDOW", 4);
/** Number of recent call signatures to keep for cycle detection. */
export const DOOM_CYCLE_HISTORY = int("DOOM_CYCLE_HISTORY", 6);

// --- Context pressure ---
/** Fraction of context window that triggers a soft advisory (0-1). */
export const CONTEXT_PRESSURE_ADVISORY = float(
  "CONTEXT_PRESSURE_ADVISORY",
  0.7,
);

// --- Compaction pipeline ---
/** Max chars for tool result content after L0 truncation. */
export const COMPACTION_L0_TRUNCATE_CHARS = int(
  "COMPACTION_L0_TRUNCATE_CHARS",
  200,
);
/** Minimum assistant+tool pairs for L1 to remove per pass. */
export const COMPACTION_L1_MIN_PAIRS = int("COMPACTION_L1_MIN_PAIRS", 3);

// --- Overnight tuning ---
/** Per-experiment timeout in milliseconds (default 30 min). */
export const EXPERIMENT_TIMEOUT_MS = int(
  "EXPERIMENT_TIMEOUT_MS",
  30 * 60 * 1000,
);
