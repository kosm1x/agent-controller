/**
 * Claude Agent SDK integration — uses Max Plan + Extra Usage billing.
 *
 * Wraps our toolRegistry as an in-process MCP server and routes inference
 * through the Agent SDK's query() function. Claude Code subprocess handles
 * auth automatically from ~/.claude/.credentials.json.
 *
 * Switchback: set INFERENCE_PRIMARY_PROVIDER=openai to revert to DashScope.
 */

import {
  tool as sdkTool,
  createSdkMcpServer,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as SdkOptions,
  SDKResultSuccess,
  SDKResultError,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import { toolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import type {
  ChatMessage,
  InferenceResponse,
  ToolDefinition,
  ToolExecutor,
  OnTextChunk,
} from "./adapter.js";

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
    | Record<string, Record<string, unknown>>
    | undefined;
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
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// MCP server builder
// ---------------------------------------------------------------------------

export function buildMcpServer(toolNames: string[]) {
  const tools = toolNames
    .map((n) => toolRegistry.get(n))
    .filter((t): t is Tool => t !== undefined)
    .map(wrapTool);

  return createSdkMcpServer({
    name: "jarvis",
    version: "1.0.0",
    tools,
  });
}

// ---------------------------------------------------------------------------
// Query interface
// ---------------------------------------------------------------------------

export interface ClaudeSdkResult {
  text: string;
  /** Bare tool names called during the run (mcp__jarvis__ prefix stripped). */
  toolCalls: string[];
  numTurns: number;
  usage: { promptTokens: number; completionTokens: number };
  costUsd: number;
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
}): Promise<ClaudeSdkResult> {
  const mcpServer = buildMcpServer(opts.toolNames);

  const allowedTools = opts.toolNames.map((n) => `mcp__jarvis__${n}`);

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

  const options: SdkOptions = {
    model: opts.model ?? "claude-sonnet-4-6",
    systemPrompt: opts.systemPrompt,
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
  /** Accumulated text from streaming assistant messages. Used as fallback
   *  when the query aborts (timeout/signal) before a `type: "result"` success
   *  arrives — prevents data loss on long multi-tool runs. */
  let streamingText = "";
  const toolCallNames: string[] = [];
  let numTurns = 0;
  let assistantTurns = 0;
  let usage = { promptTokens: 0, completionTokens: 0 };
  let costUsd = 0;
  let durationMs = 0;

  // When images are present, switch to streaming-input mode so the user
  // message can carry Anthropic-format image blocks alongside the text.
  // Otherwise use the plain string path (cheaper, preserves prompt caching).
  const sdkPrompt: string | AsyncIterable<SDKUserMessage> =
    opts.images && opts.images.length > 0
      ? buildVisionPromptStream(opts.prompt, opts.images)
      : opts.prompt;

  const q = query({ prompt: sdkPrompt, options });

  try {
    for await (const message of q) {
      if (message.type === "assistant") {
        assistantTurns++;
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
      } else if (message.type === "result") {
        if (message.subtype === "success") {
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
          usage = {
            promptTokens: success.usage?.input_tokens ?? 0,
            completionTokens: success.usage?.output_tokens ?? 0,
          };
          costUsd = success.total_cost_usd ?? 0;
          durationMs = success.duration_ms ?? 0;
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
          usage = {
            promptTokens:
              (error as unknown as { usage?: { input_tokens?: number } }).usage
                ?.input_tokens ?? 0,
            completionTokens:
              (error as unknown as { usage?: { output_tokens?: number } }).usage
                ?.output_tokens ?? 0,
          };
          costUsd =
            (error as unknown as { total_cost_usd?: number }).total_cost_usd ??
            0;
          durationMs =
            (error as unknown as { duration_ms?: number }).duration_ms ?? 0;
          if (streamingText) {
            resultText =
              `${marker} Partial response below — turn/budget limit hit before completion.\n\n${streamingText}\n\n` +
              `STATUS: DONE_WITH_CONCERNS — SDK reported ${error.subtype}; content above is partial and the task did not formally complete.`;
          } else {
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
        resultText = streamingText;
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        resultText = `Error: query aborted — ${errMsg}`;
      }
    }
  }

  clearTimeout(timeoutTimer);

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

  console.log(
    `[claude-sdk] Completed: ${numTurns || assistantTurns} turns, ${toolCallNames.length} tool calls, ` +
      `$${costUsd.toFixed(4)}, ${durationMs}ms, ` +
      `tokens=${usage.promptTokens + usage.completionTokens}` +
      (timedOut ? " [TIMED OUT]" : ""),
  );

  return {
    text: resultText,
    toolCalls: toolCallNames,
    numTurns: numTurns || assistantTurns,
    usage,
    costUsd,
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

function flattenMessagesForSdk(messages: ChatMessage[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  let systemPrompt = "";
  const blocks: string[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // Concatenate system messages — planner/reflector/executor never emit
      // more than one, but fast-runner composition can produce several.
      const text = normalizeContent(m.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
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
      const truncated = text.length > 600 ? `${text.slice(0, 600)}...` : text;
      blocks.push(`[previous tool result]\n${truncated}`);
    }
  }

  return {
    systemPrompt: systemPrompt || "You are a helpful assistant.",
    userPrompt: blocks.join("\n\n"),
  };
}

/**
 * openai-path `infer()` compatibility wrapper. Routes a single-turn text
 * inference call through queryClaudeSdk with no tools. Returns the same
 * shape as `InferenceResponse` so existing Prometheus call sites (planner,
 * reflector, selfAssess) can branch on config with one line instead of
 * being rewritten.
 */
export async function queryClaudeSdkAsInfer(
  messages: ChatMessage[],
  options?: { signal?: AbortSignal; maxTurns?: number },
): Promise<InferenceResponse> {
  const { systemPrompt, userPrompt } = flattenMessagesForSdk(messages);
  const start = Date.now();
  const result = await queryClaudeSdk({
    prompt: userPrompt,
    systemPrompt,
    toolNames: [],
    maxTurns: options?.maxTurns ?? 3,
    abortSignal: options?.signal,
  });

  return {
    content: result.text,
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.promptTokens + result.usage.completionTokens,
    },
    provider: "claude-sdk",
    latency_ms: result.durationMs || Date.now() - start,
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
  },
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: { prompt_tokens: number; completion_tokens: number };
  toolRepairs: Array<{ original: string; repaired: string }>;
  exitReason: string;
  roundsCompleted: number;
  contextPressure: number;
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
          tool_calls: result.toolCalls.map((name, i) => ({
            id: `sdk_call_${nonce}_${i}`,
            type: "function" as const,
            function: { name, arguments: "{}" },
          })),
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
    },
    toolRepairs: [],
    exitReason,
    roundsCompleted: result.numTurns,
    contextPressure: 0,
  };
}
