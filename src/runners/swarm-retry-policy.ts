/**
 * Per-sub-task retry policy for swarm-runner (queue #231).
 *
 * Pure classifier. Given a failed sub-task's error string + the tool call
 * trace from its run, decides whether the swarm should re-spawn the work.
 * No DB access, no inference — fully unit-testable.
 *
 * Design note: docs/planning/swarm-retry.md
 *
 * Decision matrix (locked 2026-05-23):
 *   - Provider transient (429, 5xx, network timeout, abort-from-timeout) → RETRY (plain)
 *   - Hallucination guard fire → RETRY (hallucination recovery — sterner prompt)
 *   - Tool execution error (file not found, validation fail, scope) → NO
 *   - max_rounds / token_budget exhaustion → NO
 *   - needs_context / blocked → NO
 *   - cancelled (user-initiated) → NO
 *   - Side-effect tainted (any non-idempotent destructive tool fired) → NO override
 *   - Budget cap (retry_count >= MAX_RETRIES_PER_GOAL) → NO
 *
 * Ships in shadow mode behind SWARM_SUBTASK_RETRY_ENABLED env flag (default
 * false). Classifier runs and logs the would-decision via Prometheus +
 * structured log even when shadow; the swarm-runner only ACTS on retry
 * decisions when the env flag is "true".
 */

import { toolRegistry } from "../tools/registry.js";
import { getToolAnnotations } from "../tools/types.js";

/** Per-sub-task retry budget. Hermes ships 1; we follow. Double-budget
 *  on a 5-sub-task swarm = 5× worst-case cost; 1 retry is the right floor. */
export const MAX_RETRIES_PER_GOAL = 1;

/** Outcome label dimension for `mc_swarm_subtask_retry_total`. */
export type RetryDecision =
  | "retried"
  | "shadow_skipped"
  | "skipped_side_effect"
  | "skipped_budget"
  | "skipped_terminal";

/** Failure-class label dimension. */
export type RetryReason =
  | "provider_transient"
  | "hallucination"
  | "tool_error"
  | "max_rounds"
  | "needs_context"
  | "cancelled"
  | "unknown_failure";

/** When the decision is `retried`, how to re-spawn. */
export type RecoveryMode = "plain" | "hallucination" | "none";

export interface RetryPolicyInput {
  /** The failed sub-task's error string (`tasks.error`). Empty/null → "unknown_failure". */
  error: string | null | undefined;
  /** Bare tool names called by the failed sub-task BEFORE the failure (from
   *  the `runs` trace). Used for the side-effect taint veto. Pass an empty
   *  array if no tools were called or the trace is unavailable. */
  toolCalls: string[];
  /** Predecessor task's retry_count. Caller fetches via getTask(). */
  retryCount: number;
}

export interface RetryPolicyDecision {
  decision: RetryDecision;
  reason: RetryReason;
  recoveryMode: RecoveryMode;
  /** Human-readable explanation for the structured log line. */
  rationale: string;
}

/**
 * Sterner-prompt addendum prepended to the retry submission's description
 * when recoveryMode === "hallucination". Wording chosen 2026-05-23
 * (queue #231 design note, Option A — explicit about the specific failure
 * mode rather than reusing the production rejection text from fast-runner).
 */
export const HALLUCINATION_RECOVERY_ADDENDUM =
  "⚠️ IMPORTANT: The previous attempt at this sub-task failed because the " +
  "response narrated tool calls without actually invoking them. You MUST " +
  "call the tools you reference. Do not describe results — produce them.";

// ---------------------------------------------------------------------------
// Failure-class classification — error-string matchers
// ---------------------------------------------------------------------------
//
// Matchers are intentionally regex-light: a small set of distinctive
// substrings keyed to error messages production has actually emitted.
// Strict enough that they don't false-positive across classes; loose
// enough that minor message drift doesn't lose the classification.
// Cross-reference: feedback_layered_bug_chains, feedback_unbounded_alternation_fp.

/** Provider-transient signals — provider returned a transient failure code. */
const PROVIDER_TRANSIENT_MATCHERS: readonly RegExp[] = [
  // HTTP errors: explicit numeric prefixes
  /\b429\b/i, // rate limit
  /\b50[0-9]\b/i, // 5xx server errors (500/502/503/504/...)
  /rate limit/i,
  /timeout/i,
  /timed out/i, // matches "Container timed out", "Inference timed out"
  /econnreset|econnrefused|enetunreach|etimedout/i, // node net errors
  /upstream connect error/i, // envoy/proxy chain
  /circuit.*open/i, // breaker tripped
  /service unavailable/i,
];

