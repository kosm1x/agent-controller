/**
 * Confidence-signal proxy (GEPA v0.1.1 ConfidenceAdapter, stddev variant).
 *
 * GEPA exposes token-level logprobs to distinguish "succeeded with high
 * confidence" from "lucky guess". Our primary provider (qwen) doesn't yet
 * expose reliable logprobs, so we use a lightweight proxy: per-case score
 * stddev across the evaluation. Low stddev + high mean = consistent
 * high-confidence behavior; high stddev = the mutation helped some cases
 * at the cost of others (a signal the reflector can use later).
 *
 * Range: 0 (worst) .. 1 (best). A single-case eval returns 1.0 trivially.
 */

import type { CaseScore } from "./types.js";

/**
 * Compute a confidence proxy from per-case scores.
 * Returns 1.0 for 0- or 1-case inputs (no variance to measure).
 */
export function computeConfidenceProxy(perCase: CaseScore[]): number {
  if (perCase.length <= 1) return 1.0;

  const scores = perCase.map((c) => c.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);

  // Max possible stddev on 0..1 scale is 0.5 (half 0s, half 1s).
  // Normalize and invert: low stddev → high confidence.
  const normalized = Math.min(1, stddev / 0.5);
  return Number((1 - normalized).toFixed(4));
}
