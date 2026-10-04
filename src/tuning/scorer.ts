/**
 * Scoring logic for the self-tuning eval harness.
 *
 * Three sub-metrics:
 * - Tool selection accuracy (50%): did the LLM call the right tools?
 * - Scope accuracy (30%): did scopeTools include the right groups?
 * - Classification accuracy (20%): did classify() return the right agent_type?
 */

import type { TestCaseExpected, CaseScore, EvalSubscores } from "./types.js";
import { METRIC_WEIGHTS } from "./types.js";

// ---------------------------------------------------------------------------
// Per-case scoring
// ---------------------------------------------------------------------------

/**
 * Score a tool_selection test case.
 *
 * Only tools that were OFFERED to the model count (`offered` = the names in
 * the definitions the probe sent; omitted = all offered). A case with nothing
 * checkable — no offered expected tool and no offered forbidden tool — comes
 * back `excluded: true` and must not be averaged; the evaluator never probes
 * it. A case whose expected tools are all unreachable but which forbids an
 * offered tool is scored forbidden-only.
 *
 * `expected.first_tools` (recorded by the miner) is NOT scored: without round
 * boundaries it is one arbitrary tool of a possibly parallel first round.
 *
 * Scoring over the offered expected tools (n):
 * - n = 1: 1.0 if called, else 0.0 (unchanged from the proportional rule)
 * - n > 1: "any-hit" — 1.0 if at least one was called, else 0.0. One probe
 *   shows one round; a multi-step task's later tools can't appear in it.
 * - -2.0 per forbidden tool called, normalised over one slot (n > 1) or n
 * - n = 0 (forbidden-only): 1.0 with no violation, else 0.0
 * - clamped to 0.0-1.0
 * `details.proportionalScore` keeps the old hits/n rule for comparison.
 */
export function scoreToolSelection(
  expected: TestCaseExpected,
  actualToolsCalled: string[],
  offered?: ReadonlySet<string>,
): { score: number; excluded: boolean; details: Record<string, unknown> } {
  const calledSet = new Set(actualToolsCalled);
  const scoredTools = expected.tools ?? [];
  const forbiddenTools = expected.not_tools ?? [];

  const isOffered = (t: string) => !offered || offered.has(t);
  const expectedTools = scoredTools.filter(isOffered);
  const unreachable = scoredTools.filter((t) => !isOffered(t));
  const forbiddenOffered = forbiddenTools.filter(isOffered);

  if (
    scoredTools.length + forbiddenTools.length > 0 &&
    expectedTools.length === 0 &&
    forbiddenOffered.length === 0
  ) {
    return {
      score: 0,
      excluded: true,
      details: {
        expected: scoredTools,
        forbidden: forbiddenTools,
        called: actualToolsCalled,
        offered: expectedTools,
        unreachable,
        excluded: true,
      },
    };
  }

  let points = 0;
  let maxPoints = 0;

  // Expected tools present
  const hits: string[] = [];
  const misses: string[] = [];
  for (const t of expectedTools) {
    maxPoints += 1;
    if (calledSet.has(t)) {
      points += 1;
      hits.push(t);
    } else {
      misses.push(t);
    }
  }

  // Forbidden tools absent (penalty only, no positive points)
  const violations: string[] = [];
  for (const t of forbiddenTools) {
    if (calledSet.has(t)) {
      points -= 2;
      violations.push(t);
    }
  }

  const reach = {
    expected: scoredTools,
    forbidden: forbiddenTools,
    called: actualToolsCalled,
    offered: expectedTools,
    unreachable,
    hits,
    misses,
    violations,
  };

  // If no positive expectations, score based on forbidden-only:
  // No violations → 1.0, any violation → 0.0
  if (expectedTools.length === 0) {
    const score = violations.length === 0 ? 1.0 : 0.0;
    return {
      score,
      excluded: false,
      details: {
        ...reach,
        scoring: "forbidden_only",
        rawPoints: points,
        maxPoints: 0,
        proportionalScore: score,
      },
    };
  }

  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const proportionalScore = clamp(points / maxPoints);
  const anyHit = expectedTools.length > 1;
  const score = anyHit
    ? clamp((hits.length > 0 ? 1 : 0) - 2 * violations.length)
    : proportionalScore;

  return {
    score,
    excluded: false,
    details: {
      ...reach,
      scoring: anyHit ? "any_hit" : "single",
      rawPoints: points,
      maxPoints,
      proportionalScore,
    },
  };
}

/**
 * Score a scope_accuracy test case.
 *
 * Binary per-group: correct if expected groups are active and
 * forbidden groups are not.
 */
export function scoreScopeAccuracy(
  expected: TestCaseExpected,
  activeGroups: Set<string>,
): { score: number; details: Record<string, unknown> } {
  const expectedGroups = expected.scope_groups ?? [];
  const forbiddenGroups = expected.not_scope_groups ?? [];
  const totalChecks = expectedGroups.length + forbiddenGroups.length;

  if (totalChecks === 0) return { score: 1, details: { note: "no checks" } };

  let correct = 0;
  const hits: string[] = [];
  const misses: string[] = [];
  const violations: string[] = [];

  for (const g of expectedGroups) {
    if (activeGroups.has(g)) {
      correct++;
      hits.push(g);
    } else {
      misses.push(g);
    }
  }

  for (const g of forbiddenGroups) {
    if (!activeGroups.has(g)) {
      correct++;
    } else {
      violations.push(g);
    }
  }

  return {
    score: correct / totalChecks,
    details: {
      expectedGroups,
      forbiddenGroups,
      activeGroups: [...activeGroups],
      hits,
      misses,
      violations,
    },
  };
}

/**
 * Score a classification test case.
 *
 * Binary: 1.0 if agent_type matches, 0.0 otherwise.
 */
export function scoreClassification(
  expected: TestCaseExpected,
  actualAgentType: string,
): { score: number; details: Record<string, unknown> } {
  const expectedType = expected.agent_type ?? "fast";
  const match = actualAgentType === expectedType;

  return {
    score: match ? 1.0 : 0.0,
    details: { expected: expectedType, actual: actualAgentType, match },
  };
}

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

/**
 * Compute composite score from per-case results.
 *
 * Groups cases by category, computes weighted average per category,
 * then combines using METRIC_WEIGHTS.
 */
export function computeCompositeScore(cases: CaseScore[]): {
  compositeScore: number;
  subscores: EvalSubscores;
} {
  const byCategory = {
    tool_selection: [] as CaseScore[],
    scope_accuracy: [] as CaseScore[],
    classification: [] as CaseScore[],
  };

  for (const c of cases) {
    if (c.category in byCategory) {
      byCategory[c.category].push(c);
    }
  }

  function weightedAvg(scores: CaseScore[]): number {
    if (scores.length === 0) return 0;
    let wSum = 0;
    let wDenom = 0;
    for (const s of scores) {
      const w = s.weight ?? 1.0;
      wSum += s.score * w;
      wDenom += w;
    }
    return wDenom > 0 ? (wSum / wDenom) * 100 : 0;
  }

  const subscores: EvalSubscores = {
    toolSelection: weightedAvg(byCategory.tool_selection),
    scopeAccuracy: weightedAvg(byCategory.scope_accuracy),
    classification: weightedAvg(byCategory.classification),
  };

  const compositeScore =
    subscores.toolSelection * METRIC_WEIGHTS.toolSelection +
    subscores.scopeAccuracy * METRIC_WEIGHTS.scopeAccuracy +
    subscores.classification * METRIC_WEIGHTS.classification;

  return { compositeScore, subscores };
}
