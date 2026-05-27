/**
 * Reaction engine types.
 *
 * Defines the data structures for automated task failure reactions:
 * retry, adjusted retry, escalation, and suppression.
 */

import type { TaskRow } from "../dispatch/dispatcher.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ReactionTrigger = "task_failed" | "task_stuck" | "repeated_failure";

export type ReactionAction =
  | "retry"
  | "retry_adjusted"
  | "escalate"
  | "suppress";

export type ReactionStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "suppressed";

export interface Reaction {
  reactionId: string;
  trigger: ReactionTrigger;
  sourceTaskId: string;
  spawnedTaskId: string | null;
  action: ReactionAction;
  status: ReactionStatus;
  attempt: number;
  maxAttempts: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

export interface ReactionContext {
  task: TaskRow;
  error: string | null;
  /** Number of reactions already recorded for this source task. */
  previousAttempts: number;
  /** Number of failures with the same classified_as value in the last 24 hours. */
  classificationFailures24h: number;
  /**
   * Total goals in the most recent reflector run for this task. `null` when
   * no reflector_gap_log row exists. Pairs with goalsFailed for the gate to
   * distinguish "real run with 0 active failures" from "pre-execution crash
   * with empty graph". Gate fires only when goalsTotal > 0.
   */
  goalsTotal: number | null;
  /**
   * Number of goals with status=FAILED in the most recent reflector run for
   * this task. `null` when no reflector_gap_log row exists (fast runner, or
   * heavy run that failed before reflection). Used by adjustedRetryRule to
   * skip retry on score-only failures (criteriaMet=false discount drops the
   * score below threshold but no goal actively failed → retrying the same
   * prompt is deterministic). The gate is narrow: ONLY
   * `goalsFailed === 0 && goalsTotal > 0` blocks retry. `null` and `>0` both
   * preserve legacy retry behavior.
   */
  goalsFailed: number | null;
}

export interface ReactionDecision {
  action: ReactionAction;
  reason: string;
}

export interface ReactionRule {
  name: string;
  /** Evaluate whether this rule should fire. Returns a decision or null to skip. */
  evaluate(ctx: ReactionContext): ReactionDecision | null;
}
