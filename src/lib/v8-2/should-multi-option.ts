/**
 * V8.2 Phase 3 — multi-option skip predicate (spec §8 "When to skip").
 *
 * A *deterministic*, no-LLM gate that decides whether a strategic judgment
 * earns the four-call RAPID-D multi-option pass (§8) or skips it. Running
 * RAPID-D on a judgment that needs no decision is pure cost: "A/B/C on thin
 * evidence is theatre", and "you have 3 stalled tasks" is a fact to note, not a
 * fork in the road. This predicate is the cheap upstream filter the judgment
 * pass consults BEFORE spending the four LLM calls.
 *
 * The §8 skip conditions, mapped onto the V8.1 `Judgment` fields that are
 * available before the multi-option pass runs:
 *
 *   1. Confidence is `red`           → `red_confidence`. A/B/C on thin evidence
 *      is theatre. NOTE: the §9 at_risk / recurring_blocker carve-out (surface
 *      a red judgment as an OPTIONLESS heads-up) is a *surfacing* decision that
 *      belongs to Phase 4's drop-vs-surface predicate — it does NOT mean we
 *      generate options for a red judgment. So a red judgment always skips the
 *      multi-option pass here; whether it still surfaces (optionless) is decided
 *      downstream. Keeping the two concerns separate avoids a red judgment ever
 *      carrying a fabricated A/B/C.
 *   2. Purely observational          → `observational`. A fact to note, no
 *      decision: `posture === 'noted'`, or a celebratory / progress signal
 *      (`kind ∈ {momentum, self_defining_progress}`) — a milestone reached or a
 *      cohort moving is something to acknowledge, not decide between options.
 *   3. Single mechanical action      → `single_mechanical_action`. The judgment
 *      resolves to one obvious mechanical step ("ping the operator now"),
 *      surfaced via `proposed_action.surface === 'log_only'` — there is nothing
 *      to choose, so no options.
 *   4. Otherwise                     → `run`. Decision-worthy: spend RAPID-D.
 *
 * The order matters: red confidence wins over an actionable kind (a red
 * `stalled_task` still skips), and observational/mechanical only apply when
 * confidence is not red. The boundary cases are pinned by fixtures in the test.
 */

import type { Judgment } from "../../briefing/schema.js";

/** Why the multi-option pass was (not) run — recorded on the decision trail. */
export type MultiOptionReason =
  | "run"
  | "red_confidence"
  | "observational"
  | "single_mechanical_action";

export interface MultiOptionDecision {
  /** True ⇒ the judgment earns the four-call RAPID-D pass. */
  run: boolean;
  reason: MultiOptionReason;
}

/**
 * The judgment fields this predicate reads. A `Pick` (not the whole `Judgment`)
 * so the caller can consult the gate with a partial judgment that exists before
 * the options are generated — and so a new unrelated `Judgment` field can never
 * silently change the gate's behavior.
 */
export type MultiOptionInput = Pick<
  Judgment,
  "kind" | "posture" | "confidence" | "proposed_action"
>;

/**
 * Observational signal kinds — a fact to note, not a decision to make. A
 * milestone reached (`momentum`) or a self-defining cohort moving
 * (`self_defining_progress`) is acknowledged, never optioned.
 */
const OBSERVATIONAL_KINDS = new Set<Judgment["kind"]>([
  "momentum",
  "self_defining_progress",
]);

/**
 * Decide whether to run the RAPID-D multi-option pass for a judgment.
 * Pure + deterministic (spec §8): no LLM, no I/O, no clock.
 */
export function shouldRunMultiOption(
  judgment: MultiOptionInput,
): MultiOptionDecision {
  // 1. Red confidence — thin evidence; A/B/C would be theatre. Wins over an
  //    otherwise-actionable kind. (Optionless surfacing is Phase 4's call.)
  if (judgment.confidence === "red") {
    return { run: false, reason: "red_confidence" };
  }

  // 2. Purely observational — a fact to note, no decision.
  if (judgment.posture === "noted" || OBSERVATIONAL_KINDS.has(judgment.kind)) {
    return { run: false, reason: "observational" };
  }

  // 3. Single mechanical action — one obvious step, nothing to choose between.
  if (judgment.proposed_action?.surface === "log_only") {
    return { run: false, reason: "single_mechanical_action" };
  }

  // 4. Decision-worthy.
  return { run: true, reason: "run" };
}
