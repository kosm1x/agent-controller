/**
 * v7.7 Spine 3 Phase 2 — S5 critic gate.
 *
 * Mirrors `src/audit/critic.ts` (S2's report critic) in CALL SHAPE — same
 * timeout/abort/JSON-extraction discipline, shared parser at
 * `src/lib/critic-verdict.ts` (spec §8 "build once, use twice"). What
 * differs is the system prompt (per spec §8) and the input draft type
 * (`ParsedSkillFile` instead of S2's `ReportDraft`).
 *
 * The critic GRADES a skill submission. It does NOT author or revise.
 * On failure, the caller decides what to do — operator-only path may
 * force-publish via `skillSave({forceOperatorOverride: true})`.
 *
 * Phase 2 implements 5 of the 6 spec §8 checks. The DUPLICATION check
 * (#6) requires vector-search over existing skill descriptions and is
 * deferred to Phase 3 (when sqlite-vec lands).
 */

import { infer } from "../inference/adapter.js";
import { parseCriticVerdict } from "../lib/critic-verdict.js";
import type { ParsedSkillFile } from "./frontmatter.js";
import { errMsg } from "../lib/err-msg.js";

export const SKILL_CRITIC_SYSTEM_PROMPT = `You are the audit gate for a skill submission. Your job is to detect:

1. INTENT CLARITY: does \`description\` clearly state what the skill does AND when to invoke it? "Helper for X" is a fail. "When the user asks to <X>, do <Y>" is a pass.
2. INPUT/OUTPUT INTEGRITY: do \`inputs\` declarations (parsed from \`inputs_json\`) match what the steps in the body actually consume? Does \`output_type\` match what the steps produce?
3. TOOL DECLARATION: are all tools the body references present in \`tools_used\`? Are any in \`tools_used\` unused in the body?
4. TEST COVERAGE: are there >=2 tests (parsed from \`tests_json\`) — at minimum one happy path and one edge case (empty input, invalid input, or boundary)? Single-test submissions are a fail unless the test itself covers both a positive and an explicit error-case in one fixture.
5. NAMING: does \`name\` reflect the action (verb-led: "send-follow-up", not "follow-up-helper")? Is it lowercase + hyphens with no underscores or uppercase?

(The DUPLICATION check listed in the spec is deferred to Phase 3 once vector retrieval is available — do not flag duplicates yet.)

Return ONLY valid JSON of the form:
{"verdict": "pass" | "fail", "critique": "<one paragraph max if fail; empty string if pass>"}

Do not propose fixes. Do not rewrite the submission. Your output is a verdict, nothing else.`;

export interface SkillCriticOptions {
  /** Override the inference provider/model. Default: same as producer. */
  providerName?: string;
  /** Hard cap on critic latency. Default 30s. */
  timeoutMs?: number;
  /** AbortSignal from caller. */
  signal?: AbortSignal;
}

export interface SkillCriticResult {
  verdict: "pass" | "fail";
  critique: string;
  /** USD cost of this critic call, when the provider reports it. */
  costUsd?: number;
  /** Latency of the critic call in ms. */
  latencyMs: number;
  /**
   * True when the critic call failed at the infrastructure layer (API
   * timeout, malformed JSON, empty response, abort). Caller MUST treat
   * `error=true` distinctly from a content fail — by spec §8, an
   * infrastructure-failed critic does NOT count toward the 3-retry
   * budget (Phase 2 has no retry loop; this signal is for callers that
   * add one).
   */
  error: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_BODY_EXCERPT_CAP = 8_000;
const MAX_BODY_EXCERPT_CAP = 32_000;

function resolveBodyExcerptCap(): number {
  const raw = process.env.MC_CRITIC_BODY_CAP;
  if (raw === undefined || raw === "") return DEFAULT_BODY_EXCERPT_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BODY_EXCERPT_CAP;
  return Math.min(parsed, MAX_BODY_EXCERPT_CAP);
}

/**
 * Run the critic against a parsed skill file. The critic sees the
 * frontmatter JSON + the body markdown — NOT the producer's full task
 * context. Bounds cost (~30% of producer per spec §8) AND prevents the
 * critic from "agreeing" with bad evidence by re-reading sources.
 */
export async function runSkillCritic(
  parsed: ParsedSkillFile,
  options: SkillCriticOptions = {},
): Promise<SkillCriticResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();

  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    const msg =
      reason instanceof Error ? reason.message : String(reason ?? "aborted");
    return {
      verdict: "fail",
      critique: `critic skipped: caller signal already aborted (${msg})`,
      latencyMs: 0,
      error: true,
    };
  }

  const ac = new AbortController();
  const timeoutHandle = setTimeout(
    () => ac.abort(new Error("critic timeout")),
    timeoutMs,
  );
  const onAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const payload = {
      frontmatter: parsed.frontmatter,
      body_excerpt: parsed.body.slice(0, resolveBodyExcerptCap()), // cap body to bound cost; MC_CRITIC_BODY_CAP overrides (max 32000)
    };
    const response = await infer(
      {
        messages: [
          { role: "system", content: SKILL_CRITIC_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Skill submission to audit:\n\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
        temperature: 0,
        max_tokens: 512,
      },
      { providerName: options.providerName, signal: ac.signal },
    );

    const latencyMs = Date.now() - t0;
    const raw = response.content?.trim() ?? "";

    if (!raw) {
      return {
        verdict: "fail",
        critique: "critic returned empty response",
        latencyMs,
        costUsd: response.usage?.cost_usd,
        error: true,
      };
    }

    const parsedVerdict = parseCriticVerdict(raw);
    if (!parsedVerdict) {
      return {
        verdict: "fail",
        critique: `critic returned non-JSON response: ${raw.slice(0, 200)}`,
        latencyMs,
        costUsd: response.usage?.cost_usd,
        error: true,
      };
    }

    return {
      verdict: parsedVerdict.verdict,
      critique: parsedVerdict.critique,
      latencyMs,
      costUsd: response.usage?.cost_usd,
      error: false,
    };
  } catch (e) {
    return {
      verdict: "fail",
      critique: `critic call failed: ${errMsg(e)}`,
      latencyMs: Date.now() - t0,
      error: true,
    };
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
