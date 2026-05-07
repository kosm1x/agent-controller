/**
 * Outcome-aware recall bias — drops/down-ranks/boosts MemoryItems based on
 * their outcome:* tag (queue item #7 part 2, 2026-05-07).
 *
 * Behavior:
 *   - `outcome:failed` items are dropped by default. Override with
 *     `excludeOutcomes: []` (or convenience flag `includeFailed: true`).
 *   - `outcome:success` items get +0.10 added to `relevance`.
 *   - `outcome:concerns` items get -0.05 (kept but down-ranked).
 *   - Items without a recognized outcome tag are passed through untouched.
 *   - After bias application, items are re-sorted by adjusted relevance.
 *
 * Why drop failed but only soft-penalize concerns: failure narratives
 * directly recycled as "recipes" caused the Session 114 incident, but
 * concerns rows often carry useful partial signal (the operator's
 * decision, see queue scope #3). Down-ranking preserves the signal
 * while reducing surface area.
 *
 * Returns a breakdown of the input distribution so logRecall can persist
 * it to recall_audit.outcome_breakdown for ratio-based audits.
 */

import type { MemoryItem, RecallOptions } from "./types.js";
import { DEFAULT_EXCLUDE_OUTCOMES } from "./types.js";

/** Score adjustments applied per outcome tag. */
export const OUTCOME_BIAS: Record<string, number> = {
  "outcome:success": 0.1,
  "outcome:concerns": -0.05,
};

/** Counts of input items by outcome class. Used for telemetry. */
export interface OutcomeBreakdown {
  success: number;
  concerns: number;
  failed: number;
  unknown: number;
}

export interface OutcomeBiasResult {
  kept: MemoryItem[];
  excluded: number;
  breakdown: OutcomeBreakdown;
}

function findOutcomeTag(tags: readonly string[] | undefined): string | null {
  if (!tags) return null;
  for (const t of tags) {
    if (t.startsWith("outcome:")) return t;
  }
  return null;
}

/**
 * Apply outcome filter + score bias + re-sort.
 *
 * @param items - candidate MemoryItems from a backend recall call (already
 *   ordered by the backend's relevance scoring; items without a `relevance`
 *   field are treated as 0 for bias-arithmetic purposes only — original
 *   ordering is preserved as a stable secondary sort).
 * @param options - the RecallOptions originally passed to recall().
 *   `excludeOutcomes` overrides the default. `includeFailed: true` is a
 *   convenience that maps to `excludeOutcomes: []`.
 */
export function applyOutcomeBias(
  items: MemoryItem[],
  options: RecallOptions,
): OutcomeBiasResult {
  const exclude = options.includeFailed
    ? []
    : (options.excludeOutcomes ?? DEFAULT_EXCLUDE_OUTCOMES);
  const excludeSet = new Set(exclude);
  const breakdown: OutcomeBreakdown = {
    success: 0,
    concerns: 0,
    failed: 0,
    unknown: 0,
  };

  const kept: Array<MemoryItem & { __originalIndex: number }> = [];
  let excluded = 0;

  items.forEach((item, idx) => {
    const tag = findOutcomeTag(item.tags);
    if (tag === "outcome:success") breakdown.success += 1;
    else if (tag === "outcome:concerns") breakdown.concerns += 1;
    else if (tag === "outcome:failed") breakdown.failed += 1;
    else breakdown.unknown += 1;

    if (tag && excludeSet.has(tag)) {
      excluded += 1;
      return;
    }

    const bias = tag ? (OUTCOME_BIAS[tag] ?? 0) : 0;
    if (bias !== 0 && item.relevance !== undefined) {
      kept.push({
        ...item,
        relevance: item.relevance + bias,
        __originalIndex: idx,
      });
    } else {
      kept.push({ ...item, __originalIndex: idx });
    }
  });

  // Stable sort: by adjusted relevance desc, ties broken by original index.
  kept.sort((a, b) => {
    const ra = a.relevance ?? 0;
    const rb = b.relevance ?? 0;
    if (ra !== rb) return rb - ra;
    return a.__originalIndex - b.__originalIndex;
  });

  return {
    kept: kept.map(({ __originalIndex: _idx, ...item }) => item),
    excluded,
    breakdown,
  };
}
