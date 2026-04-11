/**
 * Anthropic API format conversion — OpenAI ↔ Anthropic Messages API.
 *
 * Raw fetch, zero SDK. Translates between the OpenAI-compatible format used
 * internally and Anthropic's /v1/messages wire format so Claude can serve
 * as a drop-in inference provider alongside DashScope, OpenAI, etc.
 *
 * Conversion responsibilities:
 *   - Messages: system extracted, tool results as user content blocks
 *   - Tools: {type: "function", function: {parameters}} → {input_schema}
 *   - Vision: {type: "image_url", image_url: {url}} → {type: "image", source}
 *   - Response: Anthropic content blocks → OpenAI choices format
 *   - Streaming: Anthropic SSE events → accumulated InferenceResponse
 */

import type {
  ChatMessage,
  ToolDefinition,
  ToolCall,
  InferenceProvider,
  InferenceResponse,
  OnTextChunk,
} from "./adapter.js";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isAnthropicProvider(provider: InferenceProvider): boolean {
  return provider.model.startsWith("claude-");
}

// ---------------------------------------------------------------------------
// Request conversion: OpenAI → Anthropic
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | { type: "image"; source: { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
    };

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function convertMessages(messages: ChatMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  let system = "";
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    // System messages → separate system field
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      system += (system ? "\n\n" : "") + text;
      continue;
    }

    // Assistant with tool_calls → content blocks
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      const blocks: AnthropicContentBlock[] = [];
      if (
        msg.content &&
        typeof msg.content === "string" &&
        msg.content.trim()
      ) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    // Tool results → user message with tool_result blocks
    // Anthropic requires tool results as user messages. Consecutive tool
    // messages must be merged into a single user message.
    if (msg.role === "tool" && msg.tool_call_id) {
      const resultBlock: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      };

      const lastMsg = out[out.length - 1];
      if (
        lastMsg &&
        lastMsg.role === "user" &&
        Array.isArray(lastMsg.content)
      ) {
        // Check if last user message contains tool_result blocks — merge
        const hasToolResult = lastMsg.content.some(
          (b) =>
            typeof b === "object" && "type" in b && b.type === "tool_result",
        );
        if (hasToolResult) {
          (lastMsg.content as AnthropicContentBlock[]).push(resultBlock);
          continue;
        }
      }
      out.push({ role: "user", content: [resultBlock] });
      continue;
    }

    // Regular user/assistant messages
    const role = msg.role === "tool" ? "user" : msg.role;
    if (role !== "user" && role !== "assistant") continue;

    // Convert vision content blocks
    if (Array.isArray(msg.content)) {
      const blocks = convertContentBlocks(msg.content);
      out.push({ role, content: blocks });
    } else {
      out.push({ role, content: msg.content ?? "" });
    }
  }

  // Anthropic requires messages to start with a user message
  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", content: "Continue." });
  }

  // Anthropic requires alternating user/assistant. Merge consecutive same-role.
  return { system, messages: mergeConsecutive(out) };
}

/**
 * Convert OpenAI-style content blocks to Anthropic format.
 * Handles image_url → image conversion (base64 data URLs and plain URLs).
 */
function convertContentBlocks(
  blocks: Array<{ type: string; [key: string]: unknown }>,
): AnthropicContentBlock[] {
  const result: AnthropicContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      result.push({ type: "text", text: String(block.text ?? "") });
    } else if (block.type === "image_url") {
      const imageUrl = (block.image_url as { url: string })?.url ?? "";
      if (imageUrl.startsWith("data:")) {
        // Parse data URL: data:image/jpeg;base64,/9j/4AA...
        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) {
          result.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
      } else {
        result.push({
          type: "image",
          source: { type: "url", url: imageUrl },
        });
      }
    }
  }
  return result;
}

/** Merge consecutive messages with the same role (Anthropic requirement). */
function mergeConsecutive(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Convert both to arrays and concatenate
      const prevBlocks = toBlocks(prev.content);
      const currBlocks = toBlocks(msg.content);
      prev.content = [...prevBlocks, ...currBlocks];
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

function toBlocks(
  content: string | AnthropicContentBlock[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

export function convertTools(tools: ToolDefinition[]): AnthropicToolDef[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

export function buildAnthropicRequest(
  provider: InferenceProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  maxTokens: number,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  const { system, messages: anthropicMsgs } = convertMessages(messages);

  const payload: Record<string, unknown> = {
    model: provider.model,
    max_tokens: maxTokens,
    messages: anthropicMsgs,
    stream: false,
  };

  if (system) payload.system = system;
  if (temperature !== undefined) payload.temperature = temperature;
  if (tools && tools.length > 0) {
    payload.tools = convertTools(tools);
    payload.tool_choice = { type: "auto" };
  }

  return {
    url: `${provider.baseUrl}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  };
}

export function buildAnthropicStreamRequest(
  provider: InferenceProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  maxTokens: number,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  const req = buildAnthropicRequest(
    provider,
    messages,
    tools,
    maxTokens,
    temperature,
  );
  const payload = JSON.parse(req.body);
  payload.stream = true;
  return { ...req, body: JSON.stringify(payload) };
}

// ---------------------------------------------------------------------------
// Response conversion: Anthropic → OpenAI-compatible InferenceResponse
// ---------------------------------------------------------------------------

export interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  usage: { input_tokens: number; output_tokens: number };
}

export function convertResponse(
  data: AnthropicResponse,
  provider: InferenceProvider,
  startTime: number,
): InferenceResponse {
  let content = "";
  const toolCalls: ToolCall[] = [];

  for (const block of data.content ?? []) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    content: content || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens:
        (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
    provider: provider.name,
    latency_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Streaming SSE parser for Anthropic format
// ---------------------------------------------------------------------------

export async function parseAnthropicStream(
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

        // Parse SSE: "event: <type>\ndata: <json>"
        let eventType = "";
        let eventData = "";
        for (const line of event.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) eventData = line.slice(6);
        }

        if (!eventData) continue;
        try {
          const data = JSON.parse(eventData);

          switch (eventType) {
            case "message_start": {
              // Initial usage (input tokens counted here)
              if (data.message?.usage) {
                usage.prompt_tokens = data.message.usage.input_tokens ?? 0;
              }
              break;
            }
            case "content_block_start": {
              const block = data.content_block;
              if (block?.type === "tool_use") {
                toolCalls.set(data.index, {
                  id: block.id ?? "",
                  type: "function",
                  function: { name: block.name ?? "", arguments: "" },
                });
              }
              break;
            }
            case "content_block_delta": {
              const delta = data.delta;
              if (delta?.type === "text_delta" && delta.text) {
                content += delta.text;
                onTextChunk(delta.text);
              } else if (
                delta?.type === "input_json_delta" &&
                delta.partial_json
              ) {
                const tc = toolCalls.get(data.index);
                if (tc) tc.function.arguments += delta.partial_json;
              }
              break;
            }
            case "message_delta": {
              // Final usage (output tokens counted here)
              if (data.usage) {
                usage.completion_tokens = data.usage.output_tokens ?? 0;
                usage.total_tokens =
                  usage.prompt_tokens + usage.completion_tokens;
              }
              break;
            }
            // content_block_stop, message_stop — no action needed
          }
        } catch {
          /* skip malformed chunks */
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
