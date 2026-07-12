import { describe, it, expect, vi, beforeEach } from "vitest";

type MockMessage = Record<string, unknown>;

const mockMessages: { value: MockMessage[] } = { value: [] };
const lastQueryArgs: { value: { prompt: unknown; options: unknown } | null } = {
  value: null,
};
// Opt-in: when set, the mock iterator throws this error AFTER yielding the
// fixtures. Lets us exercise the real `catch (err)` branch in queryClaudeSdk
// (line ~620) — natural-exit and thrown-abort are different code paths.
// Added 2026-05-23 (qa-audit W1 fold) so #225's catch-branch coverage is real.
const mockThrowAfterYield: { value: Error | null } = { value: null };

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
    const throwAfter = mockThrowAfterYield.value;
    return (async function* () {
      for (const m of messages) yield m;
      if (throwAfter) throw throwAfter;
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
  queryClaudeSdkComplexWithFallback,
  HAIKU_MODEL_ID,
  OPUS_MODEL_ID,
  SONNET_MODEL_ID,
} from "./claude-sdk.js";
import type { ChatMessage, ToolDefinition } from "./adapter.js";
import { providerMetrics } from "./adapter-openai.js";

beforeEach(() => {
  mockMessages.value = [];
  lastQueryArgs.value = null;
  mockThrowAfterYield.value = null;
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

    expect(result.model).toBe(SONNET_MODEL_ID);
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

describe("queryClaudeSdkAsInfer selection probe (2026-07-10 eval fix)", () => {
  const webSearchDef: ToolDefinition = {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  };

  it("registers tools as probe stubs, forces maxTurns=1, returns tool_use as tool_calls", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__jarvis__web_search",
              input: { query: "clima cdmx" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ];

    const response = await queryClaudeSdkAsInfer(
      [{ role: "user", content: "¿Cómo está el clima en CDMX?" }],
      { tools: [webSearchDef] },
    );

    // The model's first-turn tool_use surfaces as openai-shape tool_calls —
    // this is the channel the tuning eval reads. It was structurally absent
    // (tools dropped, no tool_calls key) from 2026-05-10 to 2026-07-10,
    // which pinned the eval's tool_selection subscore at its silence floor.
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls?.[0].function.name).toBe("web_search");
    expect(JSON.parse(response.tool_calls![0].function.arguments)).toEqual({
      query: "clima cdmx",
    });

    const opts = lastQueryArgs.value?.options as {
      maxTurns: number;
      allowedTools: string[];
      mcpServers: { jarvis: { config: { tools: Array<{ name: string }> } } };
    };
    // Probe = selection only: one turn, never a tool-result round-trip.
    expect(opts.maxTurns).toBe(1);
    // The definition reached the model (registered + allow-listed).
    expect(opts.allowedTools).toContain("mcp__jarvis__web_search");
    expect(opts.mcpServers.jarvis.config.tools.map((t) => t.name)).toContain(
      "web_search",
    );
  });

  it("without tools keeps legacy behavior: no tool_calls key, maxTurns default", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "hola",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ];

    const response = await queryClaudeSdkAsInfer([
      { role: "user", content: "hola" },
    ]);

    expect(response.tool_calls).toBeUndefined();
    const opts = lastQueryArgs.value?.options as { maxTurns: number };
    expect(opts.maxTurns).toBe(3);
  });

  it("probe with no tool_use in the reply omits tool_calls (silence stays representable)", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "No necesito buscar." }] },
      },
      {
        type: "result",
        subtype: "success",
        result: "No necesito buscar.",
        num_turns: 1,
        usage: { input_tokens: 50, output_tokens: 8 },
      },
    ];

    const response = await queryClaudeSdkAsInfer(
      [{ role: "user", content: "hola" }],
      { tools: [webSearchDef] },
    );

    expect(response.tool_calls).toBeUndefined();
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

  it("does NOT count tool_use-only turns with error_max_turns as failures (probe pattern, 2026-07-10)", async () => {
    // A selection probe (maxTurns=1) whose model goes STRAIGHT to a tool
    // call — the correct behavior — ends in error_max_turns with zero
    // streamed prose. That is a healthy provider, not an outage. Before the
    // fix, 51 consecutive eval probes tripped the claude-sdk breaker open
    // mid-run and cascaded every remaining case onto the Haiku retry leg.
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    circuitRegistry.reset();

    for (let i = 0; i < 5; i++) {
      mockMessages.value = [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "mcp__jarvis__web_search",
                input: { query: "x" },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "error_max_turns",
          errors: ["turn limit"],
        },
      ];
      await queryClaudeSdk({
        prompt: "probe",
        systemPrompt: "sys",
        toolNames: [],
        maxTurns: 1,
      });
    }

    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("CLOSED");

    circuitRegistry.reset();
  });

  it("MULTI-turn zero-prose tool loops hitting max_turns still count as failures (qa-audit W1)", async () => {
    // A 20-turn run that looped tool calls to the ceiling without emitting
    // any prose is a wedge, not a healthy provider. The probe exemption
    // above is scoped to maxTurns===1 — this pins that a doom-looping
    // fast-runner task keeps its BLOCKED/breaker-failure classification
    // instead of reporting soft-success.
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    const { CB_FAILURE_THRESHOLD } = await import("../config/constants.js");
    circuitRegistry.reset();

    for (let i = 0; i < CB_FAILURE_THRESHOLD; i++) {
      mockMessages.value = [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "mcp__jarvis__web_search",
                input: { query: "loop" },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "error_max_turns",
          errors: ["turn limit"],
        },
      ];
      const result = await queryClaudeSdk({
        prompt: "long task",
        systemPrompt: "sys",
        toolNames: [],
        maxTurns: 20,
      });
      expect(result.text).toContain("STATUS: BLOCKED");
    }

    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("OPEN");

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

  it("buckets Sonnet, Haiku, and Opus into separate breakers (audit C2 + W4)", async () => {
    // Without this separation, Sonnet failures would trip the shared breaker
    // and the immediate Haiku fallback in inferViaClaudeSdk would also be
    // rejected — defeating the point of the fallback in the exact outage
    // window it was designed for.
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    circuitRegistry.reset();

    // Trip the Sonnet breaker by recording threshold consecutive failures.
    // 5 failures within the rolling window opens the breaker (CB defaults).
    const sonnetBreaker = circuitRegistry.get("claude-sdk");
    for (let i = 0; i < 5; i++) sonnetBreaker.recordFailure();
    expect(sonnetBreaker.getStatus().state).toBe("OPEN");

    // Haiku breaker is independent — should remain CLOSED and accept calls.
    const haikuBreaker = circuitRegistry.get("claude-sdk-haiku");
    expect(haikuBreaker.getStatus().state).toBe("CLOSED");
    expect(haikuBreaker.allowRequest()).toBe(true);

    // A successful Haiku call uses its own breaker; Sonnet's stays OPEN.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    await queryClaudeSdk({
      prompt: "x",
      systemPrompt: "s",
      toolNames: [],
      model: HAIKU_MODEL_ID,
    });
    expect(circuitRegistry.get("claude-sdk").getStatus().state).toBe("OPEN");
    expect(circuitRegistry.get("claude-sdk-haiku").getStatus().state).toBe(
      "CLOSED",
    );

    // Opus also needs its own breaker — Opus 403s shouldn't poison the
    // Opus→Sonnet fallback's Sonnet retry (which lives on "claude-sdk").
    const opusBreaker = circuitRegistry.get("claude-sdk-opus");
    expect(opusBreaker.getStatus().state).toBe("CLOSED");
    expect(opusBreaker.allowRequest()).toBe(true);

    circuitRegistry.reset();
  });
});

