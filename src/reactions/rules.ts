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

const TRANSIENT_ERROR_PATTERN =
  /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|rate.limit|429|503|ENOTFOUND|socket hang up|EPIPE/i;

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

/** First non-transient failure → retry with error context injected. */
export const adjustedRetryRule: ReactionRule = {
  name: "adjusted_retry",
  evaluate(ctx: ReactionContext): ReactionDecision | null {
    if (ctx.previousAttempts > 0) return null; // Only on first failure
    if (ctx.error && TRANSIENT_ERROR_PATTERN.test(ctx.error)) return null;
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
