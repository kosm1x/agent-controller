/**
 * Detection algorithms — V8.1 Phase 5 (spec §8).
 *
 * Four deterministic detectors over task / objective / error state. The
 * reflection runner (Phase 4) and the briefing judgment (Phase 6) consume
 * `runDetection()`'s typed signals; Phase 6 maps `signal.kind` onto
 * `briefing.signals[].kind`.
 */

import type { DetectionSignal } from "./signals.js";
import { detectStalledTasks } from "./stalled-tasks.js";
import { detectDormantObjectives } from "./dormant-objectives.js";
import { detectImplicitDeadlines } from "./implicit-deadlines.js";
import { detectRecurringBlockers } from "./recurring-blockers.js";

export type {
  DetectionSignal,
  DetectionSignalKind,
  DetectionSeverity,
  StalledTaskSignal,
  DormantObjectiveSignal,
  ImplicitDeadlineSignal,
  RecurringBlockerSignal,
} from "./signals.js";
export { detectStalledTasks } from "./stalled-tasks.js";
export { detectDormantObjectives } from "./dormant-objectives.js";
export { detectImplicitDeadlines, extractDates } from "./implicit-deadlines.js";
export {
  detectRecurringBlockers,
  type DetectRecurringBlockersOptions,
} from "./recurring-blockers.js";

/**
 * Run every detector and return the combined signal list.
 *
 * Note `detectRecurringBlockers` also upserts `recurring_blockers` rows — it
 * maintains its own cluster state, so `runDetection` is not side-effect-free.
 */
export function runDetection(): DetectionSignal[] {
  return [
    ...detectStalledTasks(),
    ...detectDormantObjectives(),
    ...detectImplicitDeadlines(),
    ...detectRecurringBlockers(),
  ];
}
