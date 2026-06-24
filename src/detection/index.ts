/**
 * Detection algorithms — V8.1 Phase 5 (spec §8).
 *
 * Four deterministic detectors over task / objective / error state. The
 * reflection runner (Phase 4) and the briefing judgment (Phase 6) consume
 * `runDetection()`'s typed signals; Phase 6 maps `signal.kind` onto
 * `briefing.signals[].kind`.
 */

import type { DetectionSignal } from "./signals.js";
import { detectStalledProjects } from "./stalled-projects.js";

export type {
  DetectionSignal,
  DetectionSignalKind,
  DetectionSeverity,
  StalledProjectSignal,
  StalledTaskSignal,
  DormantObjectiveSignal,
  ImplicitDeadlineSignal,
  RecurringBlockerSignal,
} from "./signals.js";
export { detectStalledProjects } from "./stalled-projects.js";
// RETIRED 2026-06-23 (operator ruling — day-log is the only work-truth source).
// These four NorthStar / task-table detectors are no longer run by
// `runDetection`; kept exported for back-compat + their tests + idle-detect's
// historical import. Do NOT re-add them to `runDetection` without the operator.
export { detectStalledTasks } from "./stalled-tasks.js";
export { detectDormantObjectives } from "./dormant-objectives.js";
export { detectImplicitDeadlines, extractDates } from "./implicit-deadlines.js";
export {
  detectRecurringBlockers,
  type DetectRecurringBlockersOptions,
} from "./recurring-blockers.js";

/**
 * Run the production detector(s) and return the signal list.
 *
 * As of 2026-06-23 the ONLY production detector is `detectStalledProjects` —
 * grounded in the Telegram day-log, the operator's sole record of work done.
 * The legacy NorthStar (`dormant_objective`) and task-table (`stalled_task`,
 * `implicit_deadline`, `recurring_blocker`) detectors are RETIRED (they read
 * sources the operator ruled are not work-truth) and are intentionally not
 * called here.
 */
export function runDetection(): DetectionSignal[] {
  return [...detectStalledProjects()];
}
