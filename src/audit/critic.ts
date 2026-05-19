/**
 * V8 substrate S2 — critic LLM wrapper.
 *
 * The agent that produces a report cannot grade its own work. `runCritic`
 * issues a SEPARATE inference call against a frozen system prompt; its only
 * job is to detect numeric/sample/window/freshness/concern-completeness bugs
 * in the producer's draft (spec §4).
 *
 * Decisions baked in (spec §9):
 *   - Q1 — same model as producer (cache-friendly heavy-runner SDK path); the
 *     critic_model option exists for future per-surface override.
 *   - Q2 — on infrastructure failure (LLM API timeout / non-JSON response),
 *     return `{verdict: 'fail', critique: <error>, error: true}` so submitReport
 *     can fold it into `concerns: [{type: 'audit_failed', detail: <error>}]`
 *     and STILL deliver the draft. Never silently skip.
 *
 * Output contract: critic returns ONLY `{verdict: 'pass'|'fail', critique: string}`.
 * Anything else (free prose, fixes, rewrites) is treated as a critic-side bug
 * and surfaced via `error: true` so the operator sees the audit failed.
 */

import { infer } from "../inference/adapter.js";
import { parseCriticVerdict } from "../lib/critic-verdict.js";
import type { Report, ReportDraft } from "./report-schema.js";

export const CRITIC_SYSTEM_PROMPT = `You are the audit gate for a report produced by another agent. Your only job is to detect:

1. NUMERIC INTEGRITY: do the numbers in \`claims\` actually appear in the data cited under \`verified_against\`? Re-derive at least the headline number from the citation's row_count + window — if it doesn't match, fail.
2. SAMPLE INTEGRITY: any aggregate (avg, %, rate) with sample_n < 30 must be flagged unless the report's \`concerns\` already names it. Citing "n=5 average" without a concern is a fail.
3. WINDOW INTEGRITY: do the windows in \`verified_against\` overlap the windows of the claims? A claim about "the last 24h" cited against a window_start 3 days ago is a fail.
4. CITATION FRESHNESS: every \`verified_against\` entry must have a queried_at >= report.started_at. Stale = fail.
5. CONCERN COMPLETENESS: post-restart data, mixed-PID windows, single-day extrapolations to monthly — these MUST be in \`concerns\`. Missing = fail.

Return ONLY valid JSON of the form:
{"verdict": "pass" | "fail", "critique": "<one paragraph max if fail; empty string if pass>"}

Do not propose fixes. Do not rewrite the report. Your output is a verdict, nothing else.`;

export interface CriticOptions {
  /** Override the inference provider/model. Default: same as producer (Q1). */
  providerName?: string;
  /** Hard cap on critic latency. Default 30s. Q2: timeout → error verdict. */
  timeoutMs?: number;
  /** AbortSignal from caller (e.g. submitReport's overall budget). */
  signal?: AbortSignal;
}

export interface CriticResult {
  verdict: "pass" | "fail";
  critique: string;
  /** USD cost of this critic call, when the provider reports it. */
  costUsd?: number;
  /** Latency of the critic call in ms. */
  latencyMs: number;
  /**
   * True when the critic call failed at the infrastructure layer (API error,
   * timeout, malformed JSON). The verdict will be "fail" with critique
   * describing the failure. submitReport must fold this into a `concerns`
   * entry of type 'audit_failed' rather than treating it as a content fail.
   */
  error: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run the critic against a draft (or an in-progress Report).
 *
 * The critic sees the report JSON ONLY — not the producer's full context.
 * This bounds cost (~30-40% of producer per spec §4) AND prevents the critic
 * from "agreeing" with bad evidence by re-reading the same source pages.
 */
export async function runCritic(
  draft: ReportDraft | Report,
  options: CriticOptions = {},
): Promise<CriticResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();

  // Pre-check: if the caller's signal is already aborted, do not spend a
  // critic call against an exhausted budget. Return the abort reason verbatim
  // so submitReport folds it into `audit_failed` with the same provenance as
  // a mid-flight abort.
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

  // Caller signal + our own timeout, combined.
  const ac = new AbortController();
  const timeoutHandle = setTimeout(
    () => ac.abort(new Error("critic timeout")),
    timeoutMs,
  );
  const onAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await infer(
      {
        messages: [
          { role: "system", content: CRITIC_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Report to audit:\n\n${JSON.stringify(draft, null, 2)}`,
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

    const parsed = parseCriticVerdict(raw);
    if (!parsed) {
      return {
        verdict: "fail",
        critique: `critic returned non-JSON response: ${raw.slice(0, 200)}`,
        latencyMs,
        costUsd: response.usage?.cost_usd,
        error: true,
      };
    }

    return {
      verdict: parsed.verdict,
      critique: parsed.critique,
      latencyMs,
      costUsd: response.usage?.cost_usd,
      error: false,
    };
  } catch (e) {
    return {
      verdict: "fail",
      critique: `critic call failed: ${e instanceof Error ? e.message : String(e)}`,
      latencyMs: Date.now() - t0,
      error: true,
    };
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

// parseVerdict + extractBalancedObjects extracted to src/lib/critic-verdict.ts
// (v7.7 Spine 3 Phase 2 — shared with S5's runSkillCritic per spec §8).