// ---------------------------------------------------------------------------
// Model selection threading (2026-05-10 Anthropic-only cutover)
// ---------------------------------------------------------------------------

describe("model selection threading (2026-05-10 cutover)", () => {
  it("exports distinct model IDs for Sonnet, Haiku, and Opus", () => {
    expect(SONNET_MODEL_ID).toBe("claude-sonnet-4-6");
    expect(HAIKU_MODEL_ID).toBe("claude-haiku-4-5-20251001");
    expect(OPUS_MODEL_ID).toBe("claude-opus-4-7");
    // No two ids should collide — drift guard for future model bumps.
    const ids = new Set([SONNET_MODEL_ID, HAIKU_MODEL_ID, OPUS_MODEL_ID]);
    expect(ids.size).toBe(3);
  });

  it("queryClaudeSdkAsInfer forwards caller-provided model to the SDK", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ];
    await queryClaudeSdkAsInfer([{ role: "user", content: "hola" }], {
      model: OPUS_MODEL_ID,
    });
    const opts = lastQueryArgs.value?.options as { model: string };
    expect(opts.model).toBe(OPUS_MODEL_ID);
  });

  it("queryClaudeSdkAsInfer defaults to Sonnet when no model passed", async () => {
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
    const opts = lastQueryArgs.value?.options as { model: string };
    // queryClaudeSdk applies SONNET_MODEL_ID default when model param is undefined.
    expect(opts.model).toBe(SONNET_MODEL_ID);
  });

  it("queryClaudeSdkAsInferWithTools forwards caller-provided model", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ];
    await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "hola" }],
      [],
      async () => "",
      { model: HAIKU_MODEL_ID },
    );
    const opts = lastQueryArgs.value?.options as { model: string };
    expect(opts.model).toBe(HAIKU_MODEL_ID);
  });

  it("queryClaudeSdkAsInfer surfaces SDK-reported model on InferenceResponse (audit C1)", async () => {
    // Without this, dispatcher.getModelFromTask() falls through to the
    // hardcoded SONNET_MODEL_ID branch under SDK mode — Opus and Haiku
    // traffic would be miscredited in cost_ledger.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
        modelUsage: { [OPUS_MODEL_ID]: {} },
      },
    ];
    const response = await queryClaudeSdkAsInfer(
      [{ role: "user", content: "hola" }],
      { model: OPUS_MODEL_ID },
    );
    expect(response.model).toBe(OPUS_MODEL_ID);
  });

  it("queryClaudeSdkAsInferWithTools surfaces SDK-reported model on totalUsage (audit C1)", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
        modelUsage: { [HAIKU_MODEL_ID]: {} },
      },
    ];
    const result = await queryClaudeSdkAsInferWithTools(
      [{ role: "user", content: "hola" }],
      [],
      async () => "",
      { model: HAIKU_MODEL_ID },
    );
    expect(result.model).toBe(HAIKU_MODEL_ID);
  });

  it("queryClaudeSdkComplexWithFallback retries with Sonnet when Opus throws (audit W4)", async () => {
    // Pin the Prometheus fallback contract: heavy/swarm tasks call Opus
    // first, but Opus access is plan-gated and can 403. The wrapper must
    // retry with Sonnet so the entire Prometheus task doesn't hard-fail.
    const calls: string[] = [];
    const result = await queryClaudeSdkComplexWithFallback(async (model) => {
      calls.push(model);
      if (model === OPUS_MODEL_ID) {
        throw new Error("synthetic Opus 403 (plan-gated)");
      }
      return { content: `served by ${model}`, model };
    });
    expect(calls).toEqual([OPUS_MODEL_ID, SONNET_MODEL_ID]);
    expect(result).toEqual({
      content: `served by ${SONNET_MODEL_ID}`,
      model: SONNET_MODEL_ID,
    });
  });

  it("queryClaudeSdkComplexWithFallback returns Opus result on success — no Sonnet attempt", async () => {
    const calls: string[] = [];
    const result = await queryClaudeSdkComplexWithFallback(async (model) => {
      calls.push(model);
      return { content: `served by ${model}`, model };
    });
    expect(calls).toEqual([OPUS_MODEL_ID]);
    expect(result.model).toBe(OPUS_MODEL_ID);
  });

  it("queryClaudeSdkComplexWithFallback propagates the Sonnet error when both Opus and Sonnet fail (round-2 W7)", async () => {
    // Pin the both-fail contract so a future change can't silently swallow
    // the second throw — Prometheus's classifyError relies on the error
    // surfacing to decide retry vs escalate.
    const calls: string[] = [];
    await expect(
      queryClaudeSdkComplexWithFallback(async (model) => {
        calls.push(model);
        if (model === OPUS_MODEL_ID) throw new Error("opus 403 plan-gate");
        throw new Error("sonnet 5xx upstream");
      }),
    ).rejects.toThrow(/sonnet 5xx upstream/);
    expect(calls).toEqual([OPUS_MODEL_ID, SONNET_MODEL_ID]);
  });

  it("queryClaudeSdkComplexWithFallback skips Sonnet retry on AbortError (round-2 W8)", async () => {
    // User-cancelled tasks shouldn't double-spend on the retry. The wrapper
    // detects AbortError by name OR an "aborted" substring in message.
    const calls: string[] = [];
    await expect(
      queryClaudeSdkComplexWithFallback(async (model) => {
        calls.push(model);
        const err = new Error("operation aborted by user");
        err.name = "AbortError";
        throw err;
      }),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toEqual([OPUS_MODEL_ID]);
  });

  it("queryClaudeSdkComplexWithFallback skips Sonnet retry on aborted-message variant (round-2 W8)", async () => {
    // Some abort surfaces don't carry name='AbortError' (e.g. SDK throws a
    // plain Error with "aborted" in the message). The substring guard
    // covers that path.
    const calls: string[] = [];
    await expect(
      queryClaudeSdkComplexWithFallback(async (model) => {
        calls.push(model);
        throw new Error("[claude-sdk] Query aborted after 30s");
      }),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toEqual([OPUS_MODEL_ID]);
  });

  it("breaker bucketing prefix-matches model family rather than exact-equality (round-2 W9)", async () => {
    // Future model ID bumps (e.g. claude-haiku-5-0-...) must still land in
    // the haiku bucket, not silently collapse to the shared 'claude-sdk' key.
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    circuitRegistry.reset();

    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    // Hypothetical future-bumped Haiku ID — exact-equality match against
    // HAIKU_MODEL_ID would fail; prefix-match keeps it bucketed correctly.
    await queryClaudeSdk({
      prompt: "x",
      systemPrompt: "s",
      toolNames: [],
      model: "claude-haiku-5-0-future",
    });
    // The haiku breaker should have recorded a success; the default sonnet
    // breaker should be untouched.
    expect(circuitRegistry.get("claude-sdk-haiku").getStatus().state).toBe(
      "CLOSED",
    );
    expect(circuitRegistry.get("claude-sdk").getStatus().failures).toBe(0);

    circuitRegistry.reset();
  });
});

