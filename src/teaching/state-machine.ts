/**
 * GuidedSession state machine — ported from DeepTutor guide_manager.py,
 * adapted to Jarvis's persistence model.
 */

import {
  getPlan,
  listUnits,
  setPlanCurrentUnit,
  setPlanStatus,
  updateUnitStatus,
  getUnit,
} from "./persist.js";
import {
  MASTERY_ADVANCE_THRESHOLD,
  type LearningPlanUnitRow,
  type UnitStatus,
} from "./schema-types.js";

export interface AdvanceResult {
  advanced: boolean;
  plan_status: "active" | "completed" | "paused" | "archived";
  next_unit: { index: number; title: string } | null;
  reason: string;
}

/**
 * Advance to the next unit if the current unit's mastery >= threshold AND the
 * next unit's prerequisites are all mastered.
 *
 * `force` bypasses the current-unit mastery check (prereqs still enforced).
 */
export function advance(plan_id: string, force = false): AdvanceResult {
  const plan = getPlan(plan_id);
  if (!plan) {
    return {
      advanced: false,
      plan_status: "archived",
      next_unit: null,
      reason: `Plan ${plan_id} not found`,
    };
  }
  if (plan.status === "completed") {
    return {
      advanced: false,
      plan_status: "completed",
      next_unit: null,
      reason: "Plan is already completed",
    };
  }

  const units = listUnits(plan_id);
  const currentIdx = plan.current_unit;
  const current = units.find((u) => u.unit_index === currentIdx) ?? null;

  if (
    current &&
    !force &&
    current.mastery_score < MASTERY_ADVANCE_THRESHOLD &&
    current.status !== "mastered" &&
    current.status !== "skipped"
  ) {
    return {
      advanced: false,
      plan_status: plan.status as AdvanceResult["plan_status"],
      next_unit: { index: current.unit_index, title: current.title },
      reason: `Current unit mastery ${current.mastery_score.toFixed(
        2,
      )} < ${MASTERY_ADVANCE_THRESHOLD}. Practice more or pass force=true.`,
    };
  }

  if (current && current.status !== "mastered") {
    // Normal advance: mark unit mastered at max(score, threshold). Force
    // advance: mark unit "skipped" WITHOUT fabricating a mastery score —
    // downstream analytics need to distinguish "learner earned mastery" from
    // "operator bypassed the gate" (per audit W12). Prereq check treats
    // skipped same as mastered for the purpose of unblocking next units.
    const shouldSkip =
      force && current.mastery_score < MASTERY_ADVANCE_THRESHOLD;
    if (shouldSkip) {
      updateUnitStatus(plan_id, current.unit_index, "skipped");
      current.status = "skipped";
    } else {
      const masteredScore = Math.max(
        current.mastery_score,
        MASTERY_ADVANCE_THRESHOLD,
      );
      updateUnitStatus(plan_id, current.unit_index, "mastered", masteredScore);
      current.status = "mastered";
      current.mastery_score = masteredScore;
    }
  }

  const next = findNextReadyUnit(units, currentIdx);
  if (!next) {
    setPlanStatus(plan_id, "completed");
    return {
      advanced: true,
      plan_status: "completed",
      next_unit: null,
      reason: "All units mastered — plan completed.",
    };
  }
  updateUnitStatus(plan_id, next.unit_index, "ready");
  setPlanCurrentUnit(plan_id, next.unit_index);
  return {
    advanced: true,
    plan_status: "active",
    next_unit: { index: next.unit_index, title: next.title },
    reason: `Advanced to unit ${next.unit_index + 1}.`,
  };
}

function findNextReadyUnit(
  units: LearningPlanUnitRow[],
  currentIdx: number,
): LearningPlanUnitRow | null {
  const remaining = units
    .filter(
      (u) =>
        u.unit_index > currentIdx &&
        u.status !== "mastered" &&
        u.status !== "skipped",
    )
    .sort((a, b) => a.unit_index - b.unit_index);
  for (const u of remaining) {
    const prereqsMet = u.prerequisites.every((p) => {
      const pu = units.find((x) => x.unit_index === p);
      return (
        pu !== undefined &&
        (pu.status === "mastered" || pu.status === "skipped")
      );
    });
    if (prereqsMet) return u;
  }
  return null;
}

/** Look up a unit; if not provided, fall back to the plan's current_unit. */
export function resolveUnit(
  plan_id: string,
  unit_index?: number,
): LearningPlanUnitRow | null {
  const plan = getPlan(plan_id);
  if (!plan) return null;
  const idx = typeof unit_index === "number" ? unit_index : plan.current_unit;
  return getUnit(plan_id, idx);
}

/** Derive a target difficulty from a unit's mastery score. */
export function targetDifficulty(
  mastery_score: number,
): "easy" | "medium" | "hard" {
  if (mastery_score < 0.3) return "easy";
  if (mastery_score > 0.7) return "hard";
  return "medium";
}

export function markUnitStatus(
  plan_id: string,
  unit_index: number,
  status: UnitStatus,
): void {
  updateUnitStatus(plan_id, unit_index, status);
}