/** Hallucination guard signals — fast-runner detects narrated-tool-call hallucinations. */
const HALLUCINATION_MATCHERS: readonly RegExp[] = [
  /hallucinat/i, // matches "hallucinated", "hallucination guard"
  /\[hallucination guard\]/i, // production marker
  /narrat(ed|ing) tool call/i,
];

/** Definite-terminal signals — same input → same outcome, no point retrying. */
const TOOL_ERROR_MATCHERS: readonly RegExp[] = [
  /enoent|file not found|no such file/i,
  /eacces|permission denied/i,
  /not in scope|not allowed|forbidden/i,
  /required tools not called/i, // _isRequiredToolRetry's terminal message
  /validation (failed|error)/i,
  /schema error/i,
];

const MAX_ROUNDS_MATCHERS: readonly RegExp[] = [
  /max[_ ]rounds/i,
  /max[_ ]turns/i,
  /token[_ ]budget/i,
  /exceeded.*budget/i,
  /\[timeout after \d+s/i, // SDK 15-min hard timeout
  /STATUS: DONE_WITH_CONCERNS/i, // soft-failure but counts as terminal
];

const NEEDS_CONTEXT_MATCHERS: readonly RegExp[] = [
  /needs (additional )?(user )?context/i,
  /paused for user/i,
  /awaiting confirmation/i,
];

const CANCELLED_MATCHERS: readonly RegExp[] = [
  /cancel{1,2}ed/i,
  /service shutdown/i, // SIGTERM during mc restart
  /aborted/i,
];

function classifyError(error: string | null | undefined): RetryReason {
  if (!error || error.trim() === "") return "unknown_failure";

  // Order matters: most-specific first. A "timed out" message could match
  // both PROVIDER_TRANSIENT (timeout) and MAX_ROUNDS (15-min SDK timeout);
  // the [timeout after Ns] marker in MAX_ROUNDS is more specific so we
  // check it first. Similarly cancel before timeout (a cancel during an
  // operation can produce both signals).
  if (CANCELLED_MATCHERS.some((re) => re.test(error))) return "cancelled";
  if (NEEDS_CONTEXT_MATCHERS.some((re) => re.test(error)))
    return "needs_context";
  if (MAX_ROUNDS_MATCHERS.some((re) => re.test(error))) return "max_rounds";
  if (HALLUCINATION_MATCHERS.some((re) => re.test(error)))
    return "hallucination";
  if (TOOL_ERROR_MATCHERS.some((re) => re.test(error))) return "tool_error";
  if (PROVIDER_TRANSIENT_MATCHERS.some((re) => re.test(error)))
    return "provider_transient";
  return "unknown_failure";
}

/** Retryable classes — replays MAY succeed. */
const RETRYABLE_REASONS: ReadonlySet<RetryReason> = new Set([
  "provider_transient",
  "hallucination",
]);

// ---------------------------------------------------------------------------
// Side-effect taint check — was the failed run already destructive?
// ---------------------------------------------------------------------------

/**
 * Returns the bare name of any tool the failed sub-task called whose
 * replay would double-execute a side effect. The veto condition is:
 *
 *   NEITHER `readOnlyHint:true` NOR `idempotentHint:true`
 *
 * — i.e. any tool that DOES modify state AND CANNOT be safely replayed.
 * The `destructiveHint` axis is independent: a tool can be non-destructive
 * (reversible) yet still non-idempotent (re-running produces a different
 * end state). Examples in the production registry that fit this gap:
 *
 *   - `jarvis_file_update`: append-style updates that accumulate. Replay
 *     appends the same content twice. `destructiveHint:false`,
 *     `idempotentHint:false`, `readOnlyHint:false`.
 *   - `jarvis_file_move`: rename. Second call ENOENT — replayed retry
 *     reports a different (false) error.
 *   - `submit-report`: writes a new report row. Replay = duplicate.
 *
 * An earlier version of this check required `destructiveHint:true` as the
 * third clause, which let all three pass through as retry-safe — caught
 * by qa-audit C1 2026-05-23 before activation. The current condition
 * matches the JSDoc above word-for-word.
 *
 * Returns null if no taint detected (retry is safe from a side-effect
 * standpoint). Returns the first offending tool name for the diagnostic
 * log (deterministic via array iteration order).
 */
export function findSideEffectTaint(toolCalls: string[]): string | null {
  for (const name of toolCalls) {
    const tool = toolRegistry.get(name);
    // Unknown tool — treat conservatively. A name in the trace that the
    // registry doesn't know about is MOST LIKELY an MCP bridge tool
    // (xpoz/browser/playwright) whose annotations would fall back to the
    // conservative defaults (`destructiveHint:true`, `idempotentHint:false`)
    // per CLAUDE.md "Defaults are deliberately conservative". Veto retry
    // on those — same outcome the registered taint branch below produces.
    if (!tool) return name;
    // getToolAnnotations applies the conservative defaults for any hint
    // the tool didn't set explicitly: `readOnlyHint:false`,
    // `idempotentHint:false`, `destructiveHint:true`. So an unannotated
    // registered tool also vetoes via the !readOnly && !idempotent branch.
    const a = getToolAnnotations(tool);
    if (a.readOnlyHint) continue;
    if (a.idempotentHint) continue;
    // Reached here ⇒ NOT read-only AND NOT idempotent. Veto regardless of
    // destructiveHint (reversible but non-idempotent side effects exist).
    return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level classifier
// ---------------------------------------------------------------------------

/**
 * Decide whether a failed sub-task should be retried.
 *
 * Order of vetoes (cheapest-first so failed checks short-circuit before
 * more expensive lookups; the rationale string explains the FIRST gate
 * that blocked, not the cascade):
 *   1. Budget cap (retry_count >= MAX_RETRIES_PER_GOAL) — integer compare
 *   2. Failure class is terminal (tool_error / max_rounds / etc.) — regex matchers
 *   3. Side-effect taint — toolRegistry lookup per tool call
 * If all three pass, decision = "retried" with the appropriate recovery mode.
 *
 * Shadow mode (env flag) is applied AT THE CALL SITE by swarm-runner, NOT
 * here — the classifier always returns the "true" decision so the caller
 * can log the would-have-done with `decision: "shadow_skipped"`.
 */
export function classifyRetry(input: RetryPolicyInput): RetryPolicyDecision {
  const reason = classifyError(input.error);

  // Veto 1: budget
  if (input.retryCount >= MAX_RETRIES_PER_GOAL) {
    return {
      decision: "skipped_budget",
      reason,
      recoveryMode: "none",
      rationale: `retry budget exhausted (retry_count=${input.retryCount} >= MAX_RETRIES_PER_GOAL=${MAX_RETRIES_PER_GOAL})`,
    };
  }

  // Veto 2: failure class
  if (!RETRYABLE_REASONS.has(reason)) {
    return {
      decision: "skipped_terminal",
      reason,
      recoveryMode: "none",
      rationale: `failure class '${reason}' is terminal — re-running won't change the outcome`,
    };
  }

  // Veto 3: side-effect taint (only relevant if we got past the class check)
  const taintingTool = findSideEffectTaint(input.toolCalls);
  if (taintingTool) {
    return {
      decision: "skipped_side_effect",
      reason,
      recoveryMode: "none",
      rationale: `non-idempotent destructive tool '${taintingTool}' fired pre-failure — replay would double the side effect`,
    };
  }

  // All vetoes passed → retry
  const recoveryMode: RecoveryMode =
    reason === "hallucination" ? "hallucination" : "plain";
  return {
    decision: "retried",
    reason,
    recoveryMode,
    rationale:
      recoveryMode === "hallucination"
        ? "retryable hallucination class — re-spawning with sterner prompt addendum"
        : "retryable provider-transient class — plain re-spawn",
  };
}

/**
 * Compose the retry submission's description. Adds the sterner-prompt
 * addendum at the head when recoveryMode='hallucination' (Option A wording
 * from queue #231 design note); identical re-spawn for plain mode.
 */
export function buildRetryDescription(
  originalDescription: string,
  recoveryMode: RecoveryMode,
): string {
  if (recoveryMode === "hallucination") {
    return `${HALLUCINATION_RECOVERY_ADDENDUM}\n\n${originalDescription}`;
  }
  return originalDescription;
}