// ---------------------------------------------------------------------------
// 2026-05-23 fixes
//   (1) flattenMessagesForSdk respects ChatMessage.cacheable (#224)
//   (2) abort/timeout paths preserve per-turn token usage AND omit costUsd
//       so the dispatcher does not write phantom-$0 rows (#225)
// ---------------------------------------------------------------------------

describe("flattenMessagesForSdk respects cacheable hint (#224)", () => {
  it("default (cacheable undefined) keeps system content in systemPrompt", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    await queryClaudeSdkAsInfer([
      { role: "system", content: "Stable identity prefix" },
      { role: "user", content: "hi" },
    ]);

    const opts = lastQueryArgs.value?.options as { systemPrompt: string };
    expect(opts.systemPrompt).toBe("Stable identity prefix");
    const prompt = lastQueryArgs.value?.prompt as string;
    expect(prompt).toBe("hi");
  });

  it("cacheable:false routes a system message into the user-prompt prefix", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    // Mimics fast-runner's stable/variable split: essentials is stable,
    // variableDescPart varies per task and must not invalidate the
    // cached systemPrompt prefix.
    await queryClaudeSdkAsInfer([
      { role: "system", content: "STABLE essentials" },
      {
        role: "system",
        content: "VARIABLE per-task description",
        cacheable: false,
      },
      { role: "user", content: "actual user question" },
    ]);

    const opts = lastQueryArgs.value?.options as { systemPrompt: string };
    // systemPrompt holds ONLY the stable portion — the byte-stable cache
    // prefix the SDK will place its one cache_control marker on.
    expect(opts.systemPrompt).toBe("STABLE essentials");
    expect(opts.systemPrompt).not.toContain("VARIABLE");

    // The variable portion is prepended to user blocks IN ORDER so the
    // model still sees it before the user turn.
    const prompt = lastQueryArgs.value?.prompt as string;
    expect(prompt.indexOf("VARIABLE per-task description")).toBeLessThan(
      prompt.indexOf("actual user question"),
    );
  });

  it("byte-stable systemPrompt across two calls with different variable content (the actual cache-hit property)", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    await queryClaudeSdkAsInfer([
      { role: "system", content: "STABLE essentials" },
      {
        role: "system",
        content: "task A description (varies every task)",
        cacheable: false,
      },
      { role: "user", content: "q1" },
    ]);
    const firstSystem = (
      lastQueryArgs.value?.options as { systemPrompt: string }
    ).systemPrompt;

    // Reset SDK output stub for the second call.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    await queryClaudeSdkAsInfer([
      { role: "system", content: "STABLE essentials" },
      {
        role: "system",
        content: "task B description (completely different bytes)",
        cacheable: false,
      },
      { role: "user", content: "q2" },
    ]);
    const secondSystem = (
      lastQueryArgs.value?.options as { systemPrompt: string }
    ).systemPrompt;

    // The whole point of the fix: variable byte-drift does NOT touch the
    // systemPrompt the SDK will hash for cache lookup.
    expect(firstSystem).toBe(secondSystem);
  });

  it("multiple stable system messages still concatenate into systemPrompt", async () => {
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    await queryClaudeSdkAsInfer([
      { role: "system", content: "section-A" },
      { role: "system", content: "section-B" },
      { role: "system", content: "section-C", cacheable: true },
      { role: "user", content: "go" },
    ]);

    const opts = lastQueryArgs.value?.options as { systemPrompt: string };
    expect(opts.systemPrompt).toBe("section-A\n\nsection-B\n\nsection-C");
  });
});

