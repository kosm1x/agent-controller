/**
 * Parent selection strategies for the variant archive.
 *
 * Adapted from HyperAgents (Meta FAIR): selects which variant to evolve
 * from when the overnight tuning loop starts a new run.
 */

import type { TuneVariant, ParentSelectionStrategy } from "./types.js";

/**
 * Select a parent variant using the given strategy.
 * Returns null if no valid variants exist (run starts from scratch).
 */
export function selectParent(
  strategy: ParentSelectionStrategy,
  variants: TuneVariant[],
): TuneVariant | null {
  if (variants.length === 0) return null;

  switch (strategy) {
    case "best":
      return selectBest(variants);
    case "latest":
      return selectLatest(variants);
    case "score_prop":
      return selectScoreProportional(variants);
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
