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

import {
  queryClaudeSdk,
  queryClaudeSdkAsInfer,
  queryClaudeSdkAsInferWithTools,
} from "./claude-sdk.js";
import type { ChatMessage, ToolDefinition } from "./adapter.js";

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

  it("sums input_tokens + cache_creation + cache_read into promptTokens", async () => {
    // Regression guard for the efficiency-audit instrumentation fix. Before
    // the fix, only `input_tokens` was captured, which (with SDK prompt
    // caching active) was ~8 avg while the real prompt was in the thousands.
    // The Anthropic Messages API spec states the total prompt size is the
    // sum of input_tokens, cache_creation_input_tokens, and cache_read_input_tokens.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok\n\nSTATUS: DONE",
        num_turns: 1,
        usage: {
          input_tokens: 200,
          output_tokens: 300,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 4800,
        },
        modelUsage: { "claude-sonnet-4-6": {} },
        total_cost_usd: 0.025,
        duration_ms: 1500,
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "hi",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.usage.promptTokens).toBe(200 + 500 + 4800);
    expect(result.usage.completionTokens).toBe(300);
    expect(result.usage.cacheReadTokens).toBe(4800);
    expect(result.usage.cacheCreationTokens).toBe(500);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("falls back to SONNET_MODEL_ID when SDK reports no modelUsage", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok\n\nSTATUS: DONE",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "hi",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheCreationTokens).toBe(0);
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

// ---------------------------------------------------------------------------
// v7.9 Prometheus Sonnet port — adapter tests
// ---------------------------------------------------------------------------

describe("queryClaudeSdkAsInfer (openai-path compatibility)", () => {
  it("maps SDK success to InferenceResponse shape", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: '{"goals": [{"id": "g1", "description": "..."}]}',
        num_turns: 1,
        usage: { input_tokens: 250, output_tokens: 120 },
        total_cost_usd: 0.004,
        duration_ms: 800,
      },
    ];

    const messages: ChatMessage[] = [
      { role: "system", content: "You are a planner." },
      { role: "user", content: "Decompose: read file and summarize." },
    ];
    const response = await queryClaudeSdkAsInfer(messages);

    expect(response.content).toContain("goals");
    expect(response.usage.prompt_tokens).toBe(250);
    expect(response.usage.completion_tokens).toBe(120);
    expect(response.usage.total_tokens).toBe(370);
    expect(response.provider).toBe("claude-sdk");
    expect(response.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("flattens multi-turn history into a single user prompt", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "OK",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ];

    const messages: ChatMessage[] = [
      { role: "system", content: "You are Jarvis." },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ];
    await queryClaudeSdkAsInfer(messages);

    // The SDK receives a plain string prompt. Verify our flattening
    // preserves the assistant history as readable context so the retry
    // path doesn't lose what the model just did.
    const prompt = lastQueryArgs.value?.prompt as string;
    expect(prompt).toContain("First question");
    expect(prompt).toContain("[previous assistant response]");
    expect(prompt).toContain("First answer");
    expect(prompt).toContain("Second question");

    const opts = lastQueryArgs.value?.options as { systemPrompt: string };
    expect(opts.systemPrompt).toBe("You are Jarvis.");
  });

  it("falls back to default system prompt when none provided", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ];

    await queryClaudeSdkAsInfer([{ role: "user", content: "hola" }]);
    const opts = lastQueryArgs.value?.options as { systemPrompt: string };
    expect(opts.systemPrompt.length).toBeGreaterThan(0);
  });

  it("forwards cache_read_tokens and cache_creation_tokens from SDK usage (v8 S4 phase 2)", async () => {
    // Without this forward, Prometheus modules calling through this shim
    // (planner, reflector, provenance, executor self-assess) lose cache
    // breakdown — heavy/swarm cost_ledger rows then log cache cols as 0
    // even when the underlying SDK call had cache data.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 500,
        },
      },
    ];

    const response = await queryClaudeSdkAsInfer([
      { role: "user", content: "test" },
    ]);

    // SDK builds promptTokens as input + cache_creation + cache_read = full
    // billable input. The shim must surface cache fields separately so the
    // ratio cache_read / prompt_tokens is derivable downstream.
    expect(response.usage.prompt_tokens).toBe(9500);
    expect(response.usage.completion_tokens).toBe(200);
    expect(response.usage.cache_read_tokens).toBe(8000);
    expect(response.usage.cache_creation_tokens).toBe(500);
  });
});

