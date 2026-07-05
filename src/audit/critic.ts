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
 *   - Q2 — on infrastructure failure (LLM API timeout / non-tool-call response),
 *     return `{verdict: 'fail', critique: <error>, error: true}` so submitReport
 *     can fold it into `concerns: [{type: 'audit_failed', detail: <error>}]`
 *     and STILL deliver the draft. Never silently skip.
 *
 * Output contract (2026-05-27 forced-structured rewrite):
 *   We register a one-shot SDK tool `submit_verdict` whose schema IS the
 *   verdict shape (`{verdict: 'pass'|'fail', critique: string}`). The system
 *   prompt instructs the model to call this tool exactly once. Because the
 *   schema is the contract, the model cannot emit free prose, planning
 *   preambles, or markdown — its only legal response is the tool call,
 *   which carries the JSON natively.
 *
 *   This replaces the prior "Return ONLY valid JSON" instruction, which
 *   the post-2026-05-10 Claude Agent SDK Sonnet path consistently violated
 *   by emitting "I need to verify this report against its cited evidence.
 *   Let me query the database to check the key claims." — Sonnet's strong
 *   agentic-task training surfaces a chain-of-thought preamble when asked
 *   to "verify" data. Forcing the response shape via tool_use bypasses the
 *   preamble entirely (see feedback_forced_structured_output_via_mcp_tool).
 *
 *   Defense-in-depth: if the model fails to call the tool (shouldn't happen
 *   given only one tool is available + system prompt mandates it), we fall
 *   back to `parseCriticVerdict()` on any free text in the response.
 */

import { z } from "zod";
import {
  queryClaudeSdk,
  SONNET_MODEL_ID,
  type InlineSdkTool,
} from "../inference/claude-sdk.js";
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { Report, ReportDraft } from "./report-schema.js";
import { errMsg } from "../lib/err-msg.js";

/**
 * Single-source-of-truth name (audit-S1). Used by the system prompt, the
 * tool factory, and error messages — a typo in any one would silently drift.
 */
export const SUBMIT_VERDICT_TOOL_NAME = "submit_verdict";

export const CRITIC_SYSTEM_PROMPT = `You are the audit gate for a report produced by another agent. Your only job is to detect:

1. NUMERIC INTEGRITY: do the numbers in \`claims\` actually appear in the data cited under \`verified_against\`? Re-derive at least the headline number from the citation's row_count + window — if it doesn't match, fail.
2. SAMPLE INTEGRITY: any aggregate (avg, %, rate) with sample_n < 30 must be flagged unless the report's \`concerns\` already names it. Citing "n=5 average" without a concern is a fail.
3. WINDOW INTEGRITY: do the windows in \`verified_against\` overlap the windows of the claims? A claim about "the last 24h" cited against a window_start 3 days ago is a fail.
4. CITATION FRESHNESS: every \`verified_against\` entry must have a queried_at >= report.started_at. Stale = fail.
5. CONCERN COMPLETENESS: post-restart data, mixed-PID windows, single-day extrapolations to monthly — these MUST be in \`concerns\`. Missing = fail.

You have ONE tool available: \`submit_verdict\`. Call it exactly once with your decision.
- \`verdict\`: "pass" if all five integrity checks succeed; "fail" if any fails.
- \`critique\`: empty string if "pass"; one paragraph (max ~3 sentences) naming the specific failing check(s) and what's wrong if "fail".

Do NOT emit any text outside the tool call. Do NOT propose fixes or rewrites. Your output is the tool call, nothing else.`;

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
   * timeout, model didn't call the verdict tool and free text wasn't parsable).
   * The verdict will be "fail" with critique describing the failure.
   * submitReport must fold this into a `concerns` entry of type 'audit_failed'
   * rather than treating it as a content fail.
   */
  error: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Zod shape for the forced submit_verdict tool. Matches CriticVerdictPayload.
 *
 * Audit-W5: `critique` is `.optional().default("")` so a `pass` verdict that
 * omits the critique field doesn't trip Zod's required-field rejection before
 * the handler runs. The handler does NOT need to defensively default on
 * `args.critique` because Zod parses first.
 */
const submitVerdictSchema = {
  verdict: z
    .enum(["pass", "fail"])
    .describe("Final audit verdict: pass if all 5 integrity checks succeed."),
  critique: z
    .string()
    .optional()
    .default("")
    .describe(
      "Empty string if pass; one short paragraph naming the failing check(s) if fail.",
    ),
};

/**
 * Build a one-shot `submit_verdict` SDK tool whose handler captures the args
 * into the provided sink. Used by `runCritic` to force structured output via
 * the Agent SDK's tool-use mechanism (2026-05-27 fix).
 *
 * The handler returns a no-op text ack so the SDK ends the turn cleanly; the
 * actual data flows through the closure, not through the SDK's tool-result
 * channel.
 */
