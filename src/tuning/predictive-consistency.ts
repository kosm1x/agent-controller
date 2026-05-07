/**
 * Predictive consistency gate — RationalRewards / PARROT phase 2 (v7.5 L3).
 *
 * Validates a mutation's *hypothesis* by asking the LLM to predict per-case
 * outcomes given ONLY the hypothesis + case description (no eval results).
 * If the prediction accuracy is below threshold, the hypothesis is judged
 * post-hoc rationalization, not a real causal claim, and the mutation is
 * rejected even if its scores improve.
 *
 * From the paper: 72% of generated rationales survive predictive
 * consistency filtering; 28% are hallucinated/insufficient. Catching
 * those before they're "kept" prevents the variant archive from
 * collecting fluent-sounding-but-untrue narratives.
 *
 * Opt-in via `TUNING_PREDICTIVE_CONSISTENCY=true`. Default off — gate
 * costs one extra LLM call per checked case.
 *
 * Cost shape: bounded by `MAX_PROBE_CASES`. Default 3 cases means at
 * most 3 short LLM calls per mutation. Mutations with <3 affected
 * cases probe all of them; mutations with more are sampled.
 */

import type { CaseScore, Mutation, TestCase } from "./types.js";

/** Hard cap on the number of cases probed per mutation, regardless of input. */
const MAX_PROBE_CASES = 3;

/** Pass threshold: fraction of probes that must match the actual outcome. */
const DEFAULT_ACCURACY_THRESHOLD = 0.5;

export interface PredictiveCheckResult {
  /** True if the hypothesis predicted >= threshold of probe outcomes. */
  passed: boolean;
  /** Number of probes whose prediction matched actual outcome. */
  correct: number;
  /** Total probes attempted (≤ MAX_PROBE_CASES). */
  total: number;
  /** Tokens consumed by all probes combined. */
  tokensUsed: number;
  /**
   * Human-readable rejection reason. Undefined on pass. Examples:
   *   - "no probe cases available"
   *   - "predicted 0/3 outcomes correctly (threshold 0.5)"
   */
  reason?: string;
}

/**
 * Function signature for the LLM probe. The implementation calls the LLM
 * with ONLY the hypothesis + case description, asks for a binary
 * pass/fail prediction, and returns the prediction + tokens consumed.
 *
 * Injectable so tests use a deterministic stub instead of real inference.
 */
export type PredictionInferFn = (
  hypothesis: string,
  caseInput: string,
) => Promise<{ predictedPass: boolean; tokensUsed: number }>;

/**
 * Sample the cases to probe. Strategy:
 *   1. Prefer cases the mutation is hypothesised to affect (the affected
 *      set is the eval signal; we want to know if the hypothesis predicts
 *      the same thing the eval does).
 *   2. Cap at MAX_PROBE_CASES to bound LLM cost.
 *   3. Stable, deterministic sampling — first N by case_id sort order so
 *      cooldown/replay tests are reproducible.
 *
 * Exported for tests; not part of the public gate contract.
 */
export function sampleProbeCases(
  affectedCaseIds: string[],
  allCases: readonly TestCase[],
  cap: number = MAX_PROBE_CASES,
): TestCase[] {
  if (cap <= 0) return [];
  const affected = new Set(affectedCaseIds);
  const candidates = allCases.filter((c) => affected.has(c.case_id));
  const sorted = [...candidates].sort((a, b) =>
    a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0,
  );
  return sorted.slice(0, cap);
}

export interface RunPredictiveCheckOptions {
  /** Pass threshold (0..1). Defaults to 0.5 — predict better than chance. */
  threshold?: number;
  /** Max probes (≤ MAX_PROBE_CASES). Defaults to MAX_PROBE_CASES. */
  maxProbes?: number;
}

/**
 * Run the predictive consistency gate on a mutation.
 *
 * Builds the probe set from `affectedCaseIds`, asks `inferFn` to predict
 * each case's outcome based ONLY on the hypothesis + case description,
 * then compares predictions to actual `perCase` outcomes.
 *
 * Returns `{passed, correct, total, tokensUsed, reason?}`. The caller
 * decides what to do with a failed gate (reject, demote, log).
 */
