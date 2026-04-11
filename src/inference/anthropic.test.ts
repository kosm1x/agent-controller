/**
 * Tests for Anthropic API format conversion.
 */

import { describe, it, expect } from "vitest";
import {
  isAnthropicProvider,
  convertMessages,
  convertTools,
  buildAnthropicRequest,
  convertResponse,
} from "./anthropic.js";
import type {
  ChatMessage,
  ToolDefinition,
  InferenceProvider,
} from "./adapter.js";

const provider: InferenceProvider = {
  name: "primary",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-test",
  model: "claude-sonnet-4-20250514",
  priority: 0,
};

describe("isAnthropicProvider", () => {
  it("returns true for claude models", () => {
    expect(isAnthropicProvider(provider)).toBe(true);
    expect(
      isAnthropicProvider({ ...provider, model: "claude-opus-4-20250514" }),
    ).toBe(true);
  });

  it("returns false for non-claude models", () => {
    expect(isAnthropicProvider({ ...provider, model: "qwen3.5-plus" })).toBe(
      false,
    );
    expect(isAnthropicProvider({ ...provider, model: "kimi-k2.5" })).toBe(
      false,
    );
  });
});

describe("convertMessages", () => {
  it("extracts system messages into separate field", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are Jarvis." },
      { role: "user", content: "Hello" },
    ];
    const { system, messages: out } = convertMessages(messages);
    expect(system).toBe("You are Jarvis.");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("concatenates multiple system messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Part 1" },
      { role: "system", content: "Part 2" },
      { role: "user", content: "Go" },
    ];
    const { system } = convertMessages(messages);
    expect(system).toBe("Part 1\n\nPart 2");
  });

  it("converts assistant tool_calls to tool_use content blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Search for cats" },
      {
        role: "assistant",
        content: "Let me search.",
        tool_calls: [
          {
            id: "tc_1",
            type: "function" as const,
            function: { name: "web_search", arguments: '{"q":"cats"}' },
          },
        ],
      },
    ];
    const { messages: out } = convertMessages(messages);
    expect(out[1].role).toBe("assistant");
    const blocks = out[1].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "Let me search." });
    expect(blocks[1]).toEqual({
      type: "tool_use",
      id: "tc_1",
      name: "web_search",
      input: { q: "cats" },
    });
  });

  it("converts tool results to user messages with tool_result blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Search" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc_1",
            type: "function" as const,
            function: { name: "search", arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: "tool", content: "Results here", tool_call_id: "tc_1" },
    ];
    const { messages: out } = convertMessages(messages);
    // tool result should be a user message
    expect(out[2].role).toBe("user");
    const blocks = out[2].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tc_1",
      content: "Results here",
    });
  });

  it("merges consecutive tool results into one user message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Do two things" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc_1",
            type: "function" as const,
            function: { name: "a", arguments: "{}" },
          },
          {
            id: "tc_2",
            type: "function" as const,
            function: { name: "b", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "Result A", tool_call_id: "tc_1" },
      { role: "tool", content: "Result B", tool_call_id: "tc_2" },
    ];
    const { messages: out } = convertMessages(messages);
    // Both tool results should merge into one user message
    expect(out[2].role).toBe("user");
    const blocks = out[2].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc_1",
    });
    expect(blocks[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc_2",
    });
  });

  it("converts image_url content to Anthropic image format", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/4AAQ==" },
          },
        ],
      },
    ];
    const { messages: out } = convertMessages(messages);
    const blocks = out[0].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "What is this?" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ==" },
    });
  });

  it("prepends user message if conversation starts with assistant", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "I'm ready." },
      { role: "user", content: "Go" },
    ];
    const { messages: out } = convertMessages(messages);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("Continue.");
    expect(out[1].role).toBe("assistant");
  });
});

describe("convertTools", () => {
  it("converts OpenAI tool format to Anthropic format", () => {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const result = convertTools(tools);
    expect(result).toEqual([
      {
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
  });
});

describe("buildAnthropicRequest", () => {
  it("builds correct URL, headers, and body", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hi" },
    ];
    const { url, headers, body } = buildAnthropicRequest(
      provider,
      messages,
      undefined,
      4096,
    );
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const parsed = JSON.parse(body);
    expect(parsed.model).toBe("claude-sonnet-4-20250514");
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.system).toBe("Be helpful");
    expect(parsed.stream).toBe(false);
    expect(parsed.messages).toHaveLength(1);
  });

  it("includes tools when provided", () => {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "test",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const { body } = buildAnthropicRequest(
      provider,
      [{ role: "user", content: "Hi" }],
      tools,
      4096,
    );
    const parsed = JSON.parse(body);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("test");
    expect(parsed.tool_choice).toEqual({ type: "auto" });
  });
});

describe("convertResponse", () => {
  it("converts text response to OpenAI format", () => {
    const data = {
      content: [{ type: "text" as const, text: "Hello there!" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    const result = convertResponse(data, provider, Date.now() - 500);
    expect(result.content).toBe("Hello there!");
    expect(result.tool_calls).toBeUndefined();
    expect(result.usage.prompt_tokens).toBe(100);
    expect(result.usage.completion_tokens).toBe(20);
    expect(result.provider).toBe("primary");
  });

  it("converts tool_use response to OpenAI tool_calls format", () => {
    const data = {
      content: [
        { type: "text" as const, text: "Let me check." },
        {
          type: "tool_use" as const,
          id: "toolu_123",
          name: "get_weather",
          input: { city: "CDMX" },
        },
      ],
      usage: { input_tokens: 200, output_tokens: 50 },
    };
    const result = convertResponse(data, provider, Date.now() - 1000);
    expect(result.content).toBe("Let me check.");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]).toEqual({
      id: "toolu_123",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"city":"CDMX"}',
      },
    });
  });

  it("handles multiple tool_use blocks", () => {
    const data = {
      content: [
        {
          type: "tool_use" as const,
          id: "t1",
          name: "search",
          input: { q: "a" },
        },
        {
          type: "tool_use" as const,
          id: "t2",
          name: "read",
          input: { path: "/tmp" },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    };
    const result = convertResponse(data, provider, Date.now());
    expect(result.content).toBeNull();
    expect(result.tool_calls).toHaveLength(2);
  });
});
