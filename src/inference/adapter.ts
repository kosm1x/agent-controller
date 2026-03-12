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
  // Disable reasoning/thinking mode for faster responses (Qwen 3.5+ only)
  if (provider.model.startsWith("qwen3")) {
    body.enable_thinking = false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.inferenceTimeoutMs,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
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
): Promise<InferenceResponse> {
  const providers = loadProviders();
  if (providers.length === 0) {
    throw new Error(
      "No inference providers configured. Set INFERENCE_PRIMARY_URL and INFERENCE_PRIMARY_MODEL.",
    );
  }

  let lastError: Error | undefined;

  for (const provider of providers) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callProvider(provider, request, onTextChunk);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const statusMatch = lastError.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        if (status === 429 || (status >= 500 && status < 600)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(
            `[inference] ${provider.name} attempt ${attempt} HTTP ${status}, backoff ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }
    console.warn(
      `[inference] ${provider.name} failed: ${lastError?.message}, trying next`,
    );
  }

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
export async function inferWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  maxRounds = 10,
  onTextChunk?: OnTextChunk,
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: { prompt_tokens: number; completion_tokens: number };
}> {
  const conversation = [...messages];
  let totalPrompt = 0;
  let totalCompletion = 0;

  for (let round = 0; round < maxRounds; round++) {
    const response = await infer(
      { messages: conversation, tools },
      onTextChunk,
    );
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
            result = await executor(toolCall.function.name, args);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = JSON.stringify({ error: message });
          console.error(
            `[inference] Tool ${toolCall.function.name} failed: ${message}`,
          );
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

  // Hit max rounds
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
