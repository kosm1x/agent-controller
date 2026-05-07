/**
 * Skill evaluation loop — anthropic skill-creator pattern (v7.5 L3).
 *
 * The "draft → test with/without → grade → improve" cycle adapted for
 * Jarvis. Used to compare a candidate skill (a string of guidance,
 * usually injected into a system prompt) against the no-skill baseline
 * across a list of test cases.
 *
 *   1. baseline   — run inferFn(message)        → output (no skill context)
 *   2. with-skill — run inferFn(skill+message)  → output (skill prepended)
 *   3. grade      — run assertions {text,passed,evidence} on each output
 *   4. compare    — emit per-case delta + overall recommendation
 *
 * The "improve" step is left to the caller (existing meta-agent or
 * operator) — this module's contract is to *measure* whether a skill
 * helps, not to mutate it.
 *
 * No production wiring yet. Operator activates manually via the test
 * harness or a future CLI command. Off-by-default keeps the cron
 * unchanged.
 */

export interface SkillEvalCase {
  /** Stable id used in result keys + per-case logs. */
  id: string;
  /** The user message / task description fed to inferFn. */
  message: string;
  /**
   * Assertions evaluated against each output. Must use the exact field
   * names from the skill-creator pattern: `text` (the assertion claim,
   * for human readability), `passed` (boolean), `evidence` (a substring
   * or regex pattern that determines pass; serialized into result).
   *
   * If `evidence` is a RegExp, it's matched with .test(); if it's a
   * string, it's a case-insensitive substring check. Empty evidence
   * never passes (callers must specify a real check).
   */
  assertions: SkillEvalAssertion[];
}

export interface SkillEvalAssertion {
  text: string;
  evidence: string | RegExp;
}

export interface SkillEvalAssertionResult {
  text: string;
  passed: boolean;
  evidence: string;
}

export interface SkillEvalCaseResult {
  caseId: string;
  /** Score = passed assertions / total assertions, 0-1. */
  baselineScore: number;
  withSkillScore: number;
  /** withSkill - baseline. Positive = skill helped. */
  delta: number;
  baselineAssertions: SkillEvalAssertionResult[];
  withSkillAssertions: SkillEvalAssertionResult[];
  /** Tokens consumed across both calls for this case. */
  tokensUsed: number;
}

export interface SkillEvalReport {
  /** Aggregate baseline score (mean of per-case baselineScore). */
  baseline: number;
  /** Aggregate with-skill score (mean of per-case withSkillScore). */
  withSkill: number;
  /** Aggregate delta (mean of per-case delta). */
  delta: number;
  /** Number of cases where the skill helped (delta > 0). */
  improved: number;
  /** Number of cases where the skill hurt (delta < 0). */
  regressed: number;
  /** Number of cases where the skill was neutral (delta === 0). */
  unchanged: number;
  /** Total tokens consumed across baseline + with-skill calls. */
  tokensUsed: number;
  /** Total LLM calls = `cases.length * 2` (baseline + with-skill arms). */
  callsTotal: number;
  /** Per-case breakdown. */
  perCase: SkillEvalCaseResult[];
  /**
   * Case ids whose `assertions` array was empty. These cases score 1.0 in
   * both arms (no assertions = no claim of failure), which inflates the
   * aggregate baseline / withSkill toward 1.0 without affecting `delta`.
   * Operator should treat a non-empty list as a fixture gap to fix, not
   * a real signal. Audit W4.
   */
  emptyCaseIds: string[];
  /**
   * Recommendation derived from `delta` + `regressed` count. Provides a
   * one-shot answer the meta-agent / operator can act on without having
   * to re-implement the heuristic.
   */
  recommendation: SkillEvalRecommendation;
}

export type SkillEvalRecommendation =
  /** Skill clearly helps; ship as-is. */
  | "adopt"
  /** Net positive but with regressions; refine before ship. */
  | "refine"
  /** Net neutral; not worth the prompt budget. */
  | "discard"
  /** Skill hurts; reject. */
  | "reject";

/** Minimum sample-size threshold for a confident recommendation. */
const MIN_CASES_FOR_CONFIDENCE = 3;

/**
 * Function signature for the LLM call. Produces a text output for a given
 * (system-skill, user-message) pair. Returns the output and tokens used.
 *
 * Splitting system from user lets callers inject the skill cleanly into
 * the system role rather than smashing it into the user message — better
 * for prompt-cache hit rates.
 */
export type SkillEvalInferFn = (
  systemPrompt: string,
  userMessage: string,
) => Promise<{ content: string; tokensUsed: number }>;

/**
 * Run a single assertion against an output. Empty evidence always fails
 * — callers must specify a concrete check.
 */
