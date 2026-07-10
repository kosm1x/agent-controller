/**
 * Adapter SDK-routing tests (2026-05-10 cutover).
 *
 * Operator directive: when INFERENCE_PRIMARY_PROVIDER=claude-sdk, every
 * caller of infer()/inferWithTools() must route through the Anthropic SDK
 * with Sonnet primary + Haiku fallback. No traffic should reach the
 * OpenAI-compatible providers list (Fireworks/Groq) under that mode.
 *
 * These specs pin the routing contract and the Haiku fallback behavior so
 * future refactors of the providers chain can't silently regress.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sdkCalls: Array<{
  fn: "infer" | "inferWithTools";
  model: string | undefined;
  attempt: number;
}> = [];
let sonnetShouldThrow = false;
let haikuShouldThrow = false;

vi.mock("./claude-sdk.js", () => {
  const SONNET_MODEL_ID = "claude-sonnet-4-6";
  const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
  const OPUS_MODEL_ID = "claude-opus-4-7";
  const stamp = (fn: "infer" | "inferWithTools", model: string | undefined) => {
    sdkCalls.push({ fn, model, attempt: sdkCalls.length + 1 });
  };
  return {
    SONNET_MODEL_ID,
    HAIKU_MODEL_ID,
    OPUS_MODEL_ID,
    queryClaudeSdkAsInfer: vi.fn(
      async (
        _msgs: unknown,
        opts?: { model?: string; signal?: AbortSignal },
      ) => {
        const model = opts?.model ?? SONNET_MODEL_ID;
        stamp("infer", model);
        if (model === SONNET_MODEL_ID && sonnetShouldThrow) {
          throw new Error("synthetic Sonnet failure");
        }
        if (model === HAIKU_MODEL_ID && haikuShouldThrow) {
          throw new Error("synthetic Haiku failure");
        }
        return {
          content: `routed via ${model}`,
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          provider: "claude-sdk",
          latency_ms: 1,
        };
      },
    ),
    queryClaudeSdkAsInferWithTools: vi.fn(
      async (
        _msgs: unknown,
        _tools: unknown,
        _executor: unknown,
        opts?: { model?: string },
      ) => {
        const model = opts?.model ?? SONNET_MODEL_ID;
        stamp("inferWithTools", model);
        if (model === SONNET_MODEL_ID && sonnetShouldThrow) {
          throw new Error("synthetic Sonnet failure");
        }
        if (model === HAIKU_MODEL_ID && haikuShouldThrow) {
          throw new Error("synthetic Haiku failure");
        }
        return {
          content: `tool-route via ${model}`,
          messages: [],
          totalUsage: { prompt_tokens: 5, completion_tokens: 2 },
          toolRepairs: [],
          exitReason: "stop",
          roundsCompleted: 1,
          contextPressure: 0,
        };
      },
    ),
  };
});

vi.mock("../config.js", () => ({
  getConfig: () => ({
    inferencePrimaryProvider: "claude-sdk",
    inferencePrimaryUrl: "",
    inferencePrimaryKey: "",
    inferencePrimaryModel: "",
    inferenceFallbackUrl: "",
    inferenceFallbackKey: "",
    inferenceFallbackModel: "",
    inferenceTertiaryUrl: "",
    inferenceTertiaryKey: "",
    inferenceTertiaryModel: "",
    inferenceTimeoutMs: 5000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 2,
    inferenceContextLimit: 128000,
    compressionThreshold: 0.85,
    heavyRunnerContainerized: false,
    budgetEnabled: false,
  }),
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: { has: vi.fn(() => true), findClosest: vi.fn() },
}));

vi.mock("../prometheus/context-compressor.js", () => ({
  shouldCompress: vi.fn(() => false),
  compress: vi.fn((msgs: unknown[]) => msgs),
  estimateTokens: vi.fn(() => 0),
}));

import { infer, inferWithTools } from "./adapter.js";

beforeEach(() => {
  sdkCalls.length = 0;
  sonnetShouldThrow = false;
  haikuShouldThrow = false;
});

describe("infer() with claude-sdk primary", () => {
  it("routes through SDK with Sonnet by default — no providers list traffic (fetch spy)", async () => {
    // Audit W3: pin "no OpenAI HTTP traffic" by spying on fetch directly.
    // The earlier-only sdkCalls.length=1 assertion would pass even if the
    // providers chain were also reached — fetch is the actual proof.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const r = await infer({ messages: [{ role: "user", content: "hi" }] });
      expect(r.content).toBe("routed via claude-sonnet-4-6");
      expect(sdkCalls).toEqual([
        { fn: "infer", model: "claude-sonnet-4-6", attempt: 1 },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retries with Haiku when Sonnet throws (drop-in replacement for OpenAI fallback chain)", async () => {
    sonnetShouldThrow = true;
    const r = await infer({ messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("routed via claude-haiku-4-5-20251001");
    // Sonnet attempted first, then Haiku — the order pins the fallback contract.
    expect(sdkCalls.map((c) => c.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("propagates the error when both Sonnet and Haiku fail", async () => {
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    await expect(
      infer({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/synthetic Haiku failure/);
    expect(sdkCalls.length).toBe(2);
  });
});

describe("inferWithTools() with claude-sdk primary", () => {
  it("routes through SDK shim with Sonnet on first attempt", async () => {
    const r = await inferWithTools(
      [{ role: "user", content: "hi" }],
      [],
      async () => "",
    );
    expect(r.content).toBe("tool-route via claude-sonnet-4-6");
    expect(sdkCalls).toEqual([
      { fn: "inferWithTools", model: "claude-sonnet-4-6", attempt: 1 },
    ]);
  });

  it("falls back to Haiku on Sonnet failure with tools", async () => {
    sonnetShouldThrow = true;
    const r = await inferWithTools(
      [{ role: "user", content: "hi" }],
      [],
      async () => "",
    );
    expect(r.content).toBe("tool-route via claude-haiku-4-5-20251001");
    expect(sdkCalls.map((c) => c.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2026-05-23 — queue #228 — InferenceRequest.model plumbing
// Aux callers (scope-classifier, prompt-enhancer) can opt into Haiku for
// cost savings. Plumbing is on by default; the env-flag gate at the call
// site decides whether to populate the field. These tests pin the adapter
// contract: when present, `request.model` takes precedence over the
// hardcoded Sonnet default; when absent, behavior is unchanged.
// ---------------------------------------------------------------------------

describe("infer() with request.model override (queue #228)", () => {
  it("uses request.model as the primary leg instead of Sonnet", async () => {
    const r = await infer({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-haiku-4-5-20251001",
    });
    // Primary attempt should be Haiku, not Sonnet.
    expect(r.content).toBe("routed via claude-haiku-4-5-20251001");
    expect(sdkCalls).toEqual([
      { fn: "infer", model: "claude-haiku-4-5-20251001", attempt: 1 },
    ]);
  });

  it("still falls back to Haiku on retry even when primary was already Haiku (provider-level transient)", async () => {
    // When the caller opted into Haiku and Haiku itself failed on the first
    // attempt, the retry leg also uses Haiku (no upgrade to Sonnet — the
    // caller's downshift intent is preserved). The retry MAY transiently
    // succeed if the failure was rate-limit or network-blip; that's the
    // semantic the wrapper preserves.
    sonnetShouldThrow = false; // Sonnet is irrelevant on this path
    let haikuCalls = 0;
    haikuShouldThrow = false;
    // Override the mock to throw on the FIRST Haiku attempt only.
    const sdkMock = await import("./claude-sdk.js");
    const originalImpl = (
      sdkMock.queryClaudeSdkAsInfer as unknown as {
        getMockImplementation: () => (...args: unknown[]) => unknown;
      }
    ).getMockImplementation();
    (
      sdkMock.queryClaudeSdkAsInfer as unknown as {
        mockImplementation: (impl: unknown) => void;
      }
    ).mockImplementation(async (_msgs: unknown, opts: { model?: string }) => {
      const model = opts?.model ?? "claude-sonnet-4-6";
      sdkCalls.push({ fn: "infer", model, attempt: sdkCalls.length + 1 });
      if (model === "claude-haiku-4-5-20251001") {
        haikuCalls++;
        if (haikuCalls === 1) throw new Error("haiku-first-transient");
      }
      return {
        content: `routed via ${model}`,
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        provider: "claude-sdk",
        latency_ms: 1,
      };
    });
    try {
      const r = await infer({
        messages: [{ role: "user", content: "hi" }],
        model: "claude-haiku-4-5-20251001",
      });
      // Two attempts, BOTH Haiku — no Sonnet escalation.
      expect(sdkCalls.map((c) => c.model)).toEqual([
        "claude-haiku-4-5-20251001",
        "claude-haiku-4-5-20251001",
      ]);
      expect(r.content).toBe("routed via claude-haiku-4-5-20251001");
    } finally {
      (
        sdkMock.queryClaudeSdkAsInfer as unknown as {
          mockImplementation: (impl: unknown) => void;
        }
      ).mockImplementation(originalImpl);
    }
  });

  it("forwards request.tools to the SDK shim on BOTH legs (probe passthrough, 2026-07-10)", async () => {
    // Regression pin: request.tools was silently dropped on the claude-sdk
    // path from the 2026-05-10 cutover to 2026-07-10, so infer()-with-tools
    // callers (the tuning eval runner) scored tool_selection against a model
    // that never saw the tools. The primary leg AND the Haiku retry leg must
    // both forward them.
    const probeTools = [
      {
        type: "function" as const,
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    sonnetShouldThrow = true; // force primary failure so the retry leg runs too
    haikuShouldThrow = false;
    await infer({
      messages: [{ role: "user", content: "clima cdmx" }],
      tools: probeTools,
    });

    const sdkMock = await import("./claude-sdk.js");
    const calls = (
      sdkMock.queryClaudeSdkAsInfer as unknown as {
        mock: { calls: Array<[unknown, { tools?: unknown }]> };
      }
    ).mock.calls;
    // Mock call history accumulates across specs in this file — assert on
    // the final two calls (this spec's Sonnet attempt + Haiku retry).
    expect(sdkCalls.slice(-2).map((c) => c.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    const lastTwo = calls.slice(-2);
    expect(lastTwo[0][1].tools).toBe(probeTools);
    expect(lastTwo[1][1].tools).toBe(probeTools);
  });

  it("undefined request.model preserves the prior Sonnet default (back-compat)", async () => {
    // Critical for the ~33 existing callers that never set `model`.
    const r = await infer({ messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("routed via claude-sonnet-4-6");
    expect(sdkCalls[0].model).toBe("claude-sonnet-4-6");
  });
});

describe("inferWithTools() with options.model override (queue #228 symmetry)", () => {
  it("honors options.model on the primary leg", async () => {
    const r = await inferWithTools(
      [{ role: "user", content: "hi" }],
      [],
      async () => "",
      { model: "claude-haiku-4-5-20251001" },
    );
    expect(r.content).toBe("tool-route via claude-haiku-4-5-20251001");
    expect(sdkCalls[0]).toEqual({
      fn: "inferWithTools",
      model: "claude-haiku-4-5-20251001",
      attempt: 1,
    });
  });

  it("undefined options.model keeps Sonnet primary", async () => {
    const r = await inferWithTools(
      [{ role: "user", content: "hi" }],
      [],
      async () => "",
    );
    expect(r.content).toBe("tool-route via claude-sonnet-4-6");
  });
});
