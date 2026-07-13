/**
 * Inference Adapter — routing entry point + shared types.
 *
 * infer()/inferWithTools() route to one of two paths:
 *   - claude-sdk hot path (INFERENCE_PRIMARY_PROVIDER=claude-sdk, the default
 *     since 2026-05-10): Sonnet primary with Haiku fallback via the Claude
 *     Agent SDK shims in claude-sdk.ts.
 *   - OpenAI-compat providers path (the documented revert path): raw fetch()
 *     to /v1/chat/completions endpoints with failover, backoff, circuit
 *     breaker, and doom-loop guards — moved verbatim to adapter-openai.ts
 *     (efficiency-refactor Phase 4.2) and re-exported here so existing
 *     importers (health route, observability, tests) are unchanged.
 */

import { getConfig } from "../config.js";
import type { CompactionLevel } from "../prometheus/compaction-pipeline.js";
import { inferViaOpenAi, inferWithToolsViaOpenAi } from "./adapter-openai.js";
import { errMsg } from "../lib/err-msg.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferenceProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatContent =
  string | null | Array<{ type: string; [key: string]: unknown }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * Cache-aware routing hint for the claude-sdk path (no effect on the openai
   * HTTP path — qwen/llama have no equivalent cache primitive).
   *
   * Only meaningful on `role: "system"` messages. The Claude Agent SDK accepts
   * `systemPrompt` as a single string and places ONE `cache_control` marker at
   * its end (verified against `@anthropic-ai/claude-agent-sdk` `sdk.d.ts:1472`:
   * `systemPrompt?: string | { type: 'preset', ... }` — no multi-block surface).
   * Any byte-drift in the concatenated systemPrompt invalidates the cached
   * prefix for the entire ~70K block.
   *
   * - undefined or true (default): joined into `systemPrompt`. Cross-call
   *   cacheable iff byte-stable.
   * - false: routed to a prefix on the first user message so byte-drift here
   *   does NOT invalidate the cached system prefix. Use for per-task variable
   *   content (task description, precedent, dynamic facts) that the fast-runner
   *   splits out from the stable essentials/KB/tool catalog.
   *
   * Surfaced 2026-05-22 (cache_diag, commit f219340): the SDK collapses every
   * `role:"system"` message into one cache marker, erasing the fast-runner's
   * careful 6-section stable/variable split. See
   * `feedback_sdk_systemprompt_single_cache_block.md`.
   */
  cacheable?: boolean;
}

export interface InferenceRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  /** Task ID for per-task failure dedup in provider metrics (v6.4 OH1.5). */
  taskId?: string;
  /** Anthropic effort parameter — "low" for synthesis/wrap-up, "high" default. */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Model override for SDK-routed inference. When set, takes precedence over
   * the hardcoded `SONNET_MODEL_ID` default in `inferViaClaudeSdk` /
   * `inferWithToolsViaClaudeSdk`. Used by aux callers (scope-classifier,
   * prompt-enhancer) to opt into Haiku for cost savings when
   * `process.env.AUX_HAIKU_ENABLED === "true"`. **No effect under the
   * openai-path** (each provider sets its own model from per-provider config).
   *
   * Sonnet → Haiku fallback chain still applies on transient failure:
   * if `request.model = HAIKU_MODEL_ID` is set and Haiku itself fails,
   * the retry leg still routes to Haiku (no "secondary fallback to Sonnet"
   * — the caller opted in deliberately). Added 2026-05-23 (queue #228).
   */
  model?: string;
}

export interface InferenceResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * v8 S4 phase 2: Anthropic prompt-cache breakdown. Populated by the
     * claude-sdk shim (`queryClaudeSdkAsInfer`); undefined on the OpenAI
     * HTTP path (qwen/llama have no equivalent cache primitive).
     */
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    /**
     * SDK-reported `total_cost_usd` for this single call. Populated by the
     * claude-sdk shim. Undefined on the OpenAI HTTP path (cost is computed
     * downstream via `calculateCost()`). Prometheus aggregates these across
     * plan/reflect/executor calls so heavy-runner can surface the sum to the
     * dispatcher as `actualCostUsd`.
     */
    cost_usd?: number;
  };
  provider: string;
  latency_ms: number;
  /**
   * Actual model ID the inference layer invoked (e.g. "claude-sonnet-4-6",
   * "claude-haiku-4-5-20251001", "claude-opus-4-7"). 2026-05-10 cutover:
   * cost_ledger attribution must read this when present, otherwise SDK-mode
   * Opus/Haiku traffic gets mislabeled as Sonnet by getModelFromTask().
   * Populated by the claude-sdk shim from the SDK's terminal `model` field;
   * undefined on the OpenAI path where the model is the request's model id.
   */
  model?: string;
}