describe("queryClaudeSdkAsInferWithTools (openai-path compatibility)", () => {
  const fakeTool: ToolDefinition = {
    type: "function",
    function: {
      name: "jarvis_file_read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  };

  it("maps SDK streaming result to inferWithTools shape with synthetic messages", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading the file to check SOP..." },
            { type: "tool_use", name: "mcp__jarvis__jarvis_file_read" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Done — criteria met.",
        num_turns: 2,
        usage: { input_tokens: 500, output_tokens: 150 },
        total_cost_usd: 0.008,
        duration_ms: 2400,
      },
    ];

    const messages: ChatMessage[] = [
      { role: "system", content: "Execute this goal." },
      { role: "user", content: "Read rumi-poemas.md" },
    ];
    const executor = async () => "mock-result";
    const result = await queryClaudeSdkAsInferWithTools(
      messages,
      [fakeTool],
      executor,
      { maxRounds: 10 },
    );

    // The earlier claude-sdk text-drop fix (d80e29c) now prefers the longer
    // of streamingText vs success.result. Streaming produced "Reading the
    // file to check SOP..." (34 chars) before the short "Done" closer, so
    // the streaming body wins. This is the intended behavior.
    expect(result.content).toContain("Reading the file");
    expect(result.totalUsage.prompt_tokens).toBe(500);
    expect(result.totalUsage.completion_tokens).toBe(150);
    expect(result.exitReason).toBe("stop");
    expect(result.roundsCompleted).toBe(2);
    expect(result.toolRepairs).toEqual([]);

    // Synthetic messages: system + user + assistant with tool_calls
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[2].role).toBe("assistant");

    const asst = result.messages[2] as ChatMessage & {
      tool_calls?: Array<{ function: { name: string } }>;
    };
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls?.[0].function.name).toBe("jarvis_file_read");
  });

  it("passes tool names through to SDK allowedTools list", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    const executor = async () => "mock";
    await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "hola" }],
      [fakeTool],
      executor,
    );

    const opts = lastQueryArgs.value?.options as {
      allowedTools: string[];
    };
    expect(opts.allowedTools).toContain("mcp__jarvis__jarvis_file_read");
  });

  it("maps STATUS: BLOCKED marker to exitReason=max_rounds", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "error_max_turns",
        errors: ["Reached maximum number of turns"],
      },
    ];

    const executor = async () => "mock";
    const result = await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "hola" }],
      [fakeTool],
      executor,
    );

    expect(result.exitReason).toBe("max_rounds");
    expect(result.content).toContain("STATUS: BLOCKED");
  });

  it("forwards cache_read_tokens and cache_creation_tokens from SDK usage (v8 S4 phase 2)", async () => {
    // Heavy-runner / Prometheus executor accumulators read from
    // result.totalUsage.cache_read_tokens. Without this forward, every
    // heavy/swarm goal-execution row in cost_ledger logs cache=0.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: {
          input_tokens: 2000,
          output_tokens: 300,
          cache_read_input_tokens: 15000,
          cache_creation_input_tokens: 1200,
        },
      },
    ];

    const executor = async () => "mock";
    const result = await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "go" }],
      [fakeTool],
      executor,
    );

    expect(result.totalUsage.prompt_tokens).toBe(18200);
    expect(result.totalUsage.completion_tokens).toBe(300);
    expect(result.totalUsage.cache_read_tokens).toBe(15000);
    expect(result.totalUsage.cache_creation_tokens).toBe(1200);
  });

  // ---------------------------------------------------------------------
  // v7.9 audit follow-ups (C1, C2, M1, m5)
  // ---------------------------------------------------------------------

  it("C1: preserves text from array-shaped content (vision/normalized blocks)", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ];

    // Array-shaped user content — the openai-path does this for vision and
    // for some normalized assistant retry paths. Must not be silently erased.
    const messages = [
      { role: "system" as const, content: "sys" },
      {
        role: "user" as const,
        content: [
          { type: "text", text: "First text block" },
          { type: "text", text: "Second text block" },
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      } as unknown as ChatMessage,
    ];

    await queryClaudeSdkAsInfer(messages);

    const prompt = lastQueryArgs.value?.prompt as string;
    expect(prompt).toContain("First text block");
    expect(prompt).toContain("Second text block");
    expect(prompt).toContain("[non-text block omitted: image_url]");
  });

  it("C1: handles null content without throwing", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ];

    const messages = [
      { role: "user" as const, content: "hola" },
      { role: "assistant" as const, content: null as unknown as string },
      { role: "user" as const, content: "again" },
    ];

    // Should not throw on null content
    await queryClaudeSdkAsInfer(messages);
    const prompt = lastQueryArgs.value?.prompt as string;
    expect(prompt).toContain("hola");
    expect(prompt).toContain("again");
  });

  it("C2: maps DONE_WITH_CONCERNS to exitReason=max_rounds", async () => {
    // error_max_budget_usd produces a "STATUS: DONE_WITH_CONCERNS" marker
    // with the streamed text preserved. The wrapper must not treat this
    // as a clean "stop" exit.
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Partial progress before budget." }],
        },
      },
      {
        type: "result",
        subtype: "error_max_budget_usd",
        errors: ["Budget exceeded"],
      },
    ];

    const executor = async () => "mock";
    const result = await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "hola" }],
      [fakeTool],
      executor,
    );

    expect(result.exitReason).toBe("max_rounds");
    expect(result.content).toContain("STATUS: DONE_WITH_CONCERNS");
  });

  it("M1: compressionContext is prepended to the user prompt", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 30, output_tokens: 5 },
      },
    ];

    const executor = async () => "mock";
    await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "Execute goal" }],
      [fakeTool],
      executor,
      {
        compressionContext: "Current goal: read file X\nCriteria: metadata",
      },
    );

    const prompt = lastQueryArgs.value?.prompt as string;
    expect(prompt).toContain("Current goal: read file X");
    expect(prompt.indexOf("Current goal")).toBeLessThan(
      prompt.indexOf("Execute goal"),
    );
  });

  it("m5: synthetic tool_call IDs include a nonce to avoid cross-run collisions", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__jarvis__jarvis_file_read" },
            { type: "tool_use", name: "mcp__jarvis__jarvis_file_read" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    const executor = async () => "mock";
    const result = await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "test" }],
      [fakeTool],
      executor,
    );

    const asst = result.messages[2] as ChatMessage & {
      tool_calls?: Array<{ id: string }>;
    };
    // IDs are unique within a run and include a base36 nonce
    expect(asst.tool_calls?.[0].id).toMatch(/^sdk_call_[a-z0-9]+_0$/);
    expect(asst.tool_calls?.[1].id).toMatch(/^sdk_call_[a-z0-9]+_1$/);
    expect(asst.tool_calls?.[0].id).not.toBe(asst.tool_calls?.[1].id);
  });

  it("returns empty tool_calls array when SDK does not call any tools", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Text-only response" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Text-only response",
        num_turns: 1,
        usage: { input_tokens: 80, output_tokens: 40 },
      },
    ];

    const executor = async () => "mock";
    const result = await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "What is 2+2?" }],
      [fakeTool],
      executor,
    );

    const asst = result.messages[2] as ChatMessage & {
      tool_calls?: unknown[];
    };
    expect(asst.tool_calls).toBeUndefined();
  });
});

