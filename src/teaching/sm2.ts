/**
 * SM-2 spaced-repetition algorithm. Pure function.
 * Quality ∈ {0..5}: 0 = blank, 3 = pass, 5 = perfect.
 * Reference: Piotr Wozniak, SuperMemo 2 (1987).
 */

import { EF_FLOOR, type Sm2State } from "./schema-types.js";

export interface Sm2Input {
  ef: number;
  interval_days: number;
  repetitions: number;
  quality: number;
  /** Unix-seconds "now" reference. */
  now: number;
}

const SECONDS_PER_DAY = 86400;

export function nextReview(input: Sm2Input): Sm2State {
  const q = Math.max(0, Math.min(5, Math.round(input.quality)));
  let { ef, interval_days, repetitions } = input;

  if (q < 3) {
    repetitions = 0;
    interval_days = 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) {
      interval_days = 1;
    } else if (repetitions === 2) {
      interval_days = 6;
    } else {
      interval_days = Math.round(interval_days * ef);
    }
  }

  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < EF_FLOOR) ef = EF_FLOOR;

  const review_due_date = input.now + interval_days * SECONDS_PER_DAY;
  return { ef, interval_days, repetitions, review_due_date };
}

/** Display-only mastery score derived from SM-2 state. Clamped [0,1]. */
export function masteryFromSm2(
  ef: number,
  repetitions: number,
  interval_days: number,
): number {
  const base = Math.min(1, repetitions / 6);
  const efFactor = Math.min(1, ef / 2.5);
  const longTerm = Math.min(1, interval_days / 30);
  const score = 0.6 * base * efFactor + 0.4 * longTerm;
  return Math.max(0, Math.min(1, score));
}

/** Map a mastery estimate (0..1) from summary LLM to SM-2 quality (0..5). */
export function masteryToQuality(mastery: number): number {
  const m = Math.max(0, Math.min(1, mastery));
  return Math.round(m * 5);
}