export interface ToolExecutor {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

export type OnTextChunk = (text: string) => void;

// ---------------------------------------------------------------------------
// OpenAI-compat provider machinery — moved to adapter-openai.ts (Phase 4.2).
// Re-exported for backward compatibility (health route, observability, and
// adapter.test.ts import these from adapter.ts).
// ---------------------------------------------------------------------------

export { providerMetrics } from "./adapter-openai.js";
export type { ProviderHealth, ProviderStats } from "./adapter-openai.js";
export {
  stripStaleSignals,
  stripThinkBlocks,
  tryRepairJson,
  salvageTruncatedContent,
  truncateMessageForWrapup,
  compactionGuardStep,
} from "./adapter-openai.js";

// Loop guard functions extracted to guards.ts for testability.
// Re-export for backward compatibility (tests import from adapter.ts).
export {
  allToolCallsReadOnly,
  allResultsAreErrors,
  isReadOnlyTool,
} from "./guards.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Claude Agent SDK path with Sonnet→Haiku fallback.
 *
 * Used when INFERENCE_PRIMARY_PROVIDER=claude-sdk to route all infer() callers
 * through the SDK instead of the OpenAI-compat providers list. Sonnet is the
 * default; on transient failure (circuit OPEN, surrogates, timeout, etc.) we
 * retry once with Haiku. If both fail, the error bubbles to the caller.
 *
 * Per-model circuit breaker keys ('claude-sdk', 'claude-sdk-haiku') prevent
 * Sonnet failures from poisoning the Haiku fallback.
 *
 * MODEL SELECTION:
 *   - `request.model` IS honored as of 2026-05-23 (queue #228 plumbing).
 *     Callers can opt into Haiku for cost savings (~5-8× cheaper than Sonnet
 *     on aux lines). When `request.model` is undefined the default stays
 *     `SONNET_MODEL_ID` — every caller in the codebase that doesn't
 *     explicitly opt in continues to use Sonnet. Currently only
 *     scope-classifier.ts and prompt-enhancer.ts pass `model: HAIKU_MODEL_ID`,
 *     and only when `process.env.AUX_HAIKU_ENABLED === "true"` (default off).
 *     The flag is operator-flipped after manual validation — there is no
 *     automated shadow-A/B harness in the codebase today; the comparison is
 *     done by reading scope-classifier output (Set<string> of group names)
 *     and prompt-enhancer output (CIRICD JSON / PASS) under both models on
 *     the same inputs. Related: `feedback_prometheus_upstream` #8
 *     [[aux-model-routing-audit]]; a shadow harness is queued for future work.
 *   - Pre-2026-05-23 the function hardcoded SONNET_MODEL_ID for every caller.
 *     That was the OPPOSITE of the Hermes-warned "silent cheap default" — we
 *     erred toward main-model quality. The plumbing lets us downshift
 *     selectively without changing the default.
 *   - Fallback chain semantics (preserved): the retry leg uses HAIKU_MODEL_ID
 *     by default. If the caller set `request.model = HAIKU_MODEL_ID` and the
 *     Sonnet leg is skipped, both attempts run on Haiku (no escalation to
 *     Sonnet — the caller opted in deliberately and a circuit-breaker open
 *     on Sonnet shouldn't pull a Haiku caller into a forbidden upgrade).
 *   - Under the legacy `INFERENCE_PRIMARY_PROVIDER=openai` path (dormant
 *     since 2026-05-10 cutover), execution falls through to `loadProviders()`
 *     and each provider sets `model` from its own config — `request.model`
 *     has NO effect there.
 *   - Vision is independent — see `inference/vision.ts` (explicit env).
 */
async function inferViaClaudeSdk(
  request: InferenceRequest,
  options: InferOptions | undefined,
): Promise<InferenceResponse> {
  const { queryClaudeSdkAsInfer, SONNET_MODEL_ID, HAIKU_MODEL_ID } =
    await import("./claude-sdk.js");
  const primaryModel = request.model ?? SONNET_MODEL_ID;
  try {
    return await queryClaudeSdkAsInfer(request.messages, {
      signal: options?.signal,
      model: primaryModel,
      // Selection-probe passthrough (2026-07-10): request.tools was silently
      // DROPPED on this path since the 05-10 cutover, so infer()-with-tools
      // callers (the tuning eval runner) got a model that never saw the
      // tools and a response with no tool_calls. The SDK shim registers
      // these as no-op stubs and returns first-turn tool_use as tool_calls.
      tools: request.tools,
      // Effort passthrough (V8.5 Phase 2.3): request.effort was honored only
      // on the openai path since 05-10 — the SDK path dropped it.
      effort: request.effort,
    });
  } catch (err) {
    console.warn(
      `[inference] claude-sdk ${primaryModel} failed (${errMsg(err)}), retrying with Haiku`,
    );
    return await queryClaudeSdkAsInfer(request.messages, {
      signal: options?.signal,
      // Retry leg uses Haiku regardless of primary — Haiku is the cheaper
      // last-line provider. If primaryModel WAS already Haiku we're just
      // retrying it (provider-level transient).
      model: HAIKU_MODEL_ID,
      tools: request.tools,
      // effort deliberately NOT forwarded: Haiku 4.5 has no effort support;
      // the last-line fallback carries the minimal request.
    });
  }
}

/**
 * Tool-calling counterpart to inferViaClaudeSdk. Same Sonnet→Haiku fallback
 * pattern via queryClaudeSdkAsInferWithTools. Returns the synthetic message
 * shape that downstream consumers expect.
 *
 * Options not forwarded under SDK mode (audit W6): `taskId` is irrelevant —
 * provider metrics aren't recorded for SDK calls. `skipToolNudge` and
 * `exemptAnalysisParalysis` are openai-path doom-loop guards; the SDK has
 * its own internal turn-bound + abort handling that subsumes them. These
 * options are accepted but no-ops on this code path by design.
 */
async function inferWithToolsViaClaudeSdk(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  options: InferWithToolsOptions | undefined,
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  toolRepairs: Array<{ original: string; repaired: string }>;
  exitReason: string;
  roundsCompleted: number;
  contextPressure: number;
  compactionApplied?: { level: CompactionLevel; removedCount: number };
  /** SDK-reported model — populated under claude-sdk routing for cost_ledger. */
  model?: string;
}> {
  const { queryClaudeSdkAsInferWithTools, SONNET_MODEL_ID, HAIKU_MODEL_ID } =
    await import("./claude-sdk.js");
  const passthrough = {
    maxRounds: options?.maxRounds,
    signal: options?.signal,
    onTextChunk: options?.onTextChunk,
    // tokenBudget deliberately rides BOTH legs (ratified, audit I3
    // 2026-07-13): unlike `effort` below, a task budget is task-scoped
    // pacing, not a model capability — the Haiku recovery leg still runs
    // the same task under the same budget, and the SDK carries the beta
    // header itself.
    tokenBudget: options?.tokenBudget,
    compressionContext: options?.compressionContext,
    providerName: options?.providerName,
  };
  // Effort rides outside `passthrough`: the Haiku retry leg must not carry
  // it (Haiku 4.5 has no effort support — minimal request on the fallback).
  const effort = options?.effort;
  // Honor `options.model` (added 2026-05-23, queue #228); no override → Sonnet.
  // No production caller opts in yet; field is here for symmetry with infer().
  const primaryModel = options?.model ?? SONNET_MODEL_ID;
  try {
    return await queryClaudeSdkAsInferWithTools(messages, tools, executor, {
      ...passthrough,
      model: primaryModel,
      effort,
    });
  } catch (err) {
    console.warn(
      `[inference] claude-sdk ${primaryModel} (with tools) failed (${errMsg(err)}), retrying with Haiku`,
    );
    return await queryClaudeSdkAsInferWithTools(messages, tools, executor, {
      ...passthrough,
      model: HAIKU_MODEL_ID,
    });
  }
}

/**
 * Send a single inference request with automatic failover.
 * Tries providers in priority order; retries on 429/5xx with exponential backoff.
 */
export interface InferOptions {
  onTextChunk?: OnTextChunk;
  signal?: AbortSignal;
  providerName?: string;
}

export async function infer(
  request: InferenceRequest,
  options?: InferOptions,
): Promise<InferenceResponse> {
  const config = getConfig();

  // 2026-05-10: when claude-sdk is primary, route ALL infer() callers through
  // the SDK with Sonnet→Haiku fallback. Prevents the silent Fireworks/Groq
  // leak that occurred when callers (tool builtins, tuning loops, etc.) used
  // infer() directly: providers list still contained OpenAI-compat entries
  // even after operator nulled the env vars at file level. Reaches every
  // caller, including those unaware of the SDK branch (fast-runner has its
  // own SDK path; this covers the rest).
  if (config.inferencePrimaryProvider === "claude-sdk") {
    return inferViaClaudeSdk(request, options);
  }

  return inferViaOpenAi(request, options);
}

/**
 * Run a full multi-turn conversation with tool execution.
 *
 * Loops: send messages → LLM returns tool_calls → execute tools → append results → repeat.
 * Stops when LLM returns a text response with no tool calls, or maxRounds is hit.
 */

export interface InferWithToolsOptions {
  maxRounds?: number;
  onTextChunk?: OnTextChunk;
  signal?: AbortSignal;
  providerName?: string;
  /**
   * Reasoning-effort knob (V8.5 Phase 2.3), honored on the claude-sdk path
   * only. Fast-runner maps the classifier's modelTier here (flash→low,
   * standard→medium, capable→high); unset = SDK default ("high"). The
   * openai path ignores it (per-provider request shaping lives in
   * adapter-openai.ts).
   */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Per-round prompt token ceiling. If any single round's prompt_tokens
   * exceeds this, the loop wraps up before the next round. This prevents
   * individual requests from hitting the DashScope ~30K token ceiling.
   *
   * Note: this checks the LAST round's prompt_tokens, not the cumulative
   * total, because prompt_tokens includes the full conversation each time
   * (system prompt + history are repeated every round).
   */
  tokenBudget?: number;
  /**
   * Context injected into compression summaries when context compression fires.
   * Use to preserve critical state (e.g. active goal description) across compressions.
   * Keeps the compressor generic — callers define what matters.
   */
  compressionContext?: string;
  /**
   * Optional posture for the L2 LLM summarization step. Biases the summary
   * toward preserving content relevant to the topic (e.g. `"file paths,
   * diffs, error messages"` for a coding task; `"cvegeo/scian codes,
   * lat/lon"` for a DENUE research task). Additive — never drops prior
   * facts in the PRESERVE+ADD path. Clamped to 200 chars in `compress()`.
   *
   * **Path divergence (openai-path only).** Honored only on
   * `inferWithToolsViaOpenAi`, which runs OUR L0-L3 compaction cascade.
   * The Claude Agent SDK path delegates context management to the SDK
   * itself — `compress()` never fires there — so this field is a no-op
   * under `INFERENCE_PRIMARY_PROVIDER=claude-sdk` (the current default
   * since 2026-05-10). Documented divergence, not a silent drop: passing
   * it under the SDK provider is harmless but ineffective.
   *
   * Tier-A cherry-pick from Hermes April Tier-2 #1 §7 — see
   * `docs/planning/pluggable-context-engine-design.md` §7.
   */
  compressionFocusTopic?: string;
  /**
   * If true, exempt this task from the analysis_paralysis guard.
   * Research-then-send workflows (scheduled reports) legitimately do many
   * read-only rounds (web_search) before calling gmail_send. (v6.4 ST1)
   */
  exemptAnalysisParalysis?: boolean;
  /**
   * Task ID for per-task failure dedup in provider metrics.
   * Prevents a single failing task from flooding the degradation window.
   * (v6.4 OH1.5)
   */
  taskId?: string;
  /**
   * Model override for SDK-routed inference. Same semantics as
   * `InferenceRequest.model` (added 2026-05-23, queue #228) — `undefined`
   * keeps the existing Sonnet default, otherwise the override takes
   * precedence. No effect on the openai-path. Currently no tool-calling
   * caller opts in; the field is here for symmetry with `infer()` so a
   * future Haiku-grade tool-calling aux flow can downshift.
   */
  model?: string;
  /**
   * If true, skip the first-round tool-skip nudge. Used for short
   * conversational messages (reactions, thanks) that don't need tool calls.
   */
  skipToolNudge?: boolean;
}

export async function inferWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  options?: InferWithToolsOptions,
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    /**
     * v8 S4 phase 2: cache fields are populated by the claude-sdk shim
     * (`queryClaudeSdkAsInferWithTools`); the OpenAI path leaves these
     * undefined since qwen/llama have no equivalent prompt cache.
     */
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  toolRepairs: Array<{ original: string; repaired: string }>;
  exitReason: string;
  roundsCompleted: number;
  contextPressure: number;
  compactionApplied?: { level: CompactionLevel; removedCount: number };
  /** Surfaced under claude-sdk routing (2026-05-10) so callers can plumb
   * actualModel into runner tokenUsage; undefined on the OpenAI HTTP path. */
  model?: string;
  /** SDK-reported total_cost_usd. Populated by the claude-sdk shim;
   * undefined on the OpenAI HTTP path (dispatcher falls back to
   * calculateCost() in that case). */
  costUsd?: number;
}> {
  // 2026-05-10: claude-sdk primary → route through SDK with Sonnet→Haiku
  // fallback. See inferViaClaudeSdk comment for rationale.
  if (getConfig().inferencePrimaryProvider === "claude-sdk") {
    return inferWithToolsViaClaudeSdk(messages, tools, executor, options);
  }

  return inferWithToolsViaOpenAi(messages, tools, executor, options);
}
