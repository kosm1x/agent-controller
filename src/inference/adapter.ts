/**
 * Inference Adapter — OpenAI-compatible multi-provider LLM client.
 *
 * Adapted from NanoClaw's production inference adapter. Raw fetch() to any
 * OpenAI-compatible /v1/chat/completions endpoint. Zero vendor SDK.
 *
 * Features:
 *   - Primary + fallback provider with automatic failover
 *   - Exponential backoff on 429/5xx
 *   - SSE streaming with delta accumulation
 *   - Truncation detection (unclosed braces)
 *   - Parallel tool execution via Promise.all
 *   - Model-specific guards (Qwen enable_thinking)
 */

import { getConfig } from "../config.js";
import { toolRegistry } from "../tools/registry.js";
import { shouldCompress, compress } from "../prometheus/context-compressor.js";

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
  | string
  | null
  | Array<{ type: string; [key: string]: unknown }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface InferenceRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

export interface InferenceResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  provider: string;
  latency_ms: number;
}

export interface ToolExecutor {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

export type OnTextChunk = (text: string) => void;

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

function loadProviders(): InferenceProvider[] {
  const config = getConfig();
  const providers: InferenceProvider[] = [];

  if (config.inferencePrimaryUrl && config.inferencePrimaryModel) {
    providers.push({
      name: "primary",
      baseUrl: config.inferencePrimaryUrl.replace(/\/+$/, ""),
      apiKey: config.inferencePrimaryKey,
      model: config.inferencePrimaryModel,
      priority: 0,
    });
  }

  if (config.inferenceFallbackUrl && config.inferenceFallbackModel) {
    providers.push({
      name: "fallback",
      baseUrl: config.inferenceFallbackUrl.replace(/\/+$/, ""),
      apiKey: config.inferenceFallbackKey ?? "",
      model: config.inferenceFallbackModel,
      priority: 1,
    });
  }

  if (config.inferenceTertiaryUrl && config.inferenceTertiaryModel) {
    providers.push({
      name: "tertiary",
      baseUrl: config.inferenceTertiaryUrl.replace(/\/+$/, ""),
      apiKey: config.inferenceTertiaryKey ?? "",
      model: config.inferenceTertiaryModel,
      priority: 2,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// HTTP call to a single provider
// ---------------------------------------------------------------------------

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callProvider(
  provider: InferenceProvider,
  request: InferenceRequest,
  onTextChunk?: OnTextChunk,
  externalSignal?: AbortSignal,
): Promise<InferenceResponse> {
  const config = getConfig();
  const url = `${provider.baseUrl}/chat/completions`;
  const start = Date.now();
  const streaming = !!onTextChunk;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: request.messages,
    max_tokens: request.max_tokens ?? config.inferenceMaxTokens,
    stream: streaming,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  // Disable reasoning/thinking mode for faster responses (Qwen 3.5+, GLM-5+)
  if (provider.model.startsWith("qwen3") || provider.model.startsWith("glm-")) {
    body.enable_thinking = false;
  }

  // Dynamic timeout: scale with tool count. Base timeout is insufficient for
  // large prompts with many tools — LLM providers need more time to process
  // 20K+ token tool-augmented prompts. Add 1s per tool definition.
  const toolCount = request.tools?.length ?? 0;
  const effectiveTimeout = config.inferenceTimeoutMs + toolCount * 1000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

  // Compose external abort signal with timeout controller
  const combinedSignal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let result: InferenceResponse;

    if (streaming && response.body) {
      result = await parseSSEStream(
        response.body,
        provider,
        start,
        onTextChunk,
      );
    } else {
      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices?.[0];
      if (!choice) throw new Error("Empty response: no choices returned");
      result = {
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
        usage: data.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        provider: provider.name,
        latency_ms: Date.now() - start,
      };
    }

    console.log(
      `[inference] ${provider.name}/${provider.model} ${result.latency_ms}ms prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} tools=${result.tool_calls?.length ?? 0}`,
    );

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  provider: InferenceProvider,
  startTime: number,
  onTextChunk: OnTextChunk,
): Promise<InferenceResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: Map<number, ToolCall> = new Map();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 2);

        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              content += delta.content;
              onTextChunk(delta.content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCalls.get(idx);
                if (!existing) {
                  toolCalls.set(idx, {
                    id: tc.id ?? "",
                    type: "function",
                    function: {
                      name: tc.function?.name ?? "",
                      arguments: tc.function?.arguments ?? "",
                    },
                  });
                } else {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name)
                    existing.function.name += tc.function.name;
                  if (tc.function?.arguments)
                    existing.function.arguments += tc.function.arguments;
                }
              }
            }

            if (chunk.usage) usage = chunk.usage;
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    content: content || null,
    tool_calls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
    usage,
    provider: provider.name,
    latency_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a single inference request with automatic failover.
 * Tries providers in priority order; retries on 429/5xx with exponential backoff.
 */
export async function infer(
  request: InferenceRequest,
  onTextChunk?: OnTextChunk,
  signal?: AbortSignal,
  providerName?: string, // TODO: refactor infer/inferWithTools to use options object
): Promise<InferenceResponse> {
  const config = getConfig();
  const providers = loadProviders();

  // If providerName specified, try that provider first
  if (providerName) {
    const idx = providers.findIndex((p) => p.name === providerName);
    if (idx > 0) {
      const [preferred] = providers.splice(idx, 1);
      providers.unshift(preferred);
    }
  }
  if (providers.length === 0) {
    throw new Error(
      "No inference providers configured. Set INFERENCE_PRIMARY_URL and INFERENCE_PRIMARY_MODEL.",
    );
  }

  let lastError: Error | undefined;

  for (let pi = 0; pi < providers.length; pi++) {
    const provider = providers[pi];
    for (let attempt = 0; attempt < config.inferenceMaxRetries; attempt++) {
      try {
        const toolCount = request.tools?.length ?? 0;
        const effectiveTimeoutLog =
          config.inferenceTimeoutMs + toolCount * 1000;
        console.log(
          `[inference] Attempting ${provider.name}/${provider.model} (provider ${pi + 1}/${providers.length}, attempt ${attempt + 1}/${config.inferenceMaxRetries}, timeout=${effectiveTimeoutLog}ms, tools=${toolCount})`,
        );
        return await callProvider(provider, request, onTextChunk, signal);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const statusMatch = lastError.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        const isAbort =
          lastError.name === "AbortError" ||
          lastError.message.includes("aborted");
        console.warn(
          `[inference] ${provider.name} attempt ${attempt + 1} failed: ${lastError.message}${isAbort ? " (timeout)" : ""} status=${status}`,
        );
        if (status === 429 || (status >= 500 && status < 600)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(
            `[inference] ${provider.name} backoff ${delay}ms before retry`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break; // non-retryable → skip to next provider
      }
    }
    console.warn(
      `[inference] ${provider.name} exhausted: ${lastError?.message}, trying next provider`,
    );
  }

  console.error(
    `[inference] All ${providers.length} providers failed. Last: ${lastError?.message}`,
  );
  throw new Error(
    `All inference providers failed. Last error: ${lastError?.message}`,
  );
}

/**
 * Run a full multi-turn conversation with tool execution.
 *
 * Loops: send messages → LLM returns tool_calls → execute tools → append results → repeat.
 * Stops when LLM returns a text response with no tool calls, or maxRounds is hit.
 */
/** Max chars per tool result in conversation — prevents prompt bloat from web_read/web_search. */
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Max chars per tool result in wrap-up context — more aggressive to fit in timeout. */
const WRAPUP_TOOL_RESULT_CHARS = 1_500;

/**
 * Build a condensed conversation for wrap-up calls.
 * Keeps system + first user message + last few tool exchanges (truncated) + wrap-up instruction.
 */
function buildWrapUpContext(
  conversation: ChatMessage[],
  instruction: string,
): ChatMessage[] {
  const system = conversation.find((m) => m.role === "system");

  // Find the LAST user message before tool calls started — this is the actual
  // current question. In chat tasks, firstUser may be from thread history and
  // completely unrelated to the current request.
  let lastUserBeforeTools: ChatMessage | undefined;
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (
      conversation[i].role === "user" &&
      typeof conversation[i].content === "string"
    ) {
      lastUserBeforeTools = conversation[i];
      break;
    }
  }
  // Fallback to first user message if no user message found (shouldn't happen)
  if (!lastUserBeforeTools) {
    lastUserBeforeTools = conversation.find((m) => m.role === "user");
  }

  // Take last 6 messages (3 tool exchanges) and aggressively truncate tool results
  const recentMessages = conversation.slice(-6).map((m) => {
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > WRAPUP_TOOL_RESULT_CHARS
    ) {
      return {
        ...m,
        content:
          m.content.slice(0, WRAPUP_TOOL_RESULT_CHARS) +
          "\n...(truncated for wrap-up)",
      };
    }
    return m;
  });

  const condensed: ChatMessage[] = [];
  if (system) condensed.push(system);
  if (lastUserBeforeTools) condensed.push(lastUserBeforeTools);
  condensed.push(...recentMessages);
  condensed.push({ role: "user", content: instruction });
  return condensed;
}

export async function inferWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  maxRounds = 10,
  onTextChunk?: OnTextChunk,
  signal?: AbortSignal,
  providerName?: string, // TODO: refactor to options object
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: { prompt_tokens: number; completion_tokens: number };
}> {
  let conversation = [...messages];
  let totalPrompt = 0;
  let totalCompletion = 0;

  for (let round = 0; round < maxRounds; round++) {
    // Compress context if approaching limit
    const config = getConfig();
    if (
      shouldCompress(
        conversation,
        config.inferenceContextLimit,
        config.compressionThreshold,
      )
    ) {
      console.log(
        `[inference] Context compression triggered at round ${round} (${conversation.length} messages)`,
      );
      conversation = await compress(conversation);
    }

    // Check abort before each round
    if (signal?.aborted) {
      const lastContent = [...conversation]
        .reverse()
        .find((m) => m.role === "assistant" && typeof m.content === "string");
      return {
        content:
          (typeof lastContent?.content === "string"
            ? lastContent.content
            : null) ?? "[aborted]",
        messages: conversation,
        totalUsage: {
          prompt_tokens: totalPrompt,
          completion_tokens: totalCompletion,
        },
      };
    }

    let response: InferenceResponse;
    try {
      response = await infer(
        { messages: conversation, tools },
        onTextChunk,
        signal,
        providerName,
      );
    } catch (err) {
      // Mid-loop inference failure — attempt toolless wrap-up instead of crashing
      console.log(
        `[inference] Round ${round + 1}/${maxRounds} failed, attempting wrap-up: ${err instanceof Error ? err.message : err}`,
      );
      try {
        const leanContext = buildWrapUpContext(
          conversation,
          "The system encountered an error continuing tool execution. Based on the information gathered so far, provide your final response now. Do not request any more tools. End with: STATUS: DONE_WITH_CONCERNS — [brief note on what went wrong]",
        );
        const wrapUp = await infer(
          { messages: leanContext },
          onTextChunk,
          signal,
        );
        totalPrompt += wrapUp.usage.prompt_tokens;
        totalCompletion += wrapUp.usage.completion_tokens;
        const content = wrapUp.content ?? "[inference failed mid-loop]";
        conversation.push({ role: "assistant", content });
        return {
          content,
          messages: conversation,
          totalUsage: {
            prompt_tokens: totalPrompt,
            completion_tokens: totalCompletion,
          },
        };
      } catch {
        // Wrap-up also failed — propagate original error
        throw err;
      }
    }
    totalPrompt += response.usage.prompt_tokens;
    totalCompletion += response.usage.completion_tokens;

    // No tool calls — final text response
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const content = response.content ?? "";
      conversation.push({ role: "assistant", content });
      return {
        content,
        messages: conversation,
        totalUsage: {
          prompt_tokens: totalPrompt,
          completion_tokens: totalCompletion,
        },
      };
    }

    // Append assistant message with tool calls
    conversation.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    // Execute tool calls in parallel
    const toolResults = await Promise.all(
      response.tool_calls.map(async (toolCall) => {
        let result: string;
        try {
          const rawArgs = toolCall.function.arguments;
          // Detect truncation: unclosed braces/brackets
          const opens = (rawArgs.match(/[{[]/g) || []).length;
          const closes = (rawArgs.match(/[}\]]/g) || []).length;
          if (opens > closes) {
            result = JSON.stringify({
              error:
                "Tool call truncated (max_tokens hit). Try a simpler query.",
            });
            console.warn(
              `[inference] Tool ${toolCall.function.name} args truncated (${rawArgs.length} chars)`,
            );
          } else {
            const args = JSON.parse(rawArgs) as Record<string, unknown>;
            // Attempt tool call repair if name not in registry
            let toolName = toolCall.function.name;
            if (!toolRegistry.has(toolName)) {
              const closest = toolRegistry.findClosest(toolName);
              if (closest) {
                console.log(
                  `[inference] Tool call repaired: "${toolName}" → "${closest}"`,
                );
                toolName = closest;
              }
            }
            result = await executor(toolName, args);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = JSON.stringify({ error: message });
          console.error(
            `[inference] Tool ${toolCall.function.name} failed: ${message}`,
          );
        }
        // Large result eviction: write oversized results to temp file,
        // return head + tail preview with file path reference so the LLM
        // can read specific sections with file_read if needed.
        if (result.length > MAX_TOOL_RESULT_CHARS) {
          const previewHead = result.slice(
            0,
            Math.floor(MAX_TOOL_RESULT_CHARS * 0.7),
          );
          const previewTail = result.slice(
            -Math.floor(MAX_TOOL_RESULT_CHARS * 0.2),
          );
          result = `${previewHead}\n\n... (${result.length} chars total — middle section omitted) ...\n\n${previewTail}`;
        }
        return {
          role: "tool" as const,
          content: result,
          tool_call_id: toolCall.id,
        };
      }),
    );
    conversation.push(...toolResults);
  }

  // Hit max rounds — force one final toolless call to synthesize results
  console.log(
    `[inference] Max rounds (${maxRounds}) reached, forcing wrap-up call`,
  );
  try {
    const leanContext = buildWrapUpContext(
      conversation,
      "You have used all available tool rounds. Based on the information gathered so far, provide your final comprehensive response now. Do not request any more tools. End with: STATUS: DONE_WITH_CONCERNS — [brief note on what was incomplete]",
    );
    const wrapUp = await infer({ messages: leanContext }, onTextChunk, signal);
    totalPrompt += wrapUp.usage.prompt_tokens;
    totalCompletion += wrapUp.usage.completion_tokens;
    const content = wrapUp.content ?? "[max tool rounds reached]";
    conversation.push({ role: "assistant", content });
    return {
      content,
      messages: conversation,
      totalUsage: {
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
      },
    };
  } catch {
    // Wrap-up call failed — fall back to last assistant content
    const lastAssistant = [...conversation]
      .reverse()
      .find((m) => m.role === "assistant");
    return {
      content:
        (typeof lastAssistant?.content === "string"
          ? lastAssistant.content
          : null) ?? "[max tool rounds reached]",
      messages: conversation,
      totalUsage: {
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
      },
    };
  }
}
