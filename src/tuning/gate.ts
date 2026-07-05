/**
 * Pure verdict math for the model-swap eval gate (`scripts/eval-gate.ts`).
 *
 * No I/O, no LLM, no DB — just the PASS/FAIL/regression arithmetic so it can be
 * unit-tested without spend (`src/tuning/gate.test.ts`). The gate script owns
 * env inheritance, DB reads, scoring (via the existing eval-runner), and
 * printing; this module owns only "did the candidate regress past tolerance?".
 */

export interface EvalBaseline {
  /** Incumbent composite score (0-100) the CURRENT prod model config achieves. */
  overall: number;
  /**
   * Regression tolerance, in composite points on the 0-100 scale.
   * Optional in the file — falls back to {@link DEFAULT_EPSILON}.
   */
  epsilon?: number;
  /** Optional per-metric incumbents (informational only — not gated). */
  subscores?: {
    toolSelection: number;
    scopeAccuracy: number;
    classification: number;
  };
  /** Free-form provenance metadata (model, capturedAt, source, note...) — ignored by the math. */
  [key: string]: unknown;
}

export type Verdict = "PASS" | "FAIL";

export interface GateResult {
  verdict: Verdict;
  /** Candidate composite score just measured (0-100). */
  overall: number;
  /** Incumbent composite score from the stored baseline (0-100). */
  incumbent: number;
  /** Tolerance actually applied (composite points). */
  epsilon: number;
  /** incumbent - epsilon; the candidate must be >= this to PASS. */
  threshold: number;
  /** overall - incumbent. Negative = candidate scored lower than incumbent. */
  delta: number;
  /** True when the candidate fell below the tolerance floor. */
  regressed: boolean;
}

/**
 * Default regression tolerance, in composite points on the 0-100 scale.
 *
 * The brief's suggested "0.02" was expressed on a 0-1 score scale; the scorer
 * here reports 0-100, so ×100 = 2.0 points. Two points comfortably absorbs the
 * ~0.5-1 point run-to-run wobble of the LLM tool_selection metric while still
 * failing loudly on a gross tool-adherence collapse (the Sonnet-5 failure mode).
 */
export const DEFAULT_EPSILON = 2.0;

/**
 * Resolve the tolerance to apply: an explicit CLI override wins, else the
 * baseline file's value, else {@link DEFAULT_EPSILON}. Negative / non-finite
 * values are rejected (fall through to the next source) so a bad flag or a
 * corrupted file can never widen the gate to "always pass".
 */
export function resolveEpsilon(
  fileEpsilon?: number,
  flagEpsilon?: number,
): number {
  for (const candidate of [flagEpsilon, fileEpsilon]) {
    if (
      candidate !== undefined &&
      Number.isFinite(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  return DEFAULT_EPSILON;
}

/**
 * Compare a freshly measured composite score against the stored incumbent.
 *
 * PASS iff `overall >= incumbent - epsilon`. FAIL (a regression beyond
 * tolerance) otherwise. Boundary is inclusive: landing exactly on the threshold
 * PASSes.
 */
export function compareToBaseline(
  overall: number,
  incumbent: number,
  epsilon: number = DEFAULT_EPSILON,
): GateResult {
  if (!Number.isFinite(overall) || !Number.isFinite(incumbent)) {
    throw new Error(
      `compareToBaseline: non-finite input (overall=${overall}, incumbent=${incumbent})`,
    );
  }
  const eps =
    Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : DEFAULT_EPSILON;
  const threshold = incumbent - eps;
  const delta = overall - incumbent;
  const regressed = overall < threshold;
  return {
    verdict: regressed ? "FAIL" : "PASS",
    overall,
    incumbent,
    epsilon: eps,
    threshold,
    delta,
    regressed,
  };
}
