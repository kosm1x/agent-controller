import { describe, it, expect, vi, beforeEach } from "vitest";

type MockMessage = Record<string, unknown>;

const mockMessages: { value: MockMessage[] } = { value: [] };

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown) => ({
    name,
    desc,
    shape,
    handler,
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: (_args: unknown) => {
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
