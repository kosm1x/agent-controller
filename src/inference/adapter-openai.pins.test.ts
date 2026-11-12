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
// Optional per-test side effect of each compaction pass.
const onCompact = vi.hoisted(() => ({ fn: undefined as (() => void) | undefined }));
vi.mock("../prometheus/compaction-pipeline.js", () => ({
  compactConversation: vi.fn(async (messages: unknown[], ...rest: unknown[]) => {
    compactCalls.push([[...messages], ...rest]);
    onCompact.fn?.();
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

function run(overrides: { skipToolNudge?: boolean } = {}) {
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
      ...overrides,
    },
  );
}

beforeEach(() => {
  inferMock.mockReset();
  compactCalls.length = 0;
  compressOver.value = false;
  onCompact.fn = undefined;
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
    // A refused request is not a model turn: the resend reuses round index 0,
    // so the one turn that ran is the one reported.
    expect(result.roundsCompleted).toBe(1);
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
    // Neither request produced a model turn.
    expect(result.roundsCompleted).toBe(0);
  });

  it("a resend after a round-0 413 is still round 0: the first-round nudge fires on a tool-less answer", async () => {
    inferMock
      .mockRejectedValueOnce(tooLarge())
      .mockResolvedValueOnce({ content: "respuesta sin herramientas, larga", usage })
      .mockResolvedValueOnce({ content: "respuesta final completa", usage });
    const result = await run({ skipToolNudge: false });

    expect(inferMock).toHaveBeenCalledTimes(3);
    const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(logged).toContain("First-round tool skip detected");
    expect(result.content).toBe("respuesta final completa");
  });

  it("the resend is bounded: a second 413 for the same round index is not resent again", async () => {
    // The 413 latch resets when a pre-round compaction lands under threshold;
    // the explicit one-resend-per-round-index bound must still stop the loop.
    // Passes alternate main (lands under threshold, resetting the latch) and
    // 413 (leaves the conversation over threshold again).
    let pass = 0;
    compressOver.value = true;
    onCompact.fn = () => {
      pass++;
      compressOver.value = pass % 2 === 0;
    };
    // Ten refusals, then an answer: an unbounded resend loop would reach the
    // answer instead of hanging the test.
    for (let i = 0; i < 10; i++) inferMock.mockRejectedValueOnce(tooLarge());
    inferMock.mockResolvedValue({ content: "respuesta final completa", usage });
    const result = await run().catch((e: unknown) => e as Error);

    // Once the ladder is exhausted, the mid-loop wrap-up runs; when it fails
    // too, the original 413 is thrown.
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("413");
    // the first request, one resend, and the failed wrap-up
    expect(inferMock).toHaveBeenCalledTimes(3);
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

  it("a 413 in round 1, then exhaustion before its resend: no call returned → 0", async () => {
    compressOver.value = true;
    inferMock
      .mockRejectedValueOnce(tooLarge())
      .mockResolvedValueOnce({ content: "resumen", usage });
    const result = await run();

    expect(result.exitReason).toBe("compaction_exhausted");
    expect(result.roundsCompleted).toBe(0);
    // round 1 main pass, the 413 pass, the resend's main pass
    expect(compactCalls.map((c) => c[2])).toEqual([0.85, 0.5, 0.85]);
    // the failed round-1 call + the wrap-up call
    expect(inferMock).toHaveBeenCalledTimes(2);
  });
});

describe("a run that uses all its rounds", () => {
  it("a 413 in the last round is resent inside that round; the run ends at the limit with the full count", async () => {
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
      .mockResolvedValueOnce(step(4))
      .mockResolvedValueOnce({ content: "resumen", usage });
    const result = await run();

    expect(result.exitReason).toBe("max_rounds");
    expect(compactCalls).toHaveLength(1); // the 413 pass in round 5
    // 5 rounds, the refused request resent inside round 5, and the wrap-up
    expect(inferMock).toHaveBeenCalledTimes(7);
    expect(result.content).toBe("resumen");
    // All 5 rounds produced a turn (the resend answered round 5): the count is
    // the full limit.
    expect(result.roundsCompleted).toBe(5);
  });
});
