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
