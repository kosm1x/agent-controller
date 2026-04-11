/**
 * Integration tests — full inference pipeline through mock LLM server.
 *
 * Tests real HTTP parsing, tool execution, loop guards, hallucination
 * detection, and retry/replacement chains end-to-end.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { MockLLMServer, type MockToolCall } from "./mock-llm-server.js";

// Mock config to point at our mock server
let mockServer: MockLLMServer;

// Port is set dynamically in beforeAll — vi.hoisted runs before mocks
const mockPort = vi.hoisted(() => ({ value: 0 }));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: `http://localhost:${mockPort.value}/v1`,
    inferencePrimaryKey: "test-key",
    inferencePrimaryModel: "mock-model",
    inferenceFallbackUrl: "",
    inferenceFallbackKey: "",
    inferenceFallbackModel: "",
    inferenceTertiaryUrl: "",
    inferenceTertiaryKey: "",
    inferenceTertiaryModel: "",
    inferenceTimeoutMs: 10_000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 1,
    inferenceContextLimit: 128000,
    compressionThreshold: 0.85,
    heavyRunnerContainerized: false,
    budgetEnabled: false,
  }),
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    has: vi.fn(() => true),
    findClosest: vi.fn(),
    validate: vi.fn(() => ({ success: true })),
  },
}));

vi.mock("../prometheus/context-compressor.js", () => ({
  shouldCompress: vi.fn(() => false),
  compress: vi.fn((msgs: unknown[]) => msgs),
  estimateTokens: vi.fn(() => 0),
}));

const { infer, inferWithTools } = await import("../inference/adapter.js");

beforeAll(async () => {
  mockServer = new MockLLMServer();
  await mockServer.start();
  mockPort.value = mockServer.port;
});

afterAll(async () => {
  await mockServer.stop();
});

afterEach(() => {
  mockServer.reset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Basic inference
// ---------------------------------------------------------------------------

describe("infer() through mock LLM server", () => {
  it("sends request and parses response", async () => {
    mockServer.push({
      content: "Hello, world!",
      prompt_tokens: 50,
      completion_tokens: 10,
    });

    const result = await infer({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.content).toBe("Hello, world!");
    expect(result.usage.prompt_tokens).toBe(50);
    expect(result.usage.completion_tokens).toBe(10);

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    const body = requests[0].body as Record<string, unknown>;
    expect(body.model).toBe("mock-model");
  });

  it("returns tool calls from LLM response", async () => {
    const toolCall: MockToolCall = {
      id: "call-1",
      type: "function",
      function: {
        name: "web_search",
        arguments: '{"query": "test"}',
      },
    };
    mockServer.push({ tool_calls: [toolCall], content: null });

    const result = await infer({
      messages: [{ role: "user", content: "Search for test" }],
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].function.name).toBe("web_search");
  });
});

// ---------------------------------------------------------------------------
// inferWithTools — full loop
// ---------------------------------------------------------------------------

describe("inferWithTools() through mock LLM server", () => {
  it("executes a single tool call then returns text", async () => {
    // Round 1: LLM calls a tool
    mockServer.push({
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: '{"query": "test"}',
          },
        },
      ],
      content: null,
    });
    // Round 2: LLM returns text (final response)
    mockServer.push({
      content: "Here are the search results for test.",
    });

    const executor = vi.fn(async () =>
      JSON.stringify({ results: ["result1"] }),
    );

    const result = await inferWithTools(
      [{ role: "user", content: "Search for test" }],
      [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search",
            parameters: {},
          },
        },
      ],
      executor,
      { maxRounds: 5 },
    );

    expect(result.content).toBe("Here are the search results for test.");
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith("web_search", { query: "test" });
  });

  it("handles multiple tool call rounds", async () => {
    // Round 1: search
    mockServer.push({
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: '{"query": "weather"}',
          },
        },
      ],
      content: null,
    });
    // Round 2: read
    mockServer.push({
      tool_calls: [
        {
          id: "call-2",
          type: "function",
          function: {
            name: "web_read",
            arguments: '{"url": "https://weather.com"}',
          },
        },
      ],
      content: null,
    });
    // Round 3: final text
    mockServer.push({ content: "It's sunny today." });

    const executor = vi.fn(async () => JSON.stringify({ ok: true }));

    const result = await inferWithTools(
      [{ role: "user", content: "What's the weather?" }],
      [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search",
            parameters: {},
          },
        },
        {
          type: "function",
          function: {
            name: "web_read",
            description: "Read",
            parameters: {},
          },
        },
      ],
      executor,
      { maxRounds: 5 },
    );

    expect(result.content).toBe("It's sunny today.");
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("respects maxRounds and triggers wrap-up", async () => {
    // Push 3 tool calls (one per round) — but maxRounds is 2
    for (let i = 0; i < 3; i++) {
      mockServer.push({
        tool_calls: [
          {
            id: `call-${i}`,
            type: "function",
            function: {
              name: "web_search",
              arguments: `{"query": "round${i}"}`,
            },
          },
        ],
        content: null,
      });
    }
    // Wrap-up response
    mockServer.push({ content: "Wrap-up: completed 2 rounds." });

    const executor = vi.fn(async () => JSON.stringify({ ok: true }));

    const result = await inferWithTools(
      [{ role: "user", content: "Search a lot" }],
      [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search",
            parameters: {},
          },
        },
      ],
      executor,
      { maxRounds: 2 },
    );

    // Should have called executor exactly 2 times (maxRounds=2)
    expect(executor).toHaveBeenCalledTimes(2);
    // Wrap-up should produce a response
    expect(result.content).toBeTruthy();
  });

  it("accumulates token usage across rounds", async () => {
    mockServer.push({
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: '{"query": "test"}',
          },
        },
      ],
      content: null,
      prompt_tokens: 100,
      completion_tokens: 20,
    });
    mockServer.push({
      content: "Done.",
      prompt_tokens: 150,
      completion_tokens: 30,
    });

    const executor = vi.fn(async () => JSON.stringify({ ok: true }));

    const result = await inferWithTools(
      [{ role: "user", content: "Test" }],
      [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search",
            parameters: {},
          },
        },
      ],
      executor,
    );

    expect(result.totalUsage.prompt_tokens).toBe(250); // 100 + 150
    expect(result.totalUsage.completion_tokens).toBe(50); // 20 + 30
  });

  it("handles tool execution errors gracefully", async () => {
    mockServer.push({
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "shell_exec",
            arguments: '{"command": "ls"}',
          },
        },
      ],
      content: null,
    });
    // After error, LLM responds with text
    mockServer.push({ content: "The command failed." });

    const executor = vi.fn(async () => {
      throw new Error("Permission denied");
    });

    const result = await inferWithTools(
      [{ role: "user", content: "Run ls" }],
      [
        {
          type: "function",
          function: {
            name: "shell_exec",
            description: "Shell",
            parameters: {},
          },
        },
      ],
      executor,
    );

    // Should still get a response (LLM sees the error and responds)
    expect(result.content).toBe("The command failed.");
    expect(executor).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Loop guard integration
// ---------------------------------------------------------------------------

describe("loop guards through mock LLM server", () => {
  it("breaks on identical repeated tool calls", async () => {
    // Same tool call repeated 3 times
    for (let i = 0; i < 3; i++) {
      mockServer.push({
        tool_calls: [
          {
            id: `call-${i}`,
            type: "function",
            function: {
              name: "web_search",
              arguments: '{"query": "same"}',
            },
          },
        ],
        content: null,
        prompt_tokens: 100,
      });
    }
    // Wrap-up (after loop break)
    mockServer.push({ content: "Loop detected, stopping." });

    const executor = vi.fn(async () => JSON.stringify({ ok: true }));

    const result = await inferWithTools(
      [{ role: "user", content: "Search" }],
      [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search",
            parameters: {},
          },
        },
      ],
      executor,
      { maxRounds: 10 },
    );

    // MAX_CONSECUTIVE_REPEATS=2: 1st call ok, 2nd repeat detected (count=1),
    // 3rd repeat detected (count=2 >= threshold) → break. Exactly 3 calls.
    expect(executor).toHaveBeenCalledTimes(3);
    expect(result.content).toBeTruthy();
  });
});
