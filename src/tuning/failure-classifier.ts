/**
 * Failure-source classifier (SkillClaw pattern, arXiv:2604.08377).
 *
 * For experiments that regress or error, assigns one of:
 *   - `skill` — the mutation itself was bad (generalizable rule violation,
 *     breaks multiple cases, or inflates complexity)
 *   - `agent` — the LLM misused an otherwise-OK mutation (tool-call shape
 *     errors, classification drift, scope over/under-match)
 *   - `env` — infra failed (timeout, rate limit, adapter error)
 *
 * Pure heuristic; no LLM call. Runs only on non-pass experiments — a `pass`
 * is never classified. Output is telemetry-only: never blocks a mutation.
 */

import type {
  CaseScore,
  ExperimentStatus,
  FailureSource,
  Mutation,
} from "./types.js";

export interface ClassifyInput {
  status: ExperimentStatus;
  mutation: Mutation;
  /** Per-case scores from the targeted re-eval (may be empty on error). */
  perCase?: CaseScore[];
  /** Free-form error string if status === "error". */
  errorMessage?: string | null;
}

const ENV_ERROR_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /rate[\s-]?limit/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /network/i,
  /socket/i,
  /fetch failed/i,
  /experiment timeout/i,
];

/**
 * Classify a non-pass experiment into skill / agent / env.
 * Returns null when status is `passed` — pass experiments are never
 * classified to avoid polluting telemetry.
 */
export function classifyFailureSource(
  input: ClassifyInput,
): FailureSource | null {
  if (input.status === "passed") return null;
  // `pending` is a transient state that should never reach the classifier,
  // but guard defensively so a stray call returns null instead of "skill".
  if (input.status === "pending") return null;

  // ─── env rules (cheapest signal — string matches on the error) ───────────
  if (input.status === "error") {
    const msg = input.errorMessage ?? "";
    if (ENV_ERROR_PATTERNS.some((rx) => rx.test(msg))) return "env";
    // Error without a recognizable env signature → default to skill.
    return "skill";
  }

  // ─── rejected (gate-blocked before eval) → skill (bad mutation) ──────────
  if (input.status === "rejected") return "skill";

  // ─── regressed: inspect per-case distribution ────────────────────────────
  const perCase = input.perCase ?? [];
  if (perCase.length === 0) {
    // No per-case data — fall back to mutation shape heuristics.
    return inferFromMutationShape(input.mutation);
  }

  // Count regressions by category.
  const categoryCounts = new Map<string, number>();
  for (const c of perCase) {
    if (c.score < 0.5) {
      categoryCounts.set(c.category, (categoryCounts.get(c.category) ?? 0) + 1);
    }
  }

  // Classification drift alone → agent (LLM routing issue, not mutation).
  if (
    categoryCounts.size === 1 &&
    categoryCounts.has("classification") &&
    input.mutation.surface !== "classifier"
  ) {
    return "agent";
  }

  // Scope over/under-match WHEN the mutation was NOT a scope_rule → agent
  // (the LLM drifted on a regex that wasn't even changed).
  if (
    categoryCounts.size === 1 &&
    categoryCounts.has("scope_accuracy") &&
    input.mutation.surface !== "scope_rule"
  ) {
    return "agent";
  }

  // Default: the mutation surface was the one that regressed → skill.
  return "skill";
}

/**
 * Shape-based fallback when per-case data is unavailable.
 * Distinguishes `rejected`-for-complexity (skill) from other shapes.
 */
function inferFromMutationShape(mutation: Mutation): FailureSource {
  const mutatedLen = mutation.mutated_value.length;
  // Very long mutations that break evaluation typically indicate a bad
  // rewrite — skill, not agent.
  if (mutatedLen > 4000) return "skill";
  return "skill";
}