function buildSubmitVerdictTool(sink: {
  captured: { verdict: "pass" | "fail"; critique: string } | null;
}): InlineSdkTool {
  // The SDK's `tool()` factory infers a strict per-call generic from the Zod
  // schema, but `buildMcpServer`/`createSdkMcpServer` accept the
  // `SdkMcpToolDefinition<any>` union. Function-parameter contravariance
  // blocks the direct upcast, so we erase the schema generic at the
  // boundary. Safe at runtime — the SDK passes the model's args through the
  // Zod parser before invoking the handler, so the shape matches the
  // declared schema. (See `InlineSdkTool` docstring in claude-sdk.ts.)
  return sdkTool(
    SUBMIT_VERDICT_TOOL_NAME,
    "Submit your audit verdict. Call exactly once. The schema IS your output — verdict and critique are the only fields you produce.",
    submitVerdictSchema,
    async (args) => {
      // Audit-W2: surface a double-call as an audit failure rather than
      // silently overwriting the first verdict. Should never happen with
      // a model behaving correctly (system prompt says "exactly once"), but
      // a model that emits two tool_use blocks would otherwise have its
      // second call clobber the first without any signal.
      if (sink.captured) {
        throw new Error(
          `${SUBMIT_VERDICT_TOOL_NAME} called more than once in a single critic run`,
        );
      }
      // Zod schema enforces `verdict` ∈ {"pass","fail"} and defaults
      // `critique` to "" if omitted — no runtime defaulting needed here.
      sink.captured = {
        verdict: args.verdict,
        critique: args.critique,
      };
      return {
        content: [{ type: "text" as const, text: "Verdict recorded." }],
      };
    },
  ) as unknown as InlineSdkTool;
}

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

  // Closure-captured sink for the forced tool call.
  const sink: {
    captured: { verdict: "pass" | "fail"; critique: string } | null;
  } = { captured: null };
  const submitVerdict = buildSubmitVerdictTool(sink);

  try {
    const result = await queryClaudeSdk({
      prompt: `Report to audit:\n\n${JSON.stringify(draft, null, 2)}`,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
      toolNames: [],
      extraTools: [submitVerdict],
      // Audit-R3: 2 turns is sufficient — turn 1 is the model's tool_use,
      // turn 2 is the model's closing reply after the SDK's tool_result.
      // A 3rd turn would let the model emit a second tool_use that clobbers
      // the first verdict (covered by the W2 double-call guard, but cleaner
      // to deny the budget for it altogether).
      maxTurns: 2,
      model: SONNET_MODEL_ID,
      abortSignal: ac.signal,
    });

    const latencyMs = Date.now() - t0;
    const costUsd = result.costAuthoritative ? result.costUsd : undefined;

    // Happy path: model called submit_verdict; closure captured the verdict.
    if (sink.captured) {
      return {
        verdict: sink.captured.verdict,
        critique: sink.captured.critique,
        latencyMs,
        costUsd,
        error: false,
      };
    }

    // Audit-C1: no fallback to free-text JSON parsing. The pre-2026-05-27
    // critic relied on `parseCriticVerdict()` over the response text, and
    // that's exactly the path the Sonnet chain-of-thought preamble
    // ("I need to verify this report...") exploited to never produce JSON.
    // If the model fails to call submit_verdict under this contract, that's
    // an audit failure — full stop. Reopening the free-text parser as a
    // fallback re-introduces the exact bug class this refactor was built
    // to close.
    return {
      verdict: "fail",
      critique:
        "critic did not call submit_verdict — likely model output was free text without a tool call",
      latencyMs,
      costUsd,
      error: true,
    };
  } catch (e) {
    // Audit-C2: the abort may fire DURING the tool handler. If the handler
    // already ran (sink.captured set), the verdict is valid even though
    // queryClaudeSdk threw — return success instead of discarding the
    // captured verdict via the catch path. Without this, a timeout that
    // races with a successful tool_use would corrupt the report's audit
    // trail with audit_failed when the verdict is actually known.
    if (sink.captured) {
      const latencyMs = Date.now() - t0;
      return {
        verdict: sink.captured.verdict,
        critique: sink.captured.critique,
        latencyMs,
        error: false,
      };
    }
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

// parseVerdict + extractBalancedObjects live in src/lib/critic-verdict.ts
// (v7.7 Spine 3 Phase 2 — shared with S5's runSkillCritic per spec §8).
// As of the 2026-05-27 audit-C1 fix, S2's critic no longer parses free
// text — the forced submit_verdict tool is the only legal channel for a
// verdict here. S5's runSkillCritic still uses the free-text parser; if
// that path develops the same chain-of-thought failure mode, port the
// forced-tool pattern there too.