describe("queryClaudeSdk abort/timeout preserves usage + omits authoritative cost (#225)", () => {
  it("accumulates per-turn usage from assistant messages so abort writes non-zero tokens", async () => {
    // Three assistant turns with per-turn usage but NO terminal `result`
    // message — simulates the SDK aborting mid-stream (timeout / external
    // signal). Before the fix, usage stayed at zeros and cost_ledger
    // received a phantom-$0 row.
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "step 1" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 8000,
          },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "step 2" }],
          usage: {
            input_tokens: 200,
            output_tokens: 75,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 9000,
          },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "step 3 (last before abort)" }],
          usage: {
            input_tokens: 30,
            output_tokens: 40,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 9500,
          },
        },
      },
      // No `result` message — the SDK aborts here. The catch block fires.
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    // promptTokens = sum across turns of (input + cache_creation + cache_read).
    // (100+0+8000) + (200+50+9000) + (30+0+9500) = 26,880.
    expect(result.usage.promptTokens).toBe(26_880);
    expect(result.usage.completionTokens).toBe(165); // 50+75+40
    expect(result.usage.cacheReadTokens).toBe(26_500); // 8000+9000+9500
    expect(result.usage.cacheCreationTokens).toBe(50);
  });

  it("flags costAuthoritative=false on abort path so adapter omits cost_usd", async () => {
    // Same shape: assistant turns without a terminal result message.
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial" }],
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    // The SDK never reported cost — costAuthoritative MUST be false so
    // downstream consumers (queryClaudeSdkAsInfer, queryClaudeSdkAsInferWithTools)
    // strip `cost_usd` from the response and the dispatcher falls back to
    // calculateCost() over the now-non-zero token totals.
    expect(result.costAuthoritative).toBe(false);
    expect(result.usage.promptTokens).toBe(500);
    expect(result.usage.completionTokens).toBe(100);
  });

  it("queryClaudeSdkAsInfer omits cost_usd when costAuthoritative=false (catch path)", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial" }],
          usage: { input_tokens: 1000, output_tokens: 200 },
        },
      },
    ];

    const response = await queryClaudeSdkAsInfer([
      { role: "user", content: "go" },
    ]);

    // Token columns preserved — they came from the per-turn accumulator.
    expect(response.usage.prompt_tokens).toBe(1000);
    expect(response.usage.completion_tokens).toBe(200);
    // cost_usd MUST be undefined so dispatcher.recordCost falls back to
    // calculateCost(). A literal 0 here would override and write phantom-$0.
    expect(response.usage.cost_usd).toBeUndefined();
  });

  it("success path keeps costAuthoritative=true (Max-plan $0 stays attributable)", async () => {
    // Max-plan billing legitimately reports $0 — that's authoritative data,
    // not a sentinel. Must be distinguishable from the abort path.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0,
        duration_ms: 200,
      },
    ];

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    expect(result.costAuthoritative).toBe(true);
    expect(result.costUsd).toBe(0);

    // ... and the adapter SHOULD emit cost_usd: 0 in this case.
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0,
        duration_ms: 200,
      },
    ];
    const response = await queryClaudeSdkAsInfer([
      { role: "user", content: "go" },
    ]);
    expect(response.usage.cost_usd).toBe(0);
  });

  it("real catch branch (thrown abort mid-stream) preserves accumulator AND keeps costAuthoritative=false (qa-audit W1)", async () => {
    // W1 fold: the prior tests in this block exercised the natural-exit path
    // (generator returns cleanly without a result message). This one actually
    // throws inside the iterator AFTER one assistant turn, hitting the
    // `catch (err)` block at claude-sdk.ts:620. Verifies that:
    //   (a) the per-turn accumulator survives the throw (token counts non-zero)
    //   (b) costAuthoritative stays false (no result message ever fired)
    //   (c) streamingText is recovered as the result text
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial before abort" }],
          usage: { input_tokens: 750, output_tokens: 250 },
        },
      },
    ];
    mockThrowAfterYield.value = new Error("AbortError: signal aborted");

    const result = await queryClaudeSdk({
      prompt: "test",
      systemPrompt: "sys",
      toolNames: [],
    });

    // (a) accumulator survived
    expect(result.usage.promptTokens).toBe(750);
    expect(result.usage.completionTokens).toBe(250);
    // (b) no terminal result message ever fired
    expect(result.costAuthoritative).toBe(false);
    // (c) streamingText recovered
    expect(result.text).toContain("partial before abort");
  });

  it("error_max_turns branch (terminal result with usage) also sets costAuthoritative=true", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial" }],
          usage: { input_tokens: 1, output_tokens: 1 }, // would accumulate
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

    // Error subtype reached terminal — cost IS authoritative.
    expect(result.costAuthoritative).toBe(true);
    expect(result.costUsd).toBe(0.05);
    // Error branch's `usage = { ... }` REPLACES the per-turn accumulator;
    // we must see the SDK-reported authoritative total, not the sum.
    expect(result.usage.promptTokens).toBe(1000);
    expect(result.usage.completionTokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// wrapToolCached memoization contract (2026-07-05 efficiency audit, Phase 3)
// ---------------------------------------------------------------------------

describe("wrapToolCached memoization", () => {
  it("returns the SAME wrapped instance for the same Tool object (no re-wrap per query)", async () => {
    const { wrapToolCached } = await import("./claude-sdk.js");
    const tool = {
      name: "memo_probe",
      definition: {
        type: "function" as const,
        function: {
          name: "memo_probe",
          description: "probe",
          parameters: {
            type: "object",
            properties: { q: { type: "string", description: "query" } },
            required: ["q"],
          },
        },
      },
      execute: async () => "ok",
    };
    const a = wrapToolCached(tool as never);
    const b = wrapToolCached(tool as never);
    expect(a).toBe(b); // identity — Zod shape built exactly once
  });

  it("re-wraps when a source re-registers a NEW Tool object (identity key, not name)", async () => {
    const { wrapToolCached } = await import("./claude-sdk.js");
    const make = () => ({
      name: "memo_probe2",
      definition: {
        type: "function" as const,
        function: {
          name: "memo_probe2",
          description: "probe",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => "ok",
    });
    const a = wrapToolCached(make() as never);
    const b = wrapToolCached(make() as never);
    expect(a).not.toBe(b); // fresh object → fresh wrap (no stale schema risk)
  });
});

// ---------------------------------------------------------------------------
// Provider-health metrics on the claude-sdk path (Lane D observability, 2026-07-05)
//
// Before this, providerMetrics.record fired ONLY from the dormant OpenAI-compat
// path, so all mc_provider_* series were empty and /health.providers was {}.
// These assert the SDK hot path now records under the SAME label the circuit
// breaker buckets on, on BOTH success and failure.
// ---------------------------------------------------------------------------
describe("queryClaudeSdk provider metrics", () => {
  it("records a success metric under the 'claude-sdk' label with SDK latency + tokens", async () => {
    const spy = vi.spyOn(providerMetrics, "record");
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "done\n\nSTATUS: DONE",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.001,
        duration_ms: 500,
      },
    ];

    await queryClaudeSdk({ prompt: "t", systemPrompt: "s", toolNames: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    const [provider, entry, model] = spy.mock.calls[0];
    expect(provider).toBe("claude-sdk");
    expect(entry.success).toBe(true);
    expect(entry.promptTokens).toBe(100);
    expect(entry.completionTokens).toBe(20);
    expect(entry.latencyMs).toBe(500); // SDK-reported durationMs
    expect(model).toBe(SONNET_MODEL_ID);
    spy.mockRestore();
  });

  it("records a failure metric when the SDK terminal result errors with zero output", async () => {
    const spy = vi.spyOn(providerMetrics, "record");
    mockMessages.value = [
      { type: "result", subtype: "error_during_execution", errors: ["boom"] },
    ];

    await queryClaudeSdk({ prompt: "t", systemPrompt: "s", toolNames: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("claude-sdk");
    expect(spy.mock.calls[0][1].success).toBe(false);
    spy.mockRestore();
  });

  it("labels the metric with the per-model breaker key (claude-sdk-opus)", async () => {
    const spy = vi.spyOn(providerMetrics, "record");
    mockMessages.value = [
      {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
        total_cost_usd: 0,
        duration_ms: 10,
      },
    ];

    await queryClaudeSdk({
      prompt: "t",
      systemPrompt: "s",
      toolNames: [],
      model: OPUS_MODEL_ID,
    });

    expect(spy.mock.calls[0][0]).toBe("claude-sdk-opus");
    spy.mockRestore();
  });

  it("falls back to wall-clock latency on the abort catch path (durationMs stays 0)", async () => {
    const spy = vi.spyOn(providerMetrics, "record");
    mockMessages.value = [];
    mockThrowAfterYield.value = Object.assign(new Error("query aborted"), {
      name: "AbortError",
    });

    await queryClaudeSdk({ prompt: "t", systemPrompt: "s", toolNames: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    const entry = spy.mock.calls[0][1];
    expect(entry.success).toBe(false);
    // durationMs never set (no terminal result) → wall-clock fallback, a real
    // non-negative sample rather than a phantom that would skew avg latency.
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    spy.mockRestore();
  });
});

describe("SDK 0.3 migration (V8.5 Phase 1)", () => {
  // The breaker registry is shared module state — earlier spec blocks can
  // leave a breaker OPEN (same trap documented at the Dim-4 R2 block above).
  beforeEach(async () => {
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");
    circuitRegistry.reset();
  });

  it("structural refusal with zero prose → deterministic [refusal] BLOCKED text, never empty", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: {
          stop_reason: "refusal",
          stop_details: { category: "cyber" },
          content: [],
        },
      },
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["refusal"],
      },
    ];
    const r = await queryClaudeSdk({
      prompt: "p",
      systemPrompt: "sys",
      toolNames: [],
    });
    expect(r.text).toContain("[refusal]");
    expect(r.text).toContain("category: cyber");
    expect(r.text).toContain("STATUS: BLOCKED");
  });

  it("a refused turn does NOT trip the circuit breaker (working provider, not an outage)", async () => {
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");

    for (let i = 0; i < 5; i++) {
      mockMessages.value = [
        {
          type: "assistant",
          message: { stop_reason: "refusal", content: [] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["refusal"],
        },
      ];
      await queryClaudeSdk({
        prompt: "p",
        systemPrompt: "sys",
        toolNames: [],
      });
    }

    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("CLOSED");
  });

  it("a crash with zero content AFTER a refusal turn is still a provider failure (qa-audit W2)", async () => {
    // The refusal override must not mask a real outage that follows the
    // refused turn in the same query — subprocess death lands in the catch
    // block with no streamed text; that failure classification outranks
    // sawRefusal. (The analogous timeout precedence uses the real 15-min
    // timer and is documented in the source rather than simulated here.)
    const { circuitRegistry } = await import("../lib/circuit-breaker.js");

    let lastText = "";
    for (let i = 0; i < 5; i++) {
      mockMessages.value = [
        {
          type: "assistant",
          message: { stop_reason: "refusal", content: [] },
        },
      ];
      mockThrowAfterYield.value = new Error(
        "Claude Code process exited with code 1",
      );
      const r = await queryClaudeSdk({
        prompt: "p",
        systemPrompt: "sys",
        toolNames: [],
      });
      lastText = r.text;
    }
    expect(lastText).toContain("query aborted");
    expect(lastText).not.toContain("[refusal]");

    // 5 crash-classified failures = threshold — had sawRefusal masked them,
    // the breaker would still be CLOSED.
    const breaker = circuitRegistry.get("claude-sdk");
    expect(breaker.getStatus().state).toBe("OPEN");
    circuitRegistry.reset();
  });

  it("refusal followed by real streamed text keeps the text (fallback-model retry succeeded)", async () => {
    mockMessages.value = [
      {
        type: "assistant",
        message: { stop_reason: "refusal", content: [] },
      },
      {
        type: "system",
        subtype: "model_refusal_fallback",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Fallback model answered fine." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Fallback model answered fine.",
        num_turns: 2,
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.01,
        duration_ms: 100,
      },
    ];
    const r = await queryClaudeSdk({
      prompt: "p",
      systemPrompt: "sys",
      toolNames: [],
    });
    expect(r.text).toBe("Fallback model answered fine.");
    expect(r.text).not.toContain("[refusal]");
  });

  // (An alwaysLoad-pinning spec belongs here when the SDK 0.3.x migration is
  // re-attempted — the option does not exist on 0.2.x. See buildMcpServer.)
});
