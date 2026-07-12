/**
 * Claude Agent SDK integration — uses Max Plan + Extra Usage billing.
 *
 * Wraps our toolRegistry as an in-process MCP server and routes inference
 * through the Agent SDK's query() function. Claude Code subprocess handles
 * auth automatically from ~/.claude/.credentials.json.
 *
 * Switchback: set INFERENCE_PRIMARY_PROVIDER=openai to revert to DashScope.
 */

import { createHash } from "node:crypto";
import {
  tool as sdkTool,
  createSdkMcpServer,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { sanitizeToolResult } from "./guards.js";
import { circuitRegistry } from "../lib/circuit-breaker.js";
// Shared provider-health singleton (defined in adapter-openai.ts). Imported
// here so the claude-sdk hot path records latency/success/token metrics too —
// since the 2026-05-10 SDK cutover, providerMetrics was written ONLY from the
// dormant OpenAI-compat path, so every mc_provider_* series exported zero
// samples and /health.providers was {}. Import from adapter-openai.js directly
// (not the adapter.js re-export) — adapter-openai does not import claude-sdk,
// so no static cycle; the singleton is used only at call time regardless.
import { providerMetrics } from "./adapter-openai.js";
import type {
  Options as SdkOptions,
  SDKResultSuccess,
  SDKResultError,
  SDKUserMessage,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import { toolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { sanitizeSurrogates, safeSlice } from "../lib/unicode-safe.js";
import type {
  ChatMessage,
  InferenceResponse,
  ToolDefinition,
  ToolExecutor,
  OnTextChunk,
} from "./adapter.js";
import { errMsg } from "../lib/err-msg.js";

// ---------------------------------------------------------------------------
// JSON Schema → Zod raw shape (for SDK tool() definitions)
// ---------------------------------------------------------------------------

function jsonPropToZod(prop: Record<string, unknown>): ZodType {
  const desc = String(prop.description ?? "");

  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]).describe(desc);
  }

  switch (prop.type) {
    case "string":
      return z.string().describe(desc);
    case "number":
    case "integer":
      return z.number().describe(desc);
    case "boolean":
      return z.boolean().describe(desc);
    case "array":
      return z.array(z.unknown()).describe(desc);
    case "object":
      return z.record(z.string(), z.unknown()).describe(desc);
    default:
      return z.unknown();
  }
}