describe("queryClaudeSdk circuit breaker (Dim-4 R2 fix)", () => {
  // Import the shared registry inside the describe so each spec gets a
  // known-clean slate. The registry is a process-wide singleton — without
  // reset the 3-failure threshold persists across tests and causes false
  // positives when the shared breaker bleeds state between spec files.
  it("trips OPEN after CB_FAILURE_THRESHOLD failures and refuses subsequent calls until cooldown", async () => {
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    const { CB_FAILURE_THRESHOLD } = await import("../config/constants.js");
    circuitRegistry.reset();

    // Each failure = error subtype with zero streamed text, which
    // providerOutcome='failure' already classifies correctly.
    const failure: MockMessage[] = [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["provider 500"],
      },
    ];

    // CB_FAILURE_THRESHOLD (default 5) consecutive failures trip the breaker.
    for (let i = 0; i < CB_FAILURE_THRESHOLD; i++) {
      mockMessages.value = failure;
      await queryClaudeSdk({
        prompt: "ping",
        systemPrompt: "sys",
        toolNames: [],
      });
    }

    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("OPEN");

    // Fourth call must be refused before touching the SDK at all.
    lastQueryArgs.value = null;
    await expect(
      queryClaudeSdk({
        prompt: "refused",
        systemPrompt: "sys",
        toolNames: [],
      }),
    ).rejects.toThrow(/Circuit breaker OPEN/);
    // The SDK query() must not have been invoked — the breaker short-circuited.
    expect(lastQueryArgs.value).toBeNull();

    circuitRegistry.reset();
  });

  it("does NOT count partial content with error subtype as a failure", async () => {
    // error_max_turns with streamed content = provider was working until
    // SDK-internal limit. Must not trip the breaker on legitimate long runs.
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    circuitRegistry.reset();

    for (let i = 0; i < 5; i++) {
      mockMessages.value = [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Working on it..." }],
          },
        },
        {
          type: "result",
          subtype: "error_max_turns",
          errors: ["turn limit"],
        },
      ];
      await queryClaudeSdk({
        prompt: "long task",
        systemPrompt: "sys",
        toolNames: [],
      });
    }

    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("CLOSED");

    circuitRegistry.reset();
  });

  it("records success on normal completion and resets failure count", async () => {
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    circuitRegistry.reset();

    mockMessages.value = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "result",
        subtype: "success",
        result: "Hello world\nSTATUS: DONE",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    await queryClaudeSdk({
      prompt: "hi",
      systemPrompt: "sys",
      toolNames: [],
    });

    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("CLOSED");
    expect(breaker.getStatus().failures).toBe(0);

    circuitRegistry.reset();
  });
});
