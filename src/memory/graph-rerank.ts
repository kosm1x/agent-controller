/**
 * Graph-aware coherence reranker.
 *
 * Given a list of already-scored memory recall results, reorder them to
 * prefer coherent clusters of entity-linked memories over independently
 * top-scored hits. Connectivity acts as a strict tiebreaker capped at
 * `maxBonus` (default 15%) — base relevance always dominates when scores
 * differ by more than the cap.
 *
 * Algorithm (greedy subgraph selection):
 *  1. Extract an entity bag from each item's content via the v6.5
 *     entity extractor (project slugs + person names).
 *  2. Build an adjacency set: pairs (i, j) where bags[i] ∩ bags[j] ≠ ∅.
 *  3. Seed with the highest-scoring item. Loop: pick argmax over
 *     remaining items of `score * (1 + min(connCount * bonus, maxBonus))`.
 *  4. Enforce monotonically decreasing scores on the output (cosmetic
 *     invariant — scores are internal and stripped before return).
 *
 * Returns the reranked list plus a `coherence` metric (fraction of
 * adjacent top-5 pairs) for observability.
 *
 * The pattern is sourced conceptually from soflutionltd/memorypilot
 * (source-available; not forked or copied). This is an independent
 * reimplementation over Jarvis's conversation table — different
 * language, different storage model (query-time entity extraction
 * vs a persistent memory_entities table), a subset of MemoryPilot's
 * three-stage pipeline (we skip GraphRAG 1-hop expansion because it
 * needs persistent entity indices).
 */

import { extractEntities } from "./entity-extractor.js";

/**
 * Minimum shape a reranker input must satisfy. Callers can pass any wider
 * type — the reranker only touches `content` and `_score`.
 */
export interface RerankableItem {
  content: string;
  _score: number;
}

export interface RerankOptions {
  /** Per-link bonus multiplier. Default: 0.05 (5% per shared-entity link). */
  connectivityBonus?: number;
  /** Cumulative bonus cap. Default: 0.15 (15% — strict relevance tiebreaker). */
  maxBonus?: number;
}

export interface RerankResult<T> {
  reranked: T[];
  /** Fraction of top-5 output pairs sharing ≥1 entity. 0 = isolated, 1 = fully clustered. */
  coherence: number;
}

/** Generic placeholder subjects the v6.5 entity extractor uses when no
 *  real subject is inferred. These would falsely link every memory together,
 *  so they're excluded from the coherence bag. */
const GENERIC_SUBJECTS = new Set<string>([
  "current_task",
  "user",
  "it",
  "this",
  "that",
  "el",
  "la",
  "eso",
  "esto",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Extract a normalized entity bag from content. Uses only the `subject`
 * field of extracted triples — objects are mostly free-form verb phrases
 * or dates and don't represent entity identity.
 */
function extractEntityBag(content: string): Set<string> {
  const bag = new Set<string>();
  if (!content || content.length < 20) return bag;

  const triples = extractEntities(content);
  for (const triple of triples) {
    const subject = triple.subject?.toLowerCase().trim();
    if (!subject || subject.length < 3) continue;
    if (GENERIC_SUBJECTS.has(subject)) continue;
    if (DATE_RE.test(subject)) continue;
    bag.add(subject);
  }
  return bag;
}

/**
 * Rerank retrieval results by graph coherence. Pure function — no I/O.
 */
export function rerankByCoherence<T extends RerankableItem>(
  items: T[],
  options: RerankOptions = {},
): RerankResult<T> {
  const bonus = options.connectivityBonus ?? 0.05;
  const maxBonus = options.maxBonus ?? 0.15;

  if (items.length === 0) {
    return { reranked: [], coherence: 0 };
  }
  if (items.length < 3) {
    // Nothing to cluster — return unchanged and set coherence to the
    // 2-item edge case: 1.0 if the single pair shares an entity, else 0.
    if (items.length === 2) {
      const bagA = extractEntityBag(items[0].content);
      const bagB = extractEntityBag(items[1].content);
      let shared = false;
      for (const e of bagA) {
        if (bagB.has(e)) {
          shared = true;
          break;
        }
      }
      return { reranked: items.slice(), coherence: shared ? 1 : 0 };
    }
    return { reranked: items.slice(), coherence: 1 };
  }

  // Work on a stable copy ordered by base score (descending).
  const sorted = items.slice().sort((a, b) => b._score - a._score);
  const bags = sorted.map((item) => extractEntityBag(item.content));

  // Build adjacency as a flat Set of "lo:hi" keys (lo < hi).
  const adjacency = new Set<string>();
  const edgeKey = (i: number, j: number): string => {
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    return `${lo}:${hi}`;
  };
  const isAdjacent = (i: number, j: number): boolean =>
    adjacency.has(edgeKey(i, j));

  for (let i = 0; i < sorted.length; i++) {
    const bagI = bags[i];
    if (bagI.size === 0) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const bagJ = bags[j];
      if (bagJ.size === 0) continue;
      for (const entity of bagI) {
        if (bagJ.has(entity)) {
          adjacency.add(edgeKey(i, j));
          break;
        }
      }
    }
  }

  // Greedy selection. Seed with the highest-scoring item (index 0 post-sort).
  const selected: number[] = [0];
  const remaining = new Set<number>();
  for (let i = 1; i < sorted.length; i++) remaining.add(i);

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestCombined = -Infinity;

    for (const cand of remaining) {
      const base = sorted[cand]._score;
      let connCount = 0;
      for (const sel of selected) {
        if (isAdjacent(cand, sel)) connCount++;
      }
      const bonusApplied = Math.min(connCount * bonus, maxBonus);
      const combined = base * (1 + bonusApplied);
      if (combined > bestCombined) {
        bestCombined = combined;
        bestIdx = cand;
      }
    }

    if (bestIdx === -1) break; // defensive — should not happen
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  // Build the output array as shallow copies so we can clamp scores
  // without mutating the caller's items.
  const reranked: T[] = selected.map((i) => ({ ...sorted[i] }));

  // Enforce monotonically decreasing scores. When a lower-base candidate
  // was promoted ahead of a higher-base one via the connectivity bonus,
  // its displayed score could exceed the prior item. Clamp to prev * 0.99
  // to preserve the invariant that output order reflects output score.
  for (let i = 1; i < reranked.length; i++) {
    if (reranked[i]._score > reranked[i - 1]._score) {
      reranked[i] = {
        ...reranked[i],
        _score: reranked[i - 1]._score * 0.99,
      };
    }
  }

  // Coherence metric over the top-5 reranked items. Use the selected[]
  // index array directly so we don't need to rediscover sorted positions.
  const topSelected = selected.slice(0, 5);
  let connectedPairs = 0;
  let maxPairs = 0;
  for (let i = 0; i < topSelected.length; i++) {
    for (let j = i + 1; j < topSelected.length; j++) {
      maxPairs++;
      if (isAdjacent(topSelected[i], topSelected[j])) {
        connectedPairs++;
      }
    }
  }
  const coherence = maxPairs === 0 ? 0 : connectedPairs / maxPairs;

  return { reranked, coherence };
}
