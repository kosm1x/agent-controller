/**
 * Named recall modes — Conway Pattern 3 substrate (v7.7 Spine 6).
 *
 * Conway's empirical warning (`reference_conway_2005_sms.md` §Pattern 3):
 * pure-coherence recall — filtering out memories that contradict the
 * "competent system" self-image — drifts into confabulation. The fix is to
 * NAME the modes so the filtering is explicit and auditable:
 *
 *   - `coherence`      — drops `outcome:failed`; the goal-supportive default
 *                        used by V8.1 briefs and V8.2 proposals.
 *   - `correspondence` — includes every outcome class; used by retrospective
 *                        audits, the S2 critic, post-mortems — paths that
 *                        must see failures.
 *   - `unfiltered`     — debug; `mc-ctl recall` and diagnostic paths.
 *
 * This module is purely the mode → behaviour mapping. The pre-existing
 * low-level knobs (`excludeOutcomes`, `includeFailed`) still work and take
 * precedence — `recallMode` is the additive high-level intent, not a rename.
 */

import type { RecallOptions } from "./types.js";
import { DEFAULT_EXCLUDE_OUTCOMES } from "./types.js";

export type RecallMode = "coherence" | "correspondence" | "unfiltered";

export const DEFAULT_RECALL_MODE: RecallMode = "coherence";

export const RECALL_MODES: readonly RecallMode[] = [
  "coherence",
  "correspondence",
  "unfiltered",
] as const;

/** The outcome tags excluded for a given mode. Only `coherence` filters. */
export function excludeOutcomesForMode(mode: RecallMode): readonly string[] {
  return mode === "coherence" ? DEFAULT_EXCLUDE_OUTCOMES : [];
}

/**
 * Resolve the outcome tags to exclude for a recall call.
 *
 * Precedence — the legacy low-level knobs are explicit caller intent and
 * win, so behaviour is unchanged for every caller that does not set
 * `recallMode`:
 *   1. `includeFailed: true`           → exclude nothing.
 *   2. explicit `excludeOutcomes`      → use it verbatim (including `[]`).
 *   3. `recallMode`                    → the mode's exclude set.
 *   4. nothing set                     → `coherence` default.
 */
export function resolveExcludeOutcomes(
  options: RecallOptions,
): readonly string[] {
  if (options.includeFailed) return [];
  if (options.excludeOutcomes !== undefined) return options.excludeOutcomes;
  return excludeOutcomesForMode(options.recallMode ?? DEFAULT_RECALL_MODE);
}

/**
 * Resolve the EFFECTIVE recall mode — the value tagged onto
 * `recall_audit.mode`.
 *
 * Precedence MUST mirror `resolveExcludeOutcomes` exactly (R1-W1) so the
 * logged mode never contradicts the exclude set actually applied — a recall
 * tagged `unfiltered` that in fact filtered would corrupt the correspondence
 * audit. The legacy knobs are checked FIRST (they win the exclude set, so
 * they win the tag), then `recallMode`, then the default.
 *
 *   - `includeFailed` / explicit `excludeOutcomes: []` → `correspondence`.
 *   - explicit non-empty `excludeOutcomes` → `coherence` (a filtered recall,
 *     even if `recallMode` said otherwise — the explicit list won the set).
 *   - otherwise the named `recallMode`, then the `coherence` default.
 */
export function resolveRecallMode(options: RecallOptions): RecallMode {
  if (options.includeFailed) return "correspondence";
  if (options.excludeOutcomes !== undefined) {
    return options.excludeOutcomes.length === 0
      ? "correspondence"
      : "coherence";
  }
  return options.recallMode ?? DEFAULT_RECALL_MODE;
}

// Compile-time guard (R1-R1): RecallMode (here) and the inline union on
// RecallOptions.recallMode (types.ts — inline to avoid an import cycle) are
// two sources of truth. This bidirectional equality assertion fails
// typecheck if either drifts.
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _recallModeLockstep: AssertEqual<
  RecallMode,
  NonNullable<RecallOptions["recallMode"]>
> = true;
void _recallModeLockstep;
