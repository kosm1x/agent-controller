import { describe, it, expect, vi, beforeEach } from "vitest";

type MockMessage = Record<string, unknown>;

const mockMessages: { value: MockMessage[] } = { value: [] };
const lastQueryArgs: { value: { prompt: unknown; options: unknown } | null } = {
  value: null,
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown) => ({
    name,
    desc,
    shape,
    handler,
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: (args: { prompt: unknown; options: unknown }) => {
    lastQueryArgs.value = args;
    const messages = mockMessages.value;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  },
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    get: () => undefined,
    execute: async () => "",
  },
}));

import { queryClaudeSdk } from "./claude-sdk.js";

beforeEach(() => {
  mockMessages.value = [];
  lastQueryArgs.value = null;
});

describe("queryClaudeSdk error_max_turns handling", () => {
  it("preserves streamed assistant text and emits DONE_WITH_CONCERNS STATUS on error_max_turns", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Partial synthesis result with meaningful content.",
            },
            { type: "tool_use", name: "mcp__jarvis__jarvis_file_read" },
          ],
        },
      },
      {
        type: "result",
        subtype: "error_max_turns",
        errors: ["Reached maximum number of turns (20)"],
        num_turns: 20,
        usage: { input_tokens: 1000, output_tokens: 500 },
        total_cost_usd: 0.05,
        duration_ms: 12345,
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.text).toContain("[error_max_turns");
    expect(result.text).toContain(
      "Partial synthesis result with meaningful content.",
    );
    expect(result.text).toContain("STATUS: DONE_WITH_CONCERNS");
    expect(result.text).not.toMatch(/^Error: error_max_turns/);
    expect(result.toolCalls).toContain("jarvis_file_read");
    expect(result.numTurns).toBe(20);
    expect(result.usage.promptTokens).toBe(1000);
    expect(result.usage.completionTokens).toBe(500);
  });

  it("emits BLOCKED STATUS when error_max_turns hits with zero streamed output", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "error_max_turns",
        errors: ["Reached maximum number of turns (20)"],
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.text).toContain("[error_max_turns");
    expect(result.text).toContain("STATUS: BLOCKED");
    expect(result.text).not.toMatch(/^Error: error_max_turns/);
  });

  it("applies the same preservation to error_max_budget_usd", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Research notes before budget hit." },
          ],
        },
      },
      {
        type: "result",
        subtype: "error_max_budget_usd",
        errors: ["Budget exceeded"],
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.text).toContain("[error_max_budget_usd");
    expect(result.text).toContain("Research notes before budget hit.");
    expect(result.text).toContain("STATUS: DONE_WITH_CONCERNS");
  });

  it("passes vision images as a streaming user message with image blocks", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "Veo una imagen.\n\nSTATUS: DONE",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.001,
        duration_ms: 500,
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "¿Qué ves?",
      systemPrompt: "sys",
      toolNames: [],
      images: [{ mediaType: "image/jpeg", data: "BASE64DATA" }],
    });

    expect(result.text).toContain("Veo una imagen");

    // When images are present the SDK must receive an AsyncIterable prompt,
    // not a string — otherwise the pixels get silently dropped.
    const promptArg = lastQueryArgs.value?.prompt;
    expect(typeof promptArg).not.toBe("string");
    expect(promptArg).toBeDefined();

    const yielded: unknown[] = [];
    for await (const msg of promptArg as AsyncIterable<unknown>) {
      yielded.push(msg);
    }
    expect(yielded).toHaveLength(1);
    const userMsg = yielded[0] as {
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
    };
    expect(userMsg.type).toBe("user");
    expect(userMsg.message.role).toBe("user");
    expect(userMsg.message.content).toHaveLength(2);
    expect(userMsg.message.content[0]).toEqual({
      type: "text",
      text: "¿Qué ves?",
    });
    expect(userMsg.message.content[1]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "BASE64DATA",
      },
    });
  });

  it("uses plain string prompt when no images are provided", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok\n\nSTATUS: DONE",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    await queryClaudeSdk({
      prompt: "hola",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(lastQueryArgs.value?.prompt).toBe("hola");
  });

  it("prefers accumulated streamingText when final turn is tool-use-heavy", async () => {
    // Reproduces task 2378 (2026-04-14): "Me regalas un poema de Rumi"
    // Turn 1 produced the full poem. Turns 2-3 were tool_use only. The SDK
    // success.result then captured only the short final-turn closer, and the
    // earlier 848 chars of actual body text were silently dropped — Telegram
    // reply was empty. The fix: prefer the longer of streamingText vs
    // success.result so earlier-turn text cannot be lost on tool-heavy endings.
    const longPoem =
      "Ven, ven, quienquiera que seas...\n" +
      "Vagabundo, adorador, amante del irse...\n".repeat(10) +
      "No importa.\nNuestra caravana no es la del desespero.";
    mockMessages.value = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: longPoem }] },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__jarvis__jarvis_file_read" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__jarvis__jarvis_file_update" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "STATUS: DONE",
        num_turns: 3,
        usage: { input_tokens: 800, output_tokens: 400 },
        total_cost_usd: 0.17,
        duration_ms: 13373,
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "Me regalas un poema de Rumi para dormir?",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.text).toContain("Ven, ven, quienquiera que seas");
    expect(result.text).toContain("Nuestra caravana no es la del desespero");
    expect(result.text.length).toBeGreaterThan(longPoem.length - 20);
    expect(result.toolCalls).toEqual([
      "jarvis_file_read",
      "jarvis_file_update",
    ]);
    expect(result.numTurns).toBe(3);
  });

  it("still prefers success.result when it is longer than streamingText", async () => {
    // Single-turn happy path: the SDK's result field is authoritative and
    // there is no earlier-turn text to recover. streamingText equals
    // success.result here, so the tie-break falls to success.result.
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Final answer\n\nSTATUS: DONE" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Final answer\n\nSTATUS: DONE",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "hola",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.text).toBe("Final answer\n\nSTATUS: DONE");
  });

  it("still returns success result normally", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "Final answer\n\nSTATUS: DONE",
        num_turns: 5,
        usage: { input_tokens: 500, output_tokens: 200 },
        total_cost_usd: 0.01,
        duration_ms: 3000,
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.text).toBe("Final answer\n\nSTATUS: DONE");
    expect(result.numTurns).toBe(5);
    expect(result.costUsd).toBe(0.01);
  });
});
