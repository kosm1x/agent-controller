/**
 * Inline self-review gate (Superpowers v5.0.6 pattern).
 *
 * Replaces the subagent-dispatch review loop with a single synchronous
 * inline LLM call against a 4-item checklist. Upstream demonstrates
 * comparable defect-detection rate at ~50x faster wall-clock. We run it
 * BEFORE the expensive tool_selection eval, so a failed review blocks
 * the mutation without spending the eval budget.
 *
 * Opt-in via TUNING_SELF_REVIEW=true. Default off — flag-gated until
 * local telemetry validates the cost/benefit tradeoff.
 */

import type { Mutation } from "./types.js";

export interface SelfReviewResult {
  /** True if the mutation passes all 4 checks. */
  passed: boolean;
  /** Human-readable rejection reason. Undefined on pass. */
  reason?: string;
  /** Tokens used by the review LLM call (0 when disabled). */
  tokensUsed: number;
}

export type SelfReviewInferFn = (prompt: string) => Promise<{
  content: string;
  tokensUsed: number;
}>;

const REVIEW_PROMPT = `You are reviewing a proposed mutation to an LLM agent configuration. Reply with EXACTLY one of:

ACCEPT
REJECT: <one-sentence reason>

Check all four criteria:
1. No placeholder text (TODO, FIXME, <fill in>, [example]) in the mutated value.
2. Type consistency — the mutated value is the same kind as the original (regex→regex, description→description, etc).
3. Scope alignment — the hypothesis describes a behavior that the mutation actually changes.
4. No ambiguity — the mutated value does not contain contradictory clauses.

MUTATION TO REVIEW:
- Surface: {surface}
- Target: {target}
- Hypothesis: {hypothesis}
- Original: {original}
- Mutated:  {mutated}

Decision:`;

/**
 * Placeholder patterns are intentionally narrow to avoid false-positives on
 * legitimate content. A bare `TODO` inside an otherwise-valid description
 * (e.g. "Track TODOs and outstanding tasks") must NOT trigger rejection;
 * only placeholder-shaped forms do.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bTODO:\s/i, // "TODO: fill in" — template marker, not the noun
  /\bFIXME\b/, // bare FIXME is almost never legitimate in tool descriptions
  /\bXXX\b(?!\w)/, // XXX placeholder (word-boundary-safe)
  /<\s*fill\s*in\s*>/i,
  /<\s*insert\s+[a-z\s]*>/i, // <INSERT DESCRIPTION>
  /<\s*(?:replace|your[_\s-]?[a-z]+)\b[^>]*>/i, // <REPLACE>, <YOUR_TEXT>
  /\[example\]/i,
  /\[placeholder\]/i,
  /\[tbd\]/i,
  /\{\{\s*[a-z_]+\s*\}\}/i, // unsubstituted {{template}}
];

/**
 * Run self-review. When the flag is off, returns a synthetic pass with
 * zero tokens — safe to call unconditionally.
 *
 * The heuristic placeholder check runs even when the LLM path is disabled,
 * since it's free and catches the most common failure mode.
 */
export async function runSelfReview(
  mutation: Mutation,
  originalValue: string,
  inferFn?: SelfReviewInferFn,
): Promise<SelfReviewResult> {
  // Always-on heuristic: reject on placeholder text (costs nothing).
  const placeholderHit = PLACEHOLDER_PATTERNS.find((rx) =>
    rx.test(mutation.mutated_value),
  );
  if (placeholderHit) {
    return {
      passed: false,
      reason: `placeholder text detected: ${placeholderHit.source}`,
      tokensUsed: 0,
    };
  }

  if (process.env.TUNING_SELF_REVIEW !== "true") {
    return { passed: true, tokensUsed: 0 };
  }

  const fn = inferFn ?? defaultSelfReviewInfer;
  const prompt = REVIEW_PROMPT.replace("{surface}", mutation.surface)
    .replace("{target}", mutation.target)
    .replace("{hypothesis}", mutation.hypothesis)
    .replace("{original}", truncate(originalValue, 400))
    .replace("{mutated}", truncate(mutation.mutated_value, 400));

  try {
    const { content, tokensUsed } = await fn(prompt);
    const trimmed = content.trim();
    if (/^ACCEPT\b/i.test(trimmed)) {
      return { passed: true, tokensUsed };
    }
    const match = trimmed.match(/^REJECT\s*:\s*(.+)$/i);
    return {
      passed: false,
      reason: match ? match[1].trim() : "self-review rejected",
      tokensUsed,
    };
  } catch (err) {
    // Review failure is non-fatal: don't block the mutation on infra error,
    // just record that review was skipped.
    console.warn(
      `[tuning] self-review inference failed: ${err instanceof Error ? err.message : err}`,
    );
    return { passed: true, tokensUsed: 0 };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

async function defaultSelfReviewInfer(
  prompt: string,
): Promise<{ content: string; tokensUsed: number }> {
  const { infer } = await import("../inference/adapter.js");
  const result = await infer({
    messages: [{ role: "user", content: prompt }],
  });
  return {
    content: result.content ?? "",
    tokensUsed:
      (result.usage?.prompt_tokens ?? 0) +
      (result.usage?.completion_tokens ?? 0),
  };
}
