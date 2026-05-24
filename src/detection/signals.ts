/**
 * Detection signals — V8.1 Phase 5 (spec §8).
 *
 * The four deterministic detectors each emit a typed `DetectionSignal`. The
 * aggregator `runDetection()` (src/detection/index.ts) returns the union;
 * Phase 6's briefing schema maps `signal.kind` onto `briefing.signals[].kind`.
 *
 * `severity` is a detector HINT, not the final posture. Phase 6's judgment
 * step assigns the briefing posture (`at_risk` / `has_momentum` / etc.) — a
 * detector only says "this looks routine" (`info`) or "this looks like a
 * risk" (`at_risk`).
 */

export type DetectionSignalKind =
  | "stalled_task"
  | "dormant_objective"
  | "implicit_deadline"
  | "recurring_blocker";

export type DetectionSeverity = "info" | "at_risk";

interface BaseSignal {
  kind: DetectionSignalKind;
  /** One-line human-readable summary for the briefing. */
  summary: string;
  /** Detector hint — not the final briefing posture (see file header). */
  severity: DetectionSeverity;
}

/** A task silently abandoned — running/queued/blocked, no activity > 7d (§8 Layer 1). */
export interface StalledTaskSignal extends BaseSignal {
  kind: "stalled_task";
  taskId: string;
  title: string;
  status: string;
  priority: string;
  daysSinceActivity: number;
}

/** A NorthStar objective with no task activity > 14d (§8). */
export interface DormantObjectiveSignal extends BaseSignal {
  kind: "dormant_objective";
  objectivePath: string;
  title: string;
  /** Days since the last linked task, or null when no task ever linked. */
  daysDormant: number | null;
  lastTaskActivity: string | null;
}

/** A date parsed from a task/objective that falls within 7 days (§8). */
export interface ImplicitDeadlineSignal extends BaseSignal {
  kind: "implicit_deadline";
  /** The extracted date, ISO `YYYY-MM-DD`. */
  parsedDate: string;
  /** Whole days from today to `parsedDate` (negative = already overdue). */
  daysUntil: number;
  sourceField: "title" | "description";
  /** The `task_id` or objective path the date was extracted from. */
  sourceRef: string;
}

/** The same blocker class seen across ≥3 distinct task runs (§8). */
export interface RecurringBlockerSignal extends BaseSignal {
  kind: "recurring_blocker";
  blockerSignature: string;
  taskCount: number;
  taskIds: string[];
  firstSeenAt: string;
  /** Last time a failure with this signature was seen — needed so the
   * judgment prompt can downweight clusters whose fix has already shipped
   * (the staleness gate in `detectRecurringBlockers` is belt; this is suspenders). */
  lastSeenAt: string;
}

export type DetectionSignal =
  | StalledTaskSignal
  | DormantObjectiveSignal
  | ImplicitDeadlineSignal
  | RecurringBlockerSignal;
