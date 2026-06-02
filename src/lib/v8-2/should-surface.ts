/**
 * V8.2 Phase 4 — drop-vs-surface predicate (spec §9, reconciled).
 *
 * The companion to the §8 skip predicate (`should-multi-option.ts`). The §8 gate
 * decides whether a judgment earns the RAPID-D multi-option pass; THIS gate
 * decides the fate of a judgment that cannot stand on cited evidence — a red /
 * unfixable-unresolved judgment.
 *
 * Reconciled rule (§9):
 *   - DEFAULT: an unfixable unresolved judgment is DROPPED. No "[unverified]"
 *     caveats — silently dropping a thin claim is better than surfacing one
 *     dressed in hedges (Perplexity UX + Anthropic Endex).
 *   - CARVE-OUT: a judgment whose `posture === 'at_risk'` OR `kind ===
 *     'recurring_blocker'` is SURFACED EVEN AT RED — as an OPTIONLESS heads-up
 *     with explicit thin-evidence framing. Rationale: a silently-dropped at-risk
 *     judgment is a miss on exactly the signal the operator most needs, and a
 *     silent drop fights V8's total-transparency control architecture.
 *
 * This is the carve-out the §8 skip predicate deliberately DEFERRED: a red
 * judgment never gets A/B/C (§8 skips it), but whether it still surfaces
 * optionless is decided HERE. See [[should-multi-option]] for the upstream half.
 *
 * Pure + deterministic: no LLM, no I/O. The §11 critic (Phase 6) decides whether
 * an individual unresolved *claim* is editorial framing vs a real gap; this
 * predicate operates one level up, on the whole judgment's surfacing.
 */

import type { Judgment } from "../../briefing/schema.js";

export type SurfaceReason =
  | "at_risk_heads_up"
  | "recurring_blocker_heads_up"
  | "drop";

export interface SurfaceDecision {
  /** True ⇒ surface as an optionless, thin-evidence-framed heads-up. */
  surface: boolean;
  reason: SurfaceReason;
}

/**
 * The judgment fields this predicate reads. A `Pick` so a partial judgment can
 * consult the gate and so an unrelated new `Judgment` field can't silently
 * change its behavior.
 */
export type SurfaceInput = Pick<Judgment, "posture" | "kind">;

/**
 * Decide whether a red / unfixable-unresolved judgment still surfaces (§9). Only
 * the at_risk / recurring_blocker carve-out surfaces — everything else drops.
 *
 * `confidence` is intentionally NOT read here (qa-R1): the §9 carve-out surfaces
 * "even at red confidence", so this gate is a CALLER PRECONDITION — invoke it
 * only for judgments that are already red / unfixable-unresolved. It is not a
 * confidence filter; the absence of a confidence check is by design, not an
 * omission.
 */
export function shouldSurfaceUnfixable(
  judgment: SurfaceInput,
): SurfaceDecision {
  if (judgment.posture === "at_risk") {
    return { surface: true, reason: "at_risk_heads_up" };
  }
  if (judgment.kind === "recurring_blocker") {
    return { surface: true, reason: "recurring_blocker_heads_up" };
  }
  return { surface: false, reason: "drop" };
}
