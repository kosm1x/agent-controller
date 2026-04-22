/**
 * Parent selection strategies for the variant archive.
 *
 * Adapted from HyperAgents (Meta FAIR): selects which variant to evolve
 * from when the overnight tuning loop starts a new run.
 */

import type {
  TuneVariant,
  TuneVariantWithChildren,
  ParentSelectionStrategy,
} from "./types.js";

/**
 * Select a parent variant using the given strategy.
 * Returns null if no valid variants exist (run starts from scratch).
 *
 * For `score_child_prop`, pass `TuneVariantWithChildren[]` (from
 * `getValidVariantsWithChildren`). All other strategies accept either.
 */
export function selectParent(
  strategy: ParentSelectionStrategy,
  variants: TuneVariant[] | TuneVariantWithChildren[],
): TuneVariant | null {
  if (variants.length === 0) return null;

  switch (strategy) {
    case "best":
      return selectBest(variants);
    case "latest":
      return selectLatest(variants);
    case "score_prop":
      return selectScoreProportional(variants);
    case "score_child_prop":
      return selectScoreChildProportional(variants);
  }
}

/** Highest composite_score. Variants are pre-sorted by score DESC from DB. */
function selectBest(variants: TuneVariant[]): TuneVariant {
  return variants[0];
}

/** Most recent created_at. */
function selectLatest(variants: TuneVariant[]): TuneVariant {
  return variants.reduce((latest, v) =>
    v.created_at > latest.created_at ? v : latest,
  );
}

/**
 * Roulette wheel selection — probability proportional to composite_score.
 * Higher-scoring variants are more likely to be selected, but lower-scoring
 * ones still have a chance (encourages exploration).
 */
function selectScoreProportional(variants: TuneVariant[]): TuneVariant {
  const totalScore = variants.reduce((sum, v) => sum + v.composite_score, 0);

  // If all scores are 0, fall back to uniform random
  if (totalScore <= 0) {
    return variants[Math.floor(Math.random() * variants.length)];
  }

  const target = Math.random() * totalScore;
  let cumulative = 0;

  for (const v of variants) {
    cumulative += v.composite_score;
    if (cumulative >= target) return v;
  }

  // Shouldn't reach here, but return last as fallback
  return variants[variants.length - 1];
}

/**
 * HyperAgents `score_child_prop` — probability proportional to
 * `composite_score / (1 + child_count)`. Higher-scoring but less-explored
 * branches are preferred; prevents exploitation of the single best lineage.
 *
 * Falls back to `selectScoreProportional` when variants lack `child_count`
 * (e.g. test fixtures that use the plain `TuneVariant` shape).
 */
function selectScoreChildProportional(
  variants: TuneVariant[] | TuneVariantWithChildren[],
): TuneVariant {
  const hasChildCounts = variants.every(
    (v) => typeof (v as TuneVariantWithChildren).child_count === "number",
  );
  if (!hasChildCounts) {
    return selectScoreProportional(variants);
  }
  const withChildren = variants as TuneVariantWithChildren[];

  const weights = withChildren.map(
    (v) => v.composite_score / (1 + v.child_count),
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  if (totalWeight <= 0) {
    return withChildren[Math.floor(Math.random() * withChildren.length)];
  }

  const target = Math.random() * totalWeight;
  let cumulative = 0;
  for (let i = 0; i < withChildren.length; i++) {
    cumulative += weights[i];
    if (cumulative >= target) return withChildren[i];
  }
  return withChildren[withChildren.length - 1];
}
