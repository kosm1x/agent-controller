/**
 * Built-in reaction rules — evaluated in order, first match wins.
 *
 * 1. Suppression: too many failures of the same type → stop retrying
 * 2. Transient retry: network/timeout errors → identical retry
 * 3. Adjusted retry: first non-transient failure → retry with error context
 * 4. Escalate: exhausted retries → notify human
 */

import type {
  ReactionRule,
  ReactionContext,
  ReactionDecision,
} from "./types.js";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// Matches both "timeout" (single word) and "timed out" / "time out" with an
// optional space — container errors use "Container timed out after Nms" which
// the previous single-word pattern missed, breaking transient classification
// for every container timeout.
const TRANSIENT_ERROR_PATTERN =
  /timed?\s?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|rate.limit|429|503|ENOTFOUND|socket hang up|EPIPE/i;

const SUPPRESSION_THRESHOLD = 3;
const MAX_RETRIES = 2; // 1 original + 2 retries = 3 total attempts

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** If 3+ tasks with the same classification have failed in 24h, suppress. */
export const suppressionRule: ReactionRule = {
  name: "suppression",
  evaluate(ctx: ReactionContext): ReactionDecision | null {
    if (ctx.classificationFailures24h >= SUPPRESSION_THRESHOLD) {
      return {
        action: "suppress",
        reason: `${ctx.classificationFailures24h} failures for same classification in 24h — suppressing retries`,
      };
    }
    return null;
  },
};

/** If the error is transient and we haven't exhausted retries, retry identically. */
export const transientRetryRule: ReactionRule = {
  name: "transient_retry",
  evaluate(ctx: ReactionContext): ReactionDecision | null {
    if (!ctx.error) return null;
    if (ctx.previousAttempts >= MAX_RETRIES) return null;
    if (TRANSIENT_ERROR_PATTERN.test(ctx.error)) {
      return {
        action: "retry",
        reason: `Transient error detected: ${ctx.error.slice(0, 100)}`,
      };
    }
    return null;
  },
};

/**
 * First non-transient failure → retry with error context injected.
 *
 * Score-only failure gate (2026-05-27, S3, [[deterministic-retry-gate]]):
 * when reflector data says zero goals actively failed but the task is marked
 * `failed`, the failure came from criteriaMet=false discounts dropping the
 * aggregate score below the success threshold. Retrying produces the same
 * goals → same discount → same score → same outcome, and burns ~1.7M tokens
 * per round (skill-evolution burn loops on 2026-05-25 and 2026-05-27).
 *
 * Gate is narrow on purpose:
 *   - `goalsFailed === 0 && goalsTotal > 0` → skip retry (deterministic)
 *   - `goalsFailed === null` (no reflector_gap_log row — fast runner or
 *     pre-reflection abort) → legacy retry behavior
 *   - `goalsFailed > 0` → legacy retry behavior (error-context injection
 *     may genuinely help on a real goal failure)
 *   - `goalsTotal === 0` (empty graph — planner returned no goals) → legacy
 *     retry behavior (audit W2 fold: distinguishes pre-execution crash from
 *     "real run with 0 active failures")
 */
export const adjustedRetryRule: ReactionRule = {
  name: "adjusted_retry",
  evaluate(ctx: ReactionContext): ReactionDecision | null {
    if (ctx.previousAttempts > 0) return null; // Only on first failure
    if (ctx.error && TRANSIENT_ERROR_PATTERN.test(ctx.error)) return null;
    if (
      ctx.goalsFailed === 0 &&
      ctx.goalsTotal !== null &&
      ctx.goalsTotal > 0
    ) {
      return null; // deterministic score-only failure
    }
    return {
      action: "retry_adjusted",
      reason: `First non-transient failure — retrying with error context`,
    };
  },
};

/** Exhausted retries → escalate to human. */
export const escalateRule: ReactionRule = {
  name: "escalate",
  evaluate(ctx: ReactionContext): ReactionDecision | null {
    if (ctx.previousAttempts >= MAX_RETRIES) {
      return {
        action: "escalate",
        reason: `${ctx.previousAttempts} retries exhausted — escalating to human`,
      };
    }
    return null;
  },
};

/** All rules in evaluation order. First match wins. */
export const DEFAULT_RULES: ReactionRule[] = [
  suppressionRule,
  transientRetryRule,
  adjustedRetryRule,
  escalateRule,
];

/** Evaluate rules against a context. Returns the first matching decision. */
export function evaluateRules(
  rules: ReactionRule[],
  ctx: ReactionContext,
): { rule: ReactionRule; decision: ReactionDecision } | null {
  for (const rule of rules) {
    const decision = rule.evaluate(ctx);
    if (decision) return { rule, decision };
  }
  return null;
}