function jsonSchemaToZodShape(
  params: Record<string, unknown>,
): Record<string, ZodType> {
  const properties = params.properties as
    Record<string, Record<string, unknown>> | undefined;
  if (!properties) return {};

  const required = new Set((params.required as string[]) ?? []);
  const shape: Record<string, ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const field = jsonPropToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Tool wrapping: our Tool → SDK MCP tool
// ---------------------------------------------------------------------------

/**
 * Wrap-cache (2026-07-05 efficiency audit): tool definitions are static after
 * registration, yet every query() rebuilt ~30 tools' Zod shapes (~150 zod
 * allocations per message) through wrapTool. Keyed by Tool OBJECT identity
 * (WeakMap), so a source that re-registers a tool under the same name gets a
 * fresh wrap automatically — no invalidation policy to maintain. The handler
 * closes over the registry lookup by name, so execution behavior is identical.
 */
const wrappedToolCache = new WeakMap<Tool, ReturnType<typeof wrapTool>>();

/** @internal exported for the memoization contract test only. */
export function wrapToolCached(t: Tool): ReturnType<typeof wrapTool> {
  let wrapped = wrappedToolCache.get(t);
  if (!wrapped) {
    wrapped = wrapTool(t);
    wrappedToolCache.set(t, wrapped);
  }
  return wrapped;
}

function wrapTool(t: Tool) {
  const params = t.definition.function.parameters as Record<string, unknown>;
  const shape = jsonSchemaToZodShape(params);

  return sdkTool(
    t.name,
    t.definition.function.description,
    shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await toolRegistry.execute(
          t.name,
          args as Record<string, unknown>,
        );
        // Sec10 round-1 fix: parity with OpenAI adapter path (adapter.ts:1679).
        // SDK tool results were reaching Sonnet unsanitized — role markers
        // (`SYSTEM:`, `[INST]`, `<system>`) were not being defanged, so
        // prompt-injection via tool output bypassed guards on claude-sdk path.
        // See docs/audit/2026-04-22-security.md C-INJ-1.
        const sanitized = sanitizeToolResult(t.name, result);
        return { content: [{ type: "text", text: sanitized }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errMsg(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Wrap raw tool definitions as SELECTION-PROBE stubs: the model sees the real
 * name/description/schema, but the handler never executes anything. Used by
 * `queryClaudeSdkAsInfer` when a caller passes `tools` — the eval runner's
 * tool_selection cases need "which tool WOULD you call", never the side
 * effects. Callers pair this with `maxTurns: 1`, so in practice the query
 * ends at the model's first tool_use turn and the stub handler is dead code —
 * it exists so a handler is present if the SDK ever executes within the turn.
 */
function buildProbeTools(defs: ToolDefinition[]): InlineSdkTool[] {
  return defs.map((d) =>
    sdkTool(
      d.function.name,
      d.function.description,
      jsonSchemaToZodShape(d.function.parameters as Record<string, unknown>),
      async (): Promise<CallToolResult> => ({
        content: [{ type: "text", text: "PROBE — tool not executed" }],
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// MCP server builder
// ---------------------------------------------------------------------------

/**
 * Inline SDK tool — already wrapped via the SDK's `tool()` factory, ready to
 * register without going through `toolRegistry`. Used by callers that need a
 * one-shot tool scoped to a single query (e.g. the S2 critic's `submit_verdict`
 * pattern from 2026-05-27 — forced structured-output without polluting the
 * global tool registry).
 *
 * Generic-widened: the SDK's `tool()` factory infers a specific Zod-shape
 * generic per call, but `buildMcpServer` accepts the union via
 * `SdkMcpToolDefinition<any>` (matching the SDK's own `createSdkMcpServer`
 * signature). Callers stay strongly-typed at the `sdkTool(...)` call site;
 * we only erase the schema generic at the registry boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InlineSdkTool = SdkMcpToolDefinition<any>;

export function buildMcpServer(
  toolNames: string[],
  extraTools: InlineSdkTool[] = [],
) {
  // Audit-R2: guard against inline tools whose name collides with a
  // registry tool BEING REGISTERED IN THIS SERVER. The SDK's
  // `createSdkMcpServer` accepts duplicate names with undefined merge
  // behavior (last-wins, first-wins, or runtime error depending on SDK
  // version). Surface the collision loudly here so a caller that re-uses a
  // name from `toolNames` gets a clear error instead of a silent override
  // of (e.g.) `shell_exec`. Scoped to this server's contents (2026-07-10):
  // the original registry-wide check also rejected probe stubs that
  // deliberately mirror registry tool names while NO registry tool is
  // registered — a case with no duplicate and no override.
  for (const t of extraTools) {
    if (toolNames.includes(t.name)) {
      throw new Error(
        `inline tool name '${t.name}' collides with a registry tool in this server — pick a distinct name`,
      );
    }
  }

  const registryTools = toolNames
    .map((n) => toolRegistry.get(n))
    .filter((t): t is Tool => t !== undefined)
    .map(wrapToolCached);

  return createSdkMcpServer({
    name: "jarvis",
    version: "1.0.0",
    tools: [...registryTools, ...extraTools],
    // NOTE for the next SDK 0.3.x attempt (V8.5 Phase 1, FAILED 2026-07-12 —
    // see PROJECT-STATUS): on 0.3.x add `alwaysLoad: true` here. It pins
    // turn-1 tool availability (0.3.x connects MCP servers non-blocking and
    // may defer tools behind SDK tool search). Verified working on 0.3.207
    // via scripts/validate-sdk-tool-visibility.ts — the gate FAIL was NOT
    // tool visibility; root cause unresolved (bisect plan in PROJECT-STATUS).
    // The option does not exist on 0.2.x and fails tsc.
  });
}

// ---------------------------------------------------------------------------
// Query interface
// ---------------------------------------------------------------------------

/**
 * Canonical model IDs for cost_ledger attribution.
 *
 * The Claude Agent SDK auths via ~/.claude/.credentials.json. The config's
 * INFERENCE_PRIMARY_MODEL env var is unused under provider='claude-sdk' (often
 * stale qwen-era string), so every call site that needs to record a model name
 * for SDK-routed calls must use these constants instead of
 * cfg.inferencePrimaryModel. The constant below is also what queryClaudeSdk
 * passes as the SDK `model` option, so it IS the primary engine, not just a
 * label.
 *
 * 2026-05-10: HAIKU_MODEL_ID and OPUS_MODEL_ID added for the operator-directed
 * cutover off Fireworks/Groq. Haiku replaces the OpenAI-compat fallback chain;
 * Opus is reserved for Prometheus complex paths (planner/executor/reflector).
 * 2026-06-30: SONNET_MODEL_ID bumped claude-sonnet-4-6 → claude-sonnet-5.
 * 2026-07-01: REVERTED to claude-sonnet-4-6. Sonnet 5's new tokenizer counts
 * ~30% more tokens for the same text, which in production shifted the cached
 * prompt-prefix boundaries (cache-read hit ~62%→49%, 0%-cache calls ~15%→27%
 * on the first live day) and pushed fast-runner tasks into heavier SDK
 * compaction — slower, pricier, plus one empty-completion delivery miss on a
 * daily report that had shipped fine for a week. Re-attempt only with
 * cache/context tuning that accounts for the +30% footprint. The bound on THIS
 * path is the SDK compaction budget below + maxTurns; INFERENCE_MAX_TOKENS /
 * INFERENCE_CONTEXT_LIMIT govern only the dormant OpenAI-compat revert path
 * (adapter.ts), so there is no 6144 output-cap truncation risk on this engine.
 */
export const SONNET_MODEL_ID = "claude-sonnet-4-6";
export const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
export const OPUS_MODEL_ID = "claude-opus-4-7";

/**
 * Opus→Sonnet fallback wrapper for Prometheus complex paths.
 *
 * Heavy/swarm tasks call planner/executor/reflector with Opus, but Opus access
 * is plan-gated and can return 403 when the auth token's plan doesn't cover
 * it. Without a fallback the entire heavy task fails. This wrapper retries
 * with Sonnet on any Opus failure (5xx, circuit OPEN, plan denial), trading
 * the Opus quality bump for availability.
 *
 * Generic over the call shape so both queryClaudeSdkAsInfer (returns
 * InferenceResponse) and queryClaudeSdkAsInferWithTools (returns custom
 * shape) can share the wrapper without type erasure.
 *
 * Round-2 audit W8: aborts skip the Sonnet retry. A user-cancelled task
 * should not silently consume a second SDK subprocess + initial token
 * submission on the retry. Detected via Error.name === "AbortError" or
 * the SDK's own "aborted" error message substring.
 */
export async function queryClaudeSdkComplexWithFallback<T>(
  call: (model: string) => Promise<T>,
): Promise<T> {
  try {
    return await call(OPUS_MODEL_ID);
  } catch (err) {
    // 2026-05-13 R3-3: this abort branch is defensive belt-and-suspenders.
    // `queryClaudeSdk` catches AbortError internally (see claude-sdk.ts catch
    // block ~line 543) and returns a degraded `ClaudeSdkResult` whose `text`
    // is the partial streamed content or an "Error: query aborted — …"
    // marker, so the typical production path never throws aborts up to here.
    // The guard exists for (a) integration tests that throw synthetic aborts
    // and (b) any future direct caller that bypasses the internal catch. Do
    // not simplify it out without first confirming abort handling in every
    // call shape.
    const errorName =
      err instanceof Error
        ? err.name
        : ((err as { name?: string })?.name ?? "");
    const errorMsg = errMsg(err);
    if (errorName === "AbortError" || /aborted/i.test(errorMsg)) {
      throw err;
    }
    console.warn(
      `[claude-sdk] Opus failed (${errorMsg}), retrying with Sonnet`,
    );
    return await call(SONNET_MODEL_ID);
  }
}

/**
 * Complexity-tiered variant of {@link queryClaudeSdkComplexWithFallback}.
 *
 * Prometheus (planner/executor/reflector) historically hardcoded the
 * Opus-first complex path for EVERY step of EVERY task — so a trivial coding
 * chat ("clamp a percentage") ran the same Opus loop as a deep architecture
 * task, at ~5× the cost. This lets the orchestrator pick the model by assessed
 * task complexity:
 *
 * - `useOpus === true`  → Opus-first with the Sonnet-on-error fallback (the old
 *   behavior, unchanged). The safe default — anything not *confidently* simple
 *   stays here, so nothing silently regresses.
 * - `useOpus === false` → Sonnet directly (no Opus attempt). Used only for
 *   tasks the orchestrator assessed as confidently simple.
 *
 * The fallback semantics differ deliberately: the Opus path degrades to Sonnet
 * on error, but the Sonnet path does NOT escalate to Opus — a simple task that
 * errors on Sonnet is a genuine failure for the reflect/replan loop to handle,
 * not a reason to silently pay Opus prices.
 */
export async function queryClaudeSdkTiered<T>(
  useOpus: boolean,
  call: (model: string) => Promise<T>,
): Promise<T> {
  if (useOpus) {
    return queryClaudeSdkComplexWithFallback(call);
  }
  return call(SONNET_MODEL_ID);
}

export interface ClaudeSdkResult {
  text: string;
  /** Bare tool names called during the run (mcp__jarvis__ prefix stripped). */
  toolCalls: string[];
  /** Same calls as `toolCalls` but with the SDK's `input` payload preserved.
   * Optional / additive — old consumers still read `toolCalls`. Added 2026-05-26
   * so the Prometheus selfAssess judge can verify criteria that reference tool
   * arguments (e.g. "memory_store called with bank='operational'"); previously
   * the synthesized assistant turn shipped `arguments: "{}"` for every call. */
  toolCallsWithArgs?: Array<{ name: string; input: unknown }>;
  numTurns: number;
  /**
   * Token usage from the SDK's terminal `result` message.
   *
   * `promptTokens` is the SUM of `input_tokens` + `cache_creation_input_tokens`
   * + `cache_read_input_tokens` (per Anthropic Messages API spec: "Total input
   * tokens in a request is the summation of" those three). Recording only the
   * raw `input_tokens` field under-counts by the cache-hit portion — which is
   * 90%+ of the prompt when SDK prompt caching is active.
   *
   * `cacheReadTokens` and `cacheCreationTokens` are surfaced separately so
   * cache hit ratio can be derived: cacheReadTokens / promptTokens.
   */
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  /** Actual model ID reported by the SDK (e.g. "claude-sonnet-4-6"). */
  model: string;
  costUsd: number;
  /**
   * True iff `costUsd` came from an SDK terminal `result` message (success
   * or error subtype). False on the abort/timeout catch path where no
   * result message fires and `costUsd` stays at its initial 0 — the dispatcher
   * must NOT treat that 0 as authoritative (it would override calculateCost()
   * via the costUsdOverride spread, writing a phantom-$0 row to cost_ledger).
   *
   * A legitimate $0 under Max-plan auth still has costAuthoritative=true.
   * Surfaced 2026-05-23 (5 phantom-$0 rows over 14d on fast Sonnet); see
   * feedback_sdk_phantom_zero_cost_2026_05_23.md.
   */
  costAuthoritative: boolean;
  durationMs: number;
}

/** Vision input: base64 image payload already split from the data URL. */
export interface ClaudeSdkImage {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

/**
 * Build a single-message streaming input for the SDK's `query({ prompt })`.
 * The message content is a mixed text+image block array in Anthropic format.
 * Yielded as an async iterable because the SDK treats non-string prompts as
 * a stream of user messages — one yield is enough for a one-shot query.
 */
async function* buildVisionPromptStream(
  text: string,
  images: ClaudeSdkImage[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType,
            data: img.data,
          },
        })),
      ],
    },
  };
}

export async function queryClaudeSdk(opts: {
  prompt: string;
  systemPrompt: string;
  toolNames: string[];
  maxTurns?: number;
  model?: string;
  abortSignal?: AbortSignal;
  /** Optional vision payloads. When present, the SDK receives a streaming
   *  user message whose content is [text, image, image, ...] so the model
   *  actually sees the pixels. Without this, callers that stuff images into
   *  `prompt` will silently lose them — the SDK takes only a string there. */
  images?: ClaudeSdkImage[];
  /**
   * Inline SDK tools registered alongside `toolNames`-resolved registry
   * tools. Each must already be wrapped via `sdkTool(...)`. Their names are
   * auto-added to `allowedTools` (no need to spell them in `toolNames`).
   * Use case: one-shot forced-structured-output tools that should NOT
   * pollute the global toolRegistry — e.g. `submit_verdict` in the S2
   * critic (2026-05-27 `fail_returned_anyway` fix).
   */
  extraTools?: InlineSdkTool[];
}): Promise<ClaudeSdkResult> {
  // Dim-4 R2 fix: claude-sdk path was unguarded since the 2026-04-22 Sonnet
  // primary flip. The shared circuitRegistry (adapter.ts:770) only protected
  // the openai path, so N consecutive Sonnet 500s each burned the full
  // SDK_TIMEOUT_MS before failing over.
  //
  // 2026-05-10 cutover audit C2: with Sonnet→Haiku and Opus→Sonnet fallback
  // chains active, a SHARED breaker key would collapse those fallbacks —
  // when Sonnet trips OPEN the immediate Haiku/Opus retry would be rejected
  // on the same OPEN breaker, defeating the point of the fallback in the
  // exact outage window it was designed for. Bucket per model so each model
  // family has independent failure-tracking. Default ('claude-sdk') stays
  // for callers that don't pass a model — preserves the historical breaker
  // identity that the Dim-4 R2 fix introduced.
  //
  // Round-2 audit W9: prefix-match by model FAMILY rather than exact-equality
  // against the constant. Model IDs version (HAIKU_MODEL_ID has bumped from
  // claude-haiku-3-5-* to claude-haiku-4-5-20251001) and exact-equality would
  // silently collapse a future-bumped Haiku ID to the default 'claude-sdk'
  // bucket — the precise drift this audit was added to prevent.
  let breakerKey = "claude-sdk";
  if (opts.model?.startsWith("claude-haiku-")) breakerKey = "claude-sdk-haiku";
  else if (opts.model?.startsWith("claude-opus-"))
    breakerKey = "claude-sdk-opus";
  const breaker = circuitRegistry.get(breakerKey);
  if (!breaker.allowRequest()) {
    throw new Error(
      `[${breakerKey}] Circuit breaker OPEN — refusing call until cooldown elapses`,
    );
  }

  const extraTools = opts.extraTools ?? [];
  const mcpServer = buildMcpServer(opts.toolNames, extraTools);

  const allowedTools = [
    ...opts.toolNames.map((n) => `mcp__jarvis__${n}`),
    ...extraTools.map((t) => `mcp__jarvis__${t.name}`),
  ];

  const abortController = new AbortController();
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  // Hard timeout: kill the subprocess if it hangs. SDK has no built-in timeout
  // for the full query — maxTurns only caps turns, not wall-clock time.
  // 15 minutes covers multi-document synthesis tasks (read 5+ files → summarize
  // → write to Google Doc). Was 10 min but real integration tasks hit that
  // ceiling when iterating through large research corpora.
  const SDK_TIMEOUT_MS = 15 * 60_000;
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    console.warn(
      `[claude-sdk] Query timed out after ${SDK_TIMEOUT_MS / 1000}s — aborting`,
    );
    timedOut = true;
    abortController.abort();
  }, SDK_TIMEOUT_MS);

  // Sanitize lone UTF-16 surrogates before sending to the API. The Claude
  // server rejects JSON containing unpaired surrogates with a 400 error
  // ("no low surrogate in string"). This catches any upstream slice/substring
  // truncation that cut a non-BMP char (emoji, etc.) mid-pair. One-pass, zero
  // copy for clean strings — only allocates when repair is needed.
  const safePromptText = sanitizeSurrogates(opts.prompt);
  const safeSystemPromptText = sanitizeSurrogates(opts.systemPrompt);

  // cache_diag (2026-05-22): diagnostic for grouping consecutive query() calls
  // by scope to attribute cache misses (same/different promptHash × toolsHash —
  // see git history for the decision table). The investigation concluded with
  // the 2026-06 Sonnet-5 revert; hashing ~34K chars twice per message is pure
  // overhead now, so it's opt-in behind DEBUG_CACHE_DIAG for future regressions.
  if (process.env.DEBUG_CACHE_DIAG === "true") {
    const promptHash = createHash("sha256")
      .update(safeSystemPromptText)
      .digest("hex")
      .slice(0, 12);
    const toolsHash = createHash("sha256")
      .update([...opts.toolNames].sort().join(","))
      .digest("hex")
      .slice(0, 8);
    console.log(
      `[claude-sdk] cache_diag systemPromptHash=${promptHash} toolsHash=${toolsHash} toolsN=${opts.toolNames.length} chars=${safeSystemPromptText.length} model=${opts.model ?? "default"}`,
    );
  }

  const options: SdkOptions = {
    model: opts.model ?? SONNET_MODEL_ID,
    systemPrompt: safeSystemPromptText,
    mcpServers: { jarvis: mcpServer },
    allowedTools,
    tools: [], // Disable all Claude Code built-in tools
    // dontAsk + allowedTools: auto-approve listed tools, deny unlisted.
    // bypassPermissions crashes with MCP servers (exit code 1).
    permissionMode: "dontAsk",
    maxTurns: opts.maxTurns ?? 20,
    abortController,
    persistSession: false, // Ephemeral — Jarvis manages its own sessions
    cwd: process.cwd(),
    thinking: { type: "disabled" },
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "mission-control/1.0.0",
      // v7.7.3: compact earlier than the 200k model ceiling to preserve
      // context fidelity before the window fills. Adopted from NanoClaw
      // v1.2.50 (2026-04-12) after they observed that compacting at the
      // ceiling collapses too much history into summary. 165k leaves a
      // 35k budget for the post-compact suffix instead of the ~10-15k
      // you get at 200k. Operator override wins (env var respected).
      // Range: SDK enforces 100k-1M bounds; auto-clamped to model default.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW:
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "165000",
    },
  };

  let resultText = "";
  /**
   * Tri-state tracking for circuit-breaker classification.
   * 'success' = SDK returned a usable result (including partial-with-content).
   * 'failure' = SDK failed with zero content produced (timeout, dead provider,
   *             auth error, empty error subtype).
   * null = not yet decided; set to 'failure' at end if no success signal fired.
   */
  let providerOutcome: "success" | "failure" | null = null;
  /** Accumulated text from streaming assistant messages. Used as fallback
   *  when the query aborts (timeout/signal) before a `type: "result"` success
   *  arrives — prevents data loss on long multi-tool runs. */
  let streamingText = "";
  const toolCallNames: string[] = [];
  // Parallel array to toolCallNames with the SDK's `input` payload preserved.
  // Populated alongside the name push so indices line up. Surfaced via
  // `toolCallsWithArgs` for downstream consumers (Prometheus selfAssess).
  const toolCallsWithArgs: Array<{ name: string; input: unknown }> = [];
  let numTurns = 0;
  let assistantTurns = 0;
  /** Structural refusal signal (assistant stop_reason — see comment below). */
  let sawRefusal = false;
  let refusalCategory: string | null = null;
  /** Catch-path crash with zero content — outranks the refusal override. */
  let crashedWithoutContent = false;
  let usage = {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let costUsd = 0;
  // True once a terminal `result` message (success or error subtype) fires.
  // The catch block at line ~580 (abort/timeout) leaves this false so the
  // adapter knows costUsd=0 there is a "no-data" sentinel, not Max-plan $0.
  let costAuthoritative = false;
  let durationMs = 0;
  let actualModel: string = SONNET_MODEL_ID;

  // When images are present, switch to streaming-input mode so the user
  // message can carry Anthropic-format image blocks alongside the text.
  // Otherwise use the plain string path (cheaper, preserves prompt caching).
  const sdkPrompt: string | AsyncIterable<SDKUserMessage> =
    opts.images && opts.images.length > 0
      ? buildVisionPromptStream(safePromptText, opts.images)
      : safePromptText;

  // Wall-clock fallback for providerMetrics latency. The SDK-reported
  // `durationMs` is authoritative on terminal-result paths but stays 0 on the
  // abort/timeout catch path (no `result` message fires) — mirror the infer
  // shim's `durationMs || Date.now() - start` pattern so a timed-out call still
  // records its real elapsed time instead of a phantom 0ms latency sample.
  const queryStart = Date.now();
  const q = query({ prompt: sdkPrompt, options });

  try {
    for await (const message of q) {
      if (message.type === "assistant") {
        assistantTurns++;
        // SDK 0.3.162: safety refusals surface structurally as
        // stop_reason "refusal" (+ stop_details.category) instead of only as
        // error text. Track it so a refused query produces a deterministic
        // explanation below rather than empty text or a breaker failure —
        // never-silent-reply floor at the SDK seam.
        const stopMeta = message.message as {
          stop_reason?: string;
          stop_details?: { category?: string | null };
        };
        if (stopMeta?.stop_reason === "refusal") {
          sawRefusal = true;
          refusalCategory = stopMeta.stop_details?.category ?? null;
        }
        // Accumulate per-turn usage so abort/timeout paths capture partial
        // spend instead of writing $0/0-tokens to cost_ledger. The `result`
        // message at end carries the SDK's authoritative cumulative total
        // and REPLACES this value (success branch at line ~498, error branch
        // at line ~538) — this accumulator is only the fallback for queries
        // that never reach a result message (catch block at ~569).
        //
        // Each Anthropic Message's `usage` block is per-call (per-turn),
        // not cumulative; summing across turns matches `result.usage`.
        // Surfaced 2026-05-23 from 5 phantom-$0 rows over 14d on fast Sonnet
        // (all aborts/timeouts) — see feedback memory same date.
        const turnUsage = (
          message.message as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          }
        )?.usage;
        if (turnUsage) {
          const turnInput = turnUsage.input_tokens ?? 0;
          const turnCacheCreation = turnUsage.cache_creation_input_tokens ?? 0;
          const turnCacheRead = turnUsage.cache_read_input_tokens ?? 0;
          usage.promptTokens += turnInput + turnCacheCreation + turnCacheRead;
          usage.completionTokens += turnUsage.output_tokens ?? 0;
          usage.cacheReadTokens += turnCacheRead;
          usage.cacheCreationTokens += turnCacheCreation;
        }
        // Capture streaming assistant text and tool names. MCP tools arrive
        // with the `mcp__jarvis__` prefix — strip so downstream code sees
        // bare names that match the registry.
        if (message.message?.content) {
          for (const block of message.message.content) {
            if (typeof block !== "object" || !("type" in block)) continue;
            if (
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string"
            ) {
              streamingText += block.text;
            } else if (
              block.type === "tool_use" &&
              "name" in block &&
              typeof block.name === "string"
            ) {
              const bareName = block.name.replace(/^mcp__jarvis__/, "");
              toolCallNames.push(bareName);
              // SDK tool_use blocks carry `input` as the args object. Capture
              // it so downstream consumers (selfAssess) can verify criteria
              // referencing call args, not just call names.
              const input = "input" in block ? block.input : undefined;
              toolCallsWithArgs.push({ name: bareName, input });
            }
          }
        }
        // Progress log every 3 assistant turns so long-running queries are
        // observable (previously silent 10-min runs were impossible to diagnose).
        if (assistantTurns % 3 === 0) {
          console.log(
            `[claude-sdk] progress: ${assistantTurns} turns, ${toolCallNames.length} tool calls, ${streamingText.length} chars`,
          );
        }
      } else if (
        message.type === "system" &&
        (message as { subtype?: string }).subtype === "model_refusal_fallback"
      ) {
        // SDK-side one-shot retry of a refused turn on a fallback model —
        // log it so a quality dip on a task is attributable to the swap.
        console.log(
          `[claude-sdk] model_refusal_fallback: refused turn retried on fallback model`,
        );
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          providerOutcome = "success";
          const success = message as SDKResultSuccess;
          // success.result captures only the FINAL assistant turn's text.
          // When the final turn is tool-use-heavy (or a minimal closer), any
          // body text produced in earlier turns lives only in streamingText.
          // Prefer the longer of the two so multi-turn poems/answers are not
          // silently dropped when the model ends on a tool call.
          // v7.7.2 audit nit: coerce `success.result ?? ""` so `resultText`
          // never transiently holds `undefined` (the declared type is
          // `string`). Both sides of the ternary are now guaranteed strings.
          const resolvedResult = success.result ?? "";
          resultText =
            streamingText.length > resolvedResult.length
              ? streamingText
              : resolvedResult;
          numTurns = success.num_turns;
          // Anthropic Messages API: "Total input tokens in a request is the
          // summation of `input_tokens`, `cache_creation_input_tokens`, and
          // `cache_read_input_tokens`." Recording only `input_tokens` misses
          // the cache-hit bulk (often 90%+ with SDK prompt caching active),
          // which made cost_ledger.prompt_tokens show ~8 avg on Sonnet path
          // vs. a true prompt size in the tens of thousands.
          const inputTokens = success.usage?.input_tokens ?? 0;
          const cacheCreation = success.usage?.cache_creation_input_tokens ?? 0;
          const cacheRead = success.usage?.cache_read_input_tokens ?? 0;
          usage = {
            promptTokens: inputTokens + cacheCreation + cacheRead,
            completionTokens: success.usage?.output_tokens ?? 0,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
          };
          costUsd = success.total_cost_usd ?? 0;
          costAuthoritative = true;
          durationMs = success.duration_ms ?? 0;
          // modelUsage keys are the exact model IDs the SDK invoked. First
          // key is the primary model; keep as a readable attribution string.
          const modelKeys = Object.keys(success.modelUsage ?? {});
          if (modelKeys.length > 0) {
            actualModel = modelKeys[0];
          }
        } else {
          // SDK reported a non-success terminal result (error_max_turns,
          // error_max_budget_usd, error_max_structured_output_retries,
          // error_during_execution). The accumulated streamingText often
          // contains real work — preserve it and emit an explicit STATUS
          // line so the fast-runner parser classifies deterministically
          // instead of defaulting to DONE on a raw error string.
          const error = message as SDKResultError;
          const errorMsgs = error.errors?.join("; ") ?? "unknown";
          const marker = `[${error.subtype} — ${errorMsgs}]`;
          numTurns =
            (error as unknown as { num_turns?: number }).num_turns ??
            assistantTurns;
          const errUsage = (
            error as unknown as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
            }
          ).usage;
          const errInput = errUsage?.input_tokens ?? 0;
          const errCacheCreation = errUsage?.cache_creation_input_tokens ?? 0;
          const errCacheRead = errUsage?.cache_read_input_tokens ?? 0;
          usage = {
            promptTokens: errInput + errCacheCreation + errCacheRead,
            completionTokens: errUsage?.output_tokens ?? 0,
            cacheReadTokens: errCacheRead,
            cacheCreationTokens: errCacheCreation,
          };
          costUsd =
            (error as unknown as { total_cost_usd?: number }).total_cost_usd ??
            0;
          // Error subtype reached terminal `result`; cost+usage are SDK-reported
          // (may legitimately be 0 under Max-plan auth). Marks the override
          // path active for the dispatcher.
          costAuthoritative = true;
          durationMs =
            (error as unknown as { duration_ms?: number }).duration_ms ?? 0;
          if (
            streamingText ||
            (opts.maxTurns === 1 && toolCallNames.length > 0)
          ) {
            // Partial content counts as a working provider — the turn/budget
            // limit is an SDK-internal guard, not a provider outage. Avoids
            // tripping the breaker on legitimate long-running queries that
            // ran out of maxTurns while the model was still responsive.
            // Single-turn tool_use counts the same as text (2026-07-10): a
            // selection probe (maxTurns=1, see queryClaudeSdkAsInfer) whose
            // model went STRAIGHT to a tool call — the correct behavior —
            // ends here with zero prose; without this clause every good
            // probe recorded a breaker failure and the eval run tripped the
            // claude-sdk breaker open mid-flight. Deliberately scoped to
            // maxTurns===1 (qa-audit W1): a MULTI-turn run that looped tool
            // calls to the ceiling with zero prose is a wedge and must keep
            // its BLOCKED text + breaker-failure classification.
            providerOutcome = "success";
            resultText =
              `${marker} Partial response below — turn/budget limit hit before completion.\n\n${streamingText}\n\n` +
              `STATUS: DONE_WITH_CONCERNS — SDK reported ${error.subtype}; content above is partial and the task did not formally complete.`;
          } else {
            // Zero streamed text + non-success terminal = provider-side
            // failure (auth, quota, or outage masquerading as error_during_execution).
            providerOutcome = "failure";
            resultText =
              `${marker} No content produced before the limit was hit.\n\n` +
              `STATUS: BLOCKED — SDK reported ${error.subtype} with zero streamed output.`;
          }
        }
      }
    }
  } catch (err) {
    // Abort/timeout paths throw here. Capture the partial streamed text as
    // the result so whatever Jarvis produced before the abort isn't lost.
    // The fast-runner's safety net promotes BLOCKED/NEEDS_CONTEXT with >100
    // chars to DONE_WITH_CONCERNS so the partial delivery reaches the user.
    if (!resultText) {
      if (streamingText) {
        // Partial content pre-abort = provider was working until we killed it.
        providerOutcome ??= "success";
        resultText = streamingText;
      } else {
        providerOutcome = "failure";
        crashedWithoutContent = true;
        resultText = `Error: query aborted — ${errMsg(err)}`;
      }
    }
  }

  clearTimeout(timeoutTimer);

  // Timeout with zero content is always a failure signal regardless of
  // what the for-await loop classified it as — the provider couldn't
  // answer within 15 minutes.
  if (timedOut && !streamingText) {
    providerOutcome = "failure";
  }

  // A refused turn is a WORKING provider making a safety decision, not an
  // outage — it must not trip the circuit breaker (which would cascade
  // healthy traffic onto the Haiku leg), and it must never reach the caller
  // as empty text or a generic zero-output error. Live-capable on 0.2.x too:
  // `stop_reason: "refusal"` is a typed BetaStopReason on the bundled
  // Anthropic API ("streaming classifiers intervene"), formalized on the
  // agent-SDK surface in 0.3.162 (qa-audit 2026-07-12: not merely dormant).
  // When the refusal produced no real prose, replace whatever marker the
  // error branch set with a deterministic explanation (never-silent floor at
  // the SDK seam). Runs BEFORE the breaker record below so the
  // classification wins. Two failure signals keep precedence (qa-audit W2):
  // a hard timeout, and a catch-path crash with zero content — a refusal
  // turn followed by a subprocess death in the same query is still an outage.
  if (sawRefusal && !timedOut && !crashedWithoutContent) {
    // Substitute the deterministic text only when the query produced no real
    // answer (pre-override outcome was failure with nothing streamed) — a
    // populated success result must never be clobbered (qa-audit Info-2).
    const hadRealAnswer =
      (providerOutcome === "success" && resultText.trim().length > 0) ||
      streamingText.trim().length > 0;
    providerOutcome = "success";
    if (!hadRealAnswer) {
      const cat = refusalCategory ? ` (category: ${refusalCategory})` : "";
      resultText =
        `[refusal] The model declined to complete this request${cat}.\n\n` +
        `STATUS: BLOCKED — safety refusal from the model; rephrasing or narrowing the request may help.`;
    }
  }

  // Dim-4 round-2 M-RES-4 fix: default null → failure. The prior inversion
  // treated "no terminal signal ever emitted" (SDK subprocess died mid-stream,
  // abort without streamingText, etc.) as success, under-reporting outages to
  // the breaker. An explicit success signal is the only thing that counts as
  // success — everything else conservatively trips the failure counter.
  if (providerOutcome === "success") {
    breaker.recordSuccess();
  } else {
    breaker.recordFailure();
  }

  // Provider-health metric on BOTH success and failure paths, under the SAME
  // label the circuit breaker buckets on (`claude-sdk` / `claude-sdk-haiku` /
  // `claude-sdk-opus` — see `breakerKey` above) so the Prometheus provider
  // series and /health.providers finally reflect SDK traffic (latency
  // degradation, error storms, Sonnet→Haiku fallback rate). `success` mirrors
  // the breaker's outcome classification exactly. Mirrors the LatencyEntry
  // shape recorded on the OpenAI-compat path (adapter-openai.ts:433/565).
  providerMetrics.record(
    breakerKey,
    {
      timestamp: Date.now(),
      latencyMs: durationMs || Date.now() - queryStart,
      success: providerOutcome === "success",
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    },
    actualModel,
  );

  // If the loop ended without a "result" success message but streaming text
  // exists (e.g. abort signaled externally), fall back to streamed text.
  if (!resultText && streamingText) {
    resultText = streamingText;
  }

  // If we timed out, annotate the partial response so the LLM/user know
  // delivery was interrupted.
  if (timedOut && resultText && !resultText.startsWith("[timeout]")) {
    resultText = `[timeout after ${SDK_TIMEOUT_MS / 1000}s — partial response below]\n\n${resultText}\n\nSTATUS: DONE_WITH_CONCERNS — query hit the ${SDK_TIMEOUT_MS / 1000}s hard timeout, response is incomplete`;
  }

  const cacheHitRatio =
    usage.promptTokens > 0 ? usage.cacheReadTokens / usage.promptTokens : 0;
  console.log(
    `[claude-sdk] Completed: ${numTurns || assistantTurns} turns, ${toolCallNames.length} tool calls, ` +
      `$${costUsd.toFixed(4)}, ${durationMs}ms, ` +
      `tokens=${usage.promptTokens + usage.completionTokens} ` +
      `(cache ${(cacheHitRatio * 100).toFixed(0)}%: ${usage.cacheReadTokens} read, ${usage.cacheCreationTokens} created)` +
      (timedOut ? " [TIMED OUT]" : ""),
  );

  return {
    text: resultText,
    toolCalls: toolCallNames,
    toolCallsWithArgs,
    numTurns: numTurns || assistantTurns,
    usage,
    model: actualModel,
    costUsd,
    costAuthoritative,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Adapters for openai-path callers (Prometheus planner/reflector/executor)
//
// 2026-04-14 (v7.9 Prometheus Sonnet port): the fast-runner was migrated to
// claude-sdk in 70f8cc5, but every other infer()/inferWithTools() caller kept
// hitting the openai adapter → qwen3.5-plus. Prometheus (heavy-runner) is the
// place where reasoning and tool-calling quality matter most, and it was
// silently running on the worse model. These two adapters let callers that
// were built against the openai-path contract route through the SDK instead
// with a narrow branch at each callsite, without rewriting the whole adapter.
//
// Intentional lossiness:
//   - Temperature is not forwarded (Anthropic SDK does not expose it).
//     Sonnet at default temperature is more deterministic than qwen at 0.1
//     for the JSON-structured outputs Prometheus asks for.
//   - Tool repairs come back empty (SDK handles repairs internally).
//   - Synthesized messages[] on return is lossy compared to a full conversation
//     log — it reconstructs a single assistant turn with all tool calls
//     collapsed into one tool_calls array. Downstream provenance extraction
//     (executor.ts:extractProvenance) degrades to empty on the SDK path;
//     that is non-critical metadata, tasks still complete correctly.
//
// ---------------------------------------------------------------------------

/**
 * Flatten a ChatMessage[] into the system prompt + single user prompt form
 * that queryClaudeSdk expects. Assistant and tool messages become labeled
 * blocks in the user prompt so multi-turn context (e.g. executor retry with
 * reflection) is preserved as readable history even though the SDK receives
 * it as a single turn. The system message stays separate because the SDK
 * has a dedicated field for it.
 *
 * v7.9 audit C1 follow-up: handles all three ChatContent shapes — string,
 * null, and Array<{type,text,...}> — so that non-string content (vision
 * blocks, normalized assistant arrays) is not silently erased. Unknown
 * block types become `[non-text block omitted]` placeholders so the shape
 * is preserved even when we can't render the payload.
 */
function normalizeContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        } else if (b.type) {
          parts.push(`[non-text block omitted: ${String(b.type)}]`);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Flattens a ChatMessage[] history into the (systemPrompt, userPrompt) shape
 * the Claude Agent SDK accepts. Used by `queryClaudeSdkAsInfer` (openai-path
 * planner/reflector callers); the fast-runner direct path inlines the same
 * logic at fast-runner.ts:1108-1126 because it also needs to extract image
 * payloads in the same pass.
 *
 * **Precondition (cacheable:false ordering)**: when `cacheable: false` is set
 * on a system message, that text is routed to the START of `userPrompt`
 * (before any user/assistant/tool block in the original array). For inputs
 * where all system messages precede all non-system messages (the fast-runner
 * + Prometheus convention), this preserves the original ordering as
 * `stable_sys, variable_sys, user_blocks...`. For inputs that interleave
 * variable-system content mid-conversation, the relative position is LOST —
 * variable system content always lands at the head of userPrompt regardless
 * of where it sat in the input array. Callers that need mid-conversation
 * variable injection should expose the desired position explicitly (e.g.
 * by emitting the content as a `role: "user"` message instead).
 * Surfaced 2026-05-23 (qa-audit W2). Intentional for the current call sites.
 */
export function flattenMessagesForSdk(messages: ChatMessage[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  let systemPrompt = "";
  // Variable system content goes to a USER-message prefix so byte-drift here
  // doesn't invalidate the cached systemPrompt (the SDK places one
  // cache_control marker at the end of the systemPrompt string — see the
  // ChatMessage.cacheable JSDoc). Collected separately so the order
  // [variableSystem...] + [userBlocks...] is preserved.
  // Surfaced 2026-05-22; fix shipped 2026-05-23.
  const variableSystemBlocks: string[] = [];
  const blocks: string[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // Concatenate system messages — planner/reflector/executor never emit
      // more than one, but fast-runner composition can produce several.
      const text = normalizeContent(m.content);
      if (m.cacheable === false) {
        // Variable per-task content (task description, precedent, dynamic
        // facts). Route to user-message prefix to preserve systemPrompt
        // cacheability.
        if (text) variableSystemBlocks.push(text);
      } else {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      }
    } else if (m.role === "user") {
      blocks.push(normalizeContent(m.content));
    } else if (m.role === "assistant") {
      const text = normalizeContent(m.content);
      if (text) blocks.push(`[previous assistant response]\n${text}`);
      const toolCalls = (
        m as unknown as {
          tool_calls?: Array<{ function: { name: string; arguments: string } }>;
        }
      ).tool_calls;
      if (toolCalls?.length) {
        const calls = toolCalls
          .map((tc) => `  - ${tc.function.name}(${tc.function.arguments})`)
          .join("\n");
        blocks.push(`[previous tool calls]\n${calls}`);
      }
    } else if (m.role === "tool") {
      const text = normalizeContent(m.content);
      // safeSlice avoids stranding a UTF-16 high surrogate when a tool result
      // contains an emoji near the 600-char boundary.
      const truncated = text.length > 600 ? `${safeSlice(text, 600)}...` : text;
      blocks.push(`[previous tool result]\n${truncated}`);
    }
  }

  // Variable system content prepended to user blocks (in order); no cache
  // marker so per-task byte-drift here stays local instead of invalidating
  // the cached systemPrompt prefix.
  const allUserBlocks = [...variableSystemBlocks, ...blocks];

  return {
    systemPrompt: systemPrompt || "You are a helpful assistant.",
    userPrompt: allUserBlocks.join("\n\n"),
  };
}

/**
 * openai-path `infer()` compatibility wrapper. Routes a single-turn text
 * inference call through queryClaudeSdk with no tools. Returns the same
 * shape as `InferenceResponse` so existing Prometheus call sites (planner,
 * reflector, selfAssess) can branch on config with one line instead of
 * being rewritten.
 *
 * TOOL SEMANTICS (2026-07-10): when `options.tools` is non-empty, the call
 * becomes a SELECTION PROBE — the definitions are registered as no-op stubs,
 * `maxTurns` is forced to 1, and the model's first-turn tool_use blocks come
 * back as `tool_calls` (openai shape) WITHOUT any tool executing. This
 * restored the eval runner's tool_selection signal, which had silently
 * measured "no tools ever offered" since the 2026-05-10 cutover (`infer()`
 * dropped `request.tools` on this path — §13-adjacent postmortem in
 * docs/PROJECT-STATUS.md). A caller that wants tools EXECUTED belongs on
 * `queryClaudeSdkAsInferWithTools`, not here.
 */
export async function queryClaudeSdkAsInfer(
  messages: ChatMessage[],
  options?: {
    signal?: AbortSignal;
    maxTurns?: number;
    model?: string;
    tools?: ToolDefinition[];
  },
): Promise<InferenceResponse> {
  const { systemPrompt, userPrompt } = flattenMessagesForSdk(messages);
  const start = Date.now();
  const probing = (options?.tools?.length ?? 0) > 0;
  const result = await queryClaudeSdk({
    prompt: userPrompt,
    systemPrompt,
    toolNames: [],
    extraTools: probing ? buildProbeTools(options!.tools!) : undefined,
    maxTurns: probing ? 1 : (options?.maxTurns ?? 3),
    model: options?.model,
    abortSignal: options?.signal,
  });

  // Map captured tool_use blocks to the openai `tool_calls` shape the
  // infer() contract exposes. Prefer toolCallsWithArgs (has inputs); fall
  // back to bare names if a future path populates only `toolCalls`.
  const probeCalls = !probing
    ? undefined
    : (
        result.toolCallsWithArgs ??
        result.toolCalls.map((name) => ({ name, input: {} }))
      ).map((c, i) => ({
        id: `probe_${i}`,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      }));

  return {
    content: result.text,
    ...(probeCalls && probeCalls.length > 0 && { tool_calls: probeCalls }),
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      // v8 S4 phase 2: emit cache fields only when nonzero so the shim's
      // shape matches the openai path's (which omits these entirely).
      // Downstream consumers that test `!== undefined` then mean "this
      // call had cache info" rather than "this call ran on a cache-aware
      // provider" — the latter is no longer derivable from the value of 0.
      ...(result.usage.cacheReadTokens > 0 && {
        cache_read_tokens: result.usage.cacheReadTokens,
      }),
      ...(result.usage.cacheCreationTokens > 0 && {
        cache_creation_tokens: result.usage.cacheCreationTokens,
      }),
      // Surface SDK-reported total_cost_usd so Prometheus can roll it up.
      // Emit 0 (Max-plan legitimate $0) only when costAuthoritative=true.
      // Abort/timeout paths (catch block) leave costAuthoritative=false and
      // we OMIT cost_usd so the dispatcher's optional-spread skips and
      // recordCost falls back to calculateCost() over the now-non-zero
      // accumulated token usage. Without this distinction, abort paths
      // wrote phantom $0 rows into cost_ledger (5 such rows over 14d on
      // fast Sonnet observed 2026-05-23).
      ...(result.costAuthoritative && { cost_usd: result.costUsd }),
    },
    provider: "claude-sdk",
    latency_ms: result.durationMs || Date.now() - start,
    // 2026-05-10 cutover audit C1: surface SDK-reported model so dispatcher
    // attributes Opus/Haiku traffic correctly in cost_ledger instead of
    // falling through to getModelFromTask() which hardcodes Sonnet.
    model: result.model,
  };
}

/**
 * openai-path `inferWithTools()` compatibility wrapper. Routes a tool-calling
 * inference through queryClaudeSdk. The SDK auto-wraps tools via toolRegistry
 * given their names, so the `tools` parameter is read only to extract names
 * and the `executor` parameter is ignored (SDK calls the registry directly).
 *
 * Returns a synthetic `inferWithTools` result shape: `messages[]` contains
 * one system, one user, and one assistant turn with all tool_calls collapsed.
 * This is lossy vs the real conversation history but sufficient for the
 * executor's downstream consumers — provenance extraction gracefully handles
 * empty input, and tool-call name extraction walks the synthetic assistant
 * turn's `tool_calls` field the same way.
 */
export async function queryClaudeSdkAsInferWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  _executor: ToolExecutor,
  options?: {
    maxRounds?: number;
    signal?: AbortSignal;
    onTextChunk?: OnTextChunk;
    tokenBudget?: number;
    compressionContext?: string;
    providerName?: string;
    model?: string;
  },
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
  /**
   * 2026-05-10 cutover audit C1: SDK-reported model surfaced so the
   * dispatcher's `result.tokenUsage.actualModel` path attributes Opus/Haiku
   * runs correctly in cost_ledger.
   */
  model?: string;
  /**
   * SDK-reported `total_cost_usd` for this single SDK invocation. Aggregated
   * by the executor across self-assess + retry rounds and surfaced through
   * the orchestrator so heavy/swarm runners record real spend instead of $0.
   */
  costUsd?: number;
}> {
  const flat = flattenMessagesForSdk(messages);
  const systemPrompt = flat.systemPrompt;
  // v7.9 audit M1 partial: surface compressionContext on the SDK path by
  // prepending it to the user prompt. The openai-path uses it mid-loop for
  // wrap-up compaction, which we can't replicate without SDK token counters,
  // but at least the signal reaches the model instead of being silently
  // discarded. tokenBudget still has no enforcement on the SDK path — it
  // relies on the SDK's internal 15-minute timeout and maxTurns ceiling.
  const userPrompt = options?.compressionContext
    ? `${options.compressionContext}\n\n---\n\n${flat.userPrompt}`
    : flat.userPrompt;
  const toolNames = tools.map((t) => t.function.name);

  const result = await queryClaudeSdk({
    prompt: userPrompt,
    systemPrompt,
    toolNames,
    maxTurns: options?.maxRounds ?? 20,
    model: options?.model,
    abortSignal: options?.signal,
  });

  // Build a synthetic assistant turn with all tool calls collapsed into one
  // message. Downstream consumers walk messages[].tool_calls to extract names;
  // this preserves that contract even though the real turn structure is lost.
  // IDs include a timestamp nonce to avoid collisions when two runs in the
  // same task are logged together (audit m5).
  const nonce = Date.now().toString(36);
  const syntheticAssistant = {
    role: "assistant" as const,
    content: result.text,
    ...(result.toolCalls.length > 0
      ? {
          // Prefer toolCallsWithArgs (carries the SDK's `input` payload) so
          // downstream consumers reading messages[].tool_calls[].function.arguments
          // see real args, not the legacy "{}" placeholder. Fall back to the
          // name-only list when the structured field isn't present.
          tool_calls: (result.toolCallsWithArgs ?? result.toolCalls).map(
            (entry, i) => {
              const name = typeof entry === "string" ? entry : entry.name;
              const args =
                typeof entry === "string"
                  ? "{}"
                  : (() => {
                      try {
                        return JSON.stringify(entry.input ?? {});
                      } catch {
                        return "{}";
                      }
                    })();
              return {
                id: `sdk_call_${nonce}_${i}`,
                type: "function" as const,
                function: { name, arguments: args },
              };
            },
          ),
        }
      : {}),
  } as ChatMessage;

  const syntheticMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
    syntheticAssistant,
  ];

  // exitReason maps: SDK normal completion → "stop". queryClaudeSdk emits
  // TWO distinct STATUS markers on terminal errors (see the error branch in
  // the main loop): "STATUS: BLOCKED" only when there is zero streamed text,
  // and "STATUS: DONE_WITH_CONCERNS" when streaming text exists. Timeouts
  // prepend "[timeout after ...]". All three are non-stop exit conditions
  // and any future caller that branches on exitReason must see the
  // distinction. Audit C2 follow-up — the old check only hit BLOCKED.
  const exitReason =
    result.text.includes("STATUS: BLOCKED") ||
    result.text.includes("STATUS: DONE_WITH_CONCERNS") ||
    result.text.startsWith("[timeout")
      ? "max_rounds"
      : "stop";

  return {
    content: result.text,
    messages: syntheticMessages,
    totalUsage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      // v8 S4 phase 2: emit only when nonzero (matches openai-path shape).
      ...(result.usage.cacheReadTokens > 0 && {
        cache_read_tokens: result.usage.cacheReadTokens,
      }),
      ...(result.usage.cacheCreationTokens > 0 && {
        cache_creation_tokens: result.usage.cacheCreationTokens,
      }),
    },
    toolRepairs: [],
    exitReason,
    roundsCompleted: result.numTurns,
    contextPressure: 0,
    model: result.model,
    // Same costAuthoritative pattern as the infer() path: omit costUsd on
    // abort/timeout so the dispatcher's optional-spread falls back to
    // calculateCost() over the accumulated tokens instead of writing $0.
    ...(result.costAuthoritative && { costUsd: result.costUsd }),
  };
}
