/**
 * Tool-loop branches of the OpenAI-compatible path that need the compaction
 * modules scripted: the request-too-large (HTTP 413) retry and the
 * compaction-exhaustion exit. The per-round `infer` is mocked — never a real
 * provider; compaction is mocked the way adapter-claude-sdk-routing.test.ts
 * does it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  getConfig: () => ({
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://127.0.0.1:1/v1",
    inferencePrimaryKey: "test-key",
    inferencePrimaryModel: "test-model",
    inferenceTimeoutMs: 5000,
    inferenceMaxTokens: 256,
    inferenceMaxRetries: 1,
    inferenceContextLimit: 128000,
    compressionThreshold: 0.85,
    budgetEnabled: false,
  }),
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    has: (n: string) => n === "web_search",
    findClosest: () => null,
    get: () => undefined,
    validate: () => ({ success: true }),
  },
}));

const inferMock = vi.hoisted(() => vi.fn());
vi.mock("./adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter.js")>()),
  infer: inferMock,
}));

// Each call records a snapshot of the conversation it was handed (the loop
// keeps mutating its array afterwards) and returns a fresh copy.
const compactCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("../prometheus/compaction-pipeline.js", () => ({
  compactConversation: vi.fn(async (messages: unknown[], ...rest: unknown[]) => {
    compactCalls.push([[...messages], ...rest]);
    return { messages: [...messages], level: "L1", removedCount: 0 };
  }),
}));

const compressOver = vi.hoisted(() => ({ value: false }));
vi.mock("../prometheus/context-compressor.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../prometheus/context-compressor.js")
  >()),
  shouldCompress: vi.fn(() => compressOver.value),
}));

import { inferWithToolsViaOpenAi } from "./adapter-openai.js";
import type { ChatMessage, ToolDefinition } from "./adapter.js";

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const webSearch: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "web_search",
    parameters: { type: "object", properties: {} },
  },
};
const callTool = {
  content: null,
  tool_calls: [
    {
      id: "c-1",
      type: "function",
      function: { name: "web_search", arguments: "{}" },
    },
  ],
  usage,
};
const tooLarge = () => new Error("HTTP 413: request entity too large");
const opening: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "haz algo" },
];

function run() {
  return inferWithToolsViaOpenAi(
    opening,
    [webSearch],
    vi.fn(async () => JSON.stringify({ ok: true })),
    {
      maxRounds: 5,
      skipToolNudge: true,
      exemptAnalysisParalysis: true,
      compressionContext: "ctx",
      compressionFocusTopic: "tema",
    },
  );
}

beforeEach(() => {
  inferMock.mockReset();
  compactCalls.length = 0;
  compressOver.value = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("request too large (HTTP 413) in the tool loop", () => {
  it("one 413: the conversation is compacted once at threshold 0.5, the next call succeeds, natural finish", async () => {
    inferMock
      .mockRejectedValueOnce(tooLarge())
      .mockResolvedValueOnce({ content: "respuesta final completa", usage });
    const result = await run();

    expect(compactCalls).toEqual([[opening, 128000, 0.5, "ctx", "tema"]]);
    expect(inferMock).toHaveBeenCalledTimes(2);
    expect(result.exitReason).toBe("natural");
    expect(result.content).toBe("respuesta final completa");
    // The 413 round consumed a round index: the natural exit reports round + 1.
    expect(result.roundsCompleted).toBe(2);
  });

  it("two 413s in a row: no second compaction, the mid-loop wrap-up answers, exit provider_failure", async () => {
    inferMock
      .mockRejectedValueOnce(tooLarge())
      .mockRejectedValueOnce(tooLarge())
      .mockResolvedValueOnce({ content: "resumen tras el error", usage });
    const result = await run();

    expect(compactCalls).toHaveLength(1);
    expect(inferMock).toHaveBeenCalledTimes(3);
    // The wrap-up call carries no tools and asks for low effort.
    const wrapUpReq = inferMock.mock.calls[2][0] as {
      tools?: unknown;
      effort?: string;
    };
    expect(wrapUpReq.tools).toBeUndefined();
    expect(wrapUpReq.effort).toBe("low");
    expect(result.exitReason).toBe("provider_failure");
    expect(result.content).toBe("resumen tras el error");
    expect(result.roundsCompleted).toBe(1);
  });
});

describe("compaction exhaustion exit", () => {
  it("still over threshold after two consecutive compactions → wrap-up, roundsCompleted counts the one round that ran", async () => {
    compressOver.value = true;
    inferMock
      .mockResolvedValueOnce(callTool)
      .mockResolvedValueOnce({ content: "resumen", usage });
    const result = await run();

    expect(result.exitReason).toBe("compaction_exhausted");
    expect(result.roundsCompleted).toBe(1);
    expect(compactCalls).toHaveLength(2);
    // round 1 + the wrap-up call
    expect(inferMock).toHaveBeenCalledTimes(2);
  });

  it("a 413 in round 1, then exhaustion before round 2's call: no call returned → 0", async () => {
    compressOver.value = true;
    inferMock
      .mockRejectedValueOnce(tooLarge())
      .mockResolvedValueOnce({ content: "resumen", usage });
    const result = await run();

    expect(result.exitReason).toBe("compaction_exhausted");
    expect(result.roundsCompleted).toBe(0);
    // round 1 main pass, the 413 pass, round 2 main pass
    expect(compactCalls.map((c) => c[2])).toEqual([0.85, 0.5, 0.85]);
    // the failed round-1 call + the wrap-up call
    expect(inferMock).toHaveBeenCalledTimes(2);
  });
});

describe("a run that uses all its rounds", () => {
  it("a 413 in the last round still reports the limit", async () => {
    const step = (i: number) => ({
      content: null,
      tool_calls: [
        {
          id: `c-${i}`,
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ q: `q${i}` }) },
        },
      ],
      usage,
    });
    inferMock
      .mockResolvedValueOnce(step(0))
      .mockResolvedValueOnce(step(1))
      .mockResolvedValueOnce(step(2))
      .mockResolvedValueOnce(step(3))
      .mockRejectedValueOnce(tooLarge())
      .mockResolvedValueOnce({ content: "resumen", usage });
    const result = await run();

    expect(result.exitReason).toBe("max_rounds");
    expect(compactCalls).toHaveLength(1); // the 413 pass in round 5
    expect(inferMock).toHaveBeenCalledTimes(6); // 5 rounds + the wrap-up
    // Only 4 calls returned, but a run that used every round reports the limit.
    expect(result.roundsCompleted).toBe(5);
  });
});