export async function runPredictiveCheck(
  mutation: Mutation,
  affectedCaseIds: string[],
  allCases: readonly TestCase[],
  perCase: readonly CaseScore[],
  inferFn: PredictionInferFn,
  options: RunPredictiveCheckOptions = {},
): Promise<PredictiveCheckResult> {
  const threshold = options.threshold ?? DEFAULT_ACCURACY_THRESHOLD;
  const maxProbes = Math.min(
    options.maxProbes ?? MAX_PROBE_CASES,
    MAX_PROBE_CASES,
  );

  const probeCases = sampleProbeCases(affectedCaseIds, allCases, maxProbes);
  if (probeCases.length === 0) {
    return {
      passed: false,
      correct: 0,
      total: 0,
      tokensUsed: 0,
      reason: "no probe cases available — mutation has no affected cases",
    };
  }

  const scoreById = new Map<string, number>();
  for (const cs of perCase) scoreById.set(cs.caseId, cs.score);

  let correct = 0;
  let tokensUsed = 0;

  for (const probe of probeCases) {
    const actualScore = scoreById.get(probe.case_id);
    // If the eval didn't produce a score for this case, we can't check
    // consistency — skip silently rather than fabricate ground truth.
    if (actualScore === undefined) continue;
    // Strict `>` so the 0.5 boundary counts as fail. Eval scores cluster on
    // integer fractions (0.0, 0.33, 0.5, 0.66, 1.0); treating 0.5 as PASS
    // would silently classify half-broken cases as successes. Audit W3.
    const actualPass = actualScore > 0.5;

    const { predictedPass, tokensUsed: t } = await inferFn(
      mutation.hypothesis,
      probe.input.message,
    );
    tokensUsed += t;
    if (predictedPass === actualPass) correct++;
  }

  const total = probeCases.length;
  const accuracy = total > 0 ? correct / total : 0;
  const passed = accuracy >= threshold;

  return {
    passed,
    correct,
    total,
    tokensUsed,
    reason: passed
      ? undefined
      : `predicted ${correct}/${total} outcomes correctly (threshold ${threshold})`,
  };
}

/** Read the env flag that activates the gate at the overnight-loop layer. */
export function isPredictiveConsistencyEnabled(): boolean {
  return process.env.TUNING_PREDICTIVE_CONSISTENCY === "true";
}

/**
 * The probe prompt: shown to the LLM with ONLY the hypothesis + case
 * message. The LLM must predict pass/fail without ever seeing the eval
 * outcome. Exported so callers (and tests) can inspect the exact text.
 */
export const PROBE_SYSTEM_PROMPT = `You are predicting whether a tuning hypothesis would pass or fail on a specific test case. You will see ONLY the hypothesis and the case input — never the actual eval outcome.

Answer with EXACTLY one word: PASS or FAIL.

PASS = the hypothesis predicts the system will handle this case correctly.
FAIL = the hypothesis predicts the system will struggle with this case.

If the hypothesis is so vague it could "predict" any outcome, answer FAIL — vague rationales are the failure mode this gate exists to catch.`;

/**
 * Default predict-from-infer adapter. Builds the probe prompt, calls
 * `inferTextFn` (a thin wrapper over the standard adapter), and parses
 * the PASS/FAIL response. Used by the overnight loop in production.
 *
 * Exported so tests for the adapter shape can target it without spinning
 * up the whole tuning pipeline.
 */
export function makeDefaultPredictionInfer(
  inferTextFn: (
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<{ content: string; tokensUsed: number }>,
): PredictionInferFn {
  return async (hypothesis, caseInput) => {
    const userPrompt = `Hypothesis:\n${hypothesis}\n\nCase input:\n${caseInput}\n\nPrediction (PASS or FAIL):`;
    const { content, tokensUsed } = await inferTextFn(
      PROBE_SYSTEM_PROMPT,
      userPrompt,
    );
    // Be lenient on parsing — first PASS/FAIL token wins; everything else is FAIL.
    const m = content.toUpperCase().match(/\b(PASS|FAIL)\b/);
    const predictedPass = m?.[1] === "PASS";
    return { predictedPass, tokensUsed };
  };
}