function checkAssertion(
  output: string,
  assertion: SkillEvalAssertion,
): SkillEvalAssertionResult {
  const { text, evidence } = assertion;
  let passed = false;
  let evidenceStr: string;
  if (evidence instanceof RegExp) {
    passed = evidence.test(output);
    evidenceStr = String(evidence);
  } else {
    if (evidence.length === 0) {
      passed = false;
      evidenceStr = "(empty evidence — assertion always fails)";
    } else {
      passed = output.toLowerCase().includes(evidence.toLowerCase());
      evidenceStr = evidence;
    }
  }
  return { text, passed, evidence: evidenceStr };
}

/**
 * Score a single output against its assertions. Returns 0-1 (passed/total).
 * Cases with zero assertions always score 1.0 — no assertion = no claim
 * the output failed.
 */
function scoreOutput(
  output: string,
  assertions: SkillEvalAssertion[],
): { score: number; results: SkillEvalAssertionResult[] } {
  if (assertions.length === 0) return { score: 1, results: [] };
  const results = assertions.map((a) => checkAssertion(output, a));
  const passed = results.filter((r) => r.passed).length;
  return { score: passed / results.length, results };
}

/**
 * Decide a recommendation from the aggregate numbers.
 *
 * Heuristic:
 *   - regressed > improved → reject (skill hurts more than helps)
 *   - delta < 0.05         → discard (net effect too small to justify)
 *   - regressed > 0        → refine (positive net but mixed signals)
 *   - else                 → adopt
 *
 * Confidence guard: when sample size is below MIN_CASES_FOR_CONFIDENCE,
 * `adopt` is downgraded to `refine` so a 2-case "win" doesn't trigger an
 * aggressive ship signal. `reject` and `discard` are intentionally NOT
 * downgraded — both are conservative outcomes; a 2-case rejection is
 * already correctly read as "we should not ship this," and downgrading
 * would invert the safety polarity. `refine` doesn't need a downgrade
 * because it already implies "more data needed."
 */
export function recommend(
  baseline: number,
  withSkill: number,
  improved: number,
  regressed: number,
  totalCases: number,
): SkillEvalRecommendation {
  const delta = withSkill - baseline;
  let rec: SkillEvalRecommendation;
  if (regressed > improved) rec = "reject";
  else if (delta < 0.05) rec = "discard";
  else if (regressed > 0) rec = "refine";
  else rec = "adopt";

  // Confidence downgrade for small samples.
  if (totalCases < MIN_CASES_FOR_CONFIDENCE && rec === "adopt") {
    return "refine";
  }
  return rec;
}

/**
 * Run the skill evaluation loop end-to-end.
 *
 * @param skill        Candidate skill text. Empty string is a valid no-op.
 * @param baselineSys  Baseline system prompt (the "without skill" condition).
 *                     The skill text is appended to this for the with-skill arm.
 * @param cases        Test cases with assertions.
 * @param inferFn      LLM call adapter. Tests inject deterministic stubs.
 */
export async function runSkillEval(
  skill: string,
  baselineSys: string,
  cases: readonly SkillEvalCase[],
  inferFn: SkillEvalInferFn,
): Promise<SkillEvalReport> {
  const perCase: SkillEvalCaseResult[] = [];
  let totalTokens = 0;

  for (const c of cases) {
    const baseline = await inferFn(baselineSys, c.message);
    const withSkill = await inferFn(
      `${baselineSys}\n\n${skill}`.trim(),
      c.message,
    );
    totalTokens += baseline.tokensUsed + withSkill.tokensUsed;

    const baseScored = scoreOutput(baseline.content, c.assertions);
    const skillScored = scoreOutput(withSkill.content, c.assertions);

    perCase.push({
      caseId: c.id,
      baselineScore: baseScored.score,
      withSkillScore: skillScored.score,
      delta: skillScored.score - baseScored.score,
      baselineAssertions: baseScored.results,
      withSkillAssertions: skillScored.results,
      tokensUsed: baseline.tokensUsed + withSkill.tokensUsed,
    });
  }

  const totalCases = perCase.length || 1;
  const baseAvg = perCase.reduce((s, r) => s + r.baselineScore, 0) / totalCases;
  const skillAvg =
    perCase.reduce((s, r) => s + r.withSkillScore, 0) / totalCases;
  const improved = perCase.filter((r) => r.delta > 0).length;
  const regressed = perCase.filter((r) => r.delta < 0).length;
  const unchanged = perCase.filter((r) => r.delta === 0).length;
  const emptyCaseIds = cases
    .filter((c) => c.assertions.length === 0)
    .map((c) => c.id);

  return {
    baseline: baseAvg,
    withSkill: skillAvg,
    delta: skillAvg - baseAvg,
    improved,
    regressed,
    unchanged,
    tokensUsed: totalTokens,
    callsTotal: cases.length * 2,
    perCase,
    emptyCaseIds,
    recommendation: recommend(
      baseAvg,
      skillAvg,
      improved,
      regressed,
      perCase.length,
    ),
  };
}
