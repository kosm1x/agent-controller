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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable config: the SDK last-line specs arm the flag + fallback triple.
const BASE_CFG = {
  inferencePrimaryProvider: "claude-sdk",
  inferencePrimaryUrl: "",
  inferencePrimaryKey: "",
  inferencePrimaryModel: "",
  inferenceFallbackUrl: "",
  inferenceFallbackKey: "",
  inferenceFallbackModel: "",
  inferenceSdkLastlineEnabled: false,
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
};
const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);

const sdkCalls: Array<{
  fn: "infer" | "inferWithTools";
  model: string | undefined;
  attempt: number;
}> = [];
let sonnetShouldThrow = false;
let haikuShouldThrow = false;
// Error classes to throw instead of the generic synthetic failure.
let sonnetErrName: string | null = null;
let haikuErrName: string | null = null;
const namedErr = (name: string): Error => {
  const e = new Error(`synthetic ${name}`);
  e.name = name;
  return e;
};

vi.mock("./claude-sdk.js", () => {
  const SONNET_MODEL_ID = "claude-sonnet-4-6";
  const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
  const OPUS_MODEL_ID = "claude-opus-4-8";
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
          throw sonnetErrName
            ? namedErr(sonnetErrName)
            : new Error("synthetic Sonnet failure");
        }
        if (model === HAIKU_MODEL_ID && haikuShouldThrow) {
          throw haikuErrName
            ? namedErr(haikuErrName)
            : new Error("synthetic Haiku failure");
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
  getConfig: () => cfg,
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    has: vi.fn(() => true),
    findClosest: vi.fn(),
    // The last-line tool-loop specs run real tool rounds.
    validate: vi.fn(() => ({ valid: true, success: true })),
    get: vi.fn(() => undefined),
  },
}));

// Compaction runs inside the tool loop; a spec hooks it to call infer() from
// within the last-line scope.
const compactHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../prometheus/compaction-pipeline.js", () => ({
  compactConversation: vi.fn(async (messages: unknown[]) => {
    await compactHook.fn?.();
    return { messages, level: "L1", removedCount: 0 };
  }),
}));

vi.mock("../prometheus/context-compressor.js", () => ({
  shouldCompress: vi.fn(() => false),
  compress: vi.fn((msgs: unknown[]) => msgs),
  estimateTokens: vi.fn(() => 0),
}));

import {
  infer,
  inferWithTools,
  lastlineEligible,
  sdkLastline,
} from "./adapter.js";
import { inferViaOpenAi } from "./adapter-openai.js";
import { SecretScrubUnavailableError } from "./outbound-scrub.js";
import { shouldCompress } from "../prometheus/context-compressor.js";
import { circuitRegistry } from "../lib/circuit-breaker.js";

beforeEach(() => {
  sdkCalls.length = 0;
  sonnetShouldThrow = false;
  haikuShouldThrow = false;
  sonnetErrName = null;
  haikuErrName = null;
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, BASE_CFG);
  compactHook.fn = null;
});

// Specs that fail the `fallback` provider record on a shared breaker.
afterEach(() => {
  circuitRegistry.reset();
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
// Aux callers (scope-classifier) can opt into Haiku for
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
      probeRounds: 3,
    });

    const sdkMock = await import("./claude-sdk.js");
    const calls = (
      sdkMock.queryClaudeSdkAsInfer as unknown as {
        mock: {
          calls: Array<[unknown, { tools?: unknown; probeRounds?: number }]>;
        };
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
    // Multi-round probe setting rides both legs too (eval scoring v3).
    expect(lastTwo[0][1].probeRounds).toBe(3);
    expect(lastTwo[1][1].probeRounds).toBe(3);
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

// ---------------------------------------------------------------------------
// 2026-10-23 — SDK last line: the OpenAI-compat `fallback` provider runs only
// after BOTH SDK legs failed, only behind INFERENCE_SDK_LASTLINE_ENABLED, and
// never on a budget refusal or an abort. fetch is the proof of traffic.
// ---------------------------------------------------------------------------

describe("SDK last line (INFERENCE_SDK_LASTLINE_ENABLED)", () => {
  const FW_URL = "https://fw.test/v1";
  const FW_MODEL = "accounts/fireworks/models/x-test";
  const arm = (model = FW_MODEL) =>
    Object.assign(cfg, {
      inferenceSdkLastlineEnabled: true,
      inferenceFallbackUrl: FW_URL,
      inferenceFallbackKey: "synthetic-key",
      inferenceFallbackModel: model,
    });
  const okFetch = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "fw answer" } }],
            usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  const fetchCall = (spy: ReturnType<typeof okFetch>, i: number) => {
    const [url, init] = spy.mock.calls[i] as [string, RequestInit];
    return {
      url,
      body: JSON.parse(String(init.body)) as { model: string },
      headers: init.headers as Record<string, string>,
    };
  };

  it("(i) flag off: both SDK legs fail → the error bubbles, no fetch", async () => {
    Object.assign(cfg, {
      inferenceFallbackUrl: FW_URL,
      inferenceFallbackKey: "synthetic-key",
      inferenceFallbackModel: FW_MODEL,
    });
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = okFetch();
    try {
      await expect(
        infer({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/synthetic Haiku failure/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("(ii) armed: both SDK legs fail → exactly one fetch to the fallback, model stamped", async () => {
    arm();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = okFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await infer({ messages: [{ role: "user", content: "hi" }] });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchCall(fetchSpy, 0);
      expect(call.url).toBe(`${FW_URL}/chat/completions`);
      expect(call.body.model).toBe(FW_MODEL);
      expect(call.headers.Authorization).toBeDefined();
      expect(r.content).toBe("fw answer");
      expect(r.model).toBe(FW_MODEL);
      expect(r.provider).toBe("fallback");
      expect(sdkCalls.map((c) => c.model)).toEqual([
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
      ]);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes(
            `claude-sdk both legs failed (synthetic Haiku failure) → last line fallback/${FW_MODEL}`,
          ),
        ),
      ).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it("(iii) armed: a BudgetExhaustedError from Sonnet is rethrown, no fetch", async () => {
    arm();
    sonnetShouldThrow = true;
    sonnetErrName = "BudgetExhaustedError";
    const fetchSpy = okFetch();
    try {
      await expect(
        infer({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toMatchObject({ name: "BudgetExhaustedError" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("(iii-b) armed: a BudgetExhaustedError from the Haiku leg is rethrown, no fetch", async () => {
    arm();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    haikuErrName = "BudgetExhaustedError";
    const fetchSpy = okFetch();
    try {
      await expect(
        infer({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toMatchObject({ name: "BudgetExhaustedError" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("(iv) armed: an AbortError from the Haiku leg is rethrown, no fetch", async () => {
    arm();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    haikuErrName = "AbortError";
    const fetchSpy = okFetch();
    try {
      await expect(
        infer({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("(v) armed, inferWithTools: both legs fail → one fetch to the fallback, model = fallback", async () => {
    arm();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = okFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await inferWithTools(
        [{ role: "user", content: "hi" }],
        [],
        async () => "",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchCall(fetchSpy, 0);
      expect(call.url).toBe(`${FW_URL}/chat/completions`);
      expect(call.body.model).toBe(FW_MODEL);
      expect(r.content).toBe("fw answer");
      // The dispatcher books tokenUsage.actualModel from this field; unset
      // it would book the fallback's spend as Sonnet.
      expect(r.model).toBe(FW_MODEL);
      // The tool loop's per-round infer() stayed on the fallback — no third
      // SDK call after the two failed legs.
      expect(sdkCalls.map((c) => c.model)).toEqual([
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
      ]);
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it("(vi) flag on but INFERENCE_FALLBACK_MODEL empty → sdkLastline() null, error bubbles", async () => {
    arm("");
    expect(sdkLastline()).toBeNull();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = okFetch();
    try {
      await expect(
        infer({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/synthetic Haiku failure/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lastlineEligible: budget refusals and both abort signatures are never eligible", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    expect(lastlineEligible(new Error("synthetic Haiku failure"))).toBe(true);
    expect(lastlineEligible(named("BudgetExhaustedError"))).toBe(false);
    expect(lastlineEligible(named("AbortError"))).toBe(false);
    // The SDK's own abort marker (queryClaudeSdkComplexWithFallback mirror).
    expect(lastlineEligible(new Error("Error: query aborted — signal"))).toBe(
      false,
    );
    // A local scrub fault: the fallback request would face the same scrub.
    expect(
      lastlineEligible(new SecretScrubUnavailableError(new Error("down"))),
    ).toBe(false);
  });

  it("onlyProvider naming an unconfigured provider throws before any fetch", async () => {
    const fetchSpy = okFetch();
    try {
      await expect(
        inferViaOpenAi(
          { messages: [{ role: "user", content: "hi" }] },
          { onlyProvider: "fallback" },
        ),
      ).rejects.toThrow('No inference provider named "fallback" is configured');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sdkLastline() is null off claude-sdk and with the flag off; armed returns the model", () => {
    arm();
    expect(sdkLastline()).toEqual({ model: FW_MODEL });
    cfg.inferencePrimaryProvider = "openai";
    expect(sdkLastline()).toBeNull();
    cfg.inferencePrimaryProvider = "claude-sdk";
    cfg.inferenceSdkLastlineEnabled = false;
    expect(sdkLastline()).toBeNull();
  });

  const toolDef = {
    type: "function" as const,
    function: {
      name: "t1",
      description: "d",
      parameters: { type: "object", properties: {} },
    },
  };
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const toolCallResp = () =>
    json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "t1", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  const textResp = (t: string) =>
    json({
      choices: [
        { message: { role: "assistant", content: t }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });

  it("(xvi) work a tool starts in the background is NOT pinned to the fallback after the loop", async () => {
    arm();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    let n = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        n++;
        return n === 1 ? toolCallResp() : textResp(`fw ${n}`);
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let deferred: Promise<{ provider: string }> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Shape of submitTask(): dispatchTask(...) un-awaited, runs later.
    const executor = async () => {
      deferred = gate.then(() =>
        infer({ messages: [{ role: "user", content: "child task" }] }),
      );
      return "ok";
    };
    try {
      const r = await inferWithTools(
        [{ role: "user", content: "hi" }],
        [toolDef],
        executor,
      );
      expect(r.model).toBe(FW_MODEL);
      // The loop's own rounds stayed on the fallback.
      expect(sdkCalls).toHaveLength(2);
      // The SDK has recovered; the child task now runs.
      sonnetShouldThrow = false;
      haikuShouldThrow = false;
      const fetchesBefore = fetchSpy.mock.calls.length;
      release();
      const bg = await deferred!;
      expect(bg.provider).toBe("claude-sdk");
      expect(sdkCalls).toHaveLength(3);
      expect(fetchSpy.mock.calls.length).toBe(fetchesBefore);
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it("(xvii) an infer() inside the last-line loop (compaction) carries the fallback model", async () => {
    arm();
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    let n = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        n++;
        return n === 1 ? toolCallResp() : textResp(`fw ${n}`);
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const inner: Array<{ model?: string; provider: string }> = [];
    compactHook.fn = async () => {
      const res = await infer({
        messages: [{ role: "user", content: "summarise" }],
      });
      inner.push({ model: res.model, provider: res.provider });
    };
    vi.mocked(shouldCompress).mockReturnValueOnce(true);
    try {
      await inferWithTools([{ role: "user", content: "hi" }], [toolDef], async () => "ok");
      expect(inner).toEqual([{ model: FW_MODEL, provider: "fallback" }]);
      expect(sdkCalls).toHaveLength(2);
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("(xviii) tool-path last line with a primary configured: the fallback 400s → primary never fetched", async () => {
    arm();
    Object.assign(cfg, {
      inferencePrimaryUrl: "https://primary.test/v1",
      inferencePrimaryKey: "synthetic-primary-key",
      inferencePrimaryModel: "primary-x",
      inferenceMaxRetries: 1,
    });
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        String(url).startsWith(FW_URL)
          ? new Response("down", { status: 400 })
          : textResp("primary answered"),
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await inferWithTools(
        [{ role: "user", content: "hi" }],
        [toolDef],
        async () => "ok",
      ).catch(() => undefined);
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u.startsWith(FW_URL))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });

  it("(xix) flag off, inferWithTools: both legs fail → the Haiku error surfaces, no last-line line", async () => {
    Object.assign(cfg, {
      inferenceFallbackUrl: FW_URL,
      inferenceFallbackKey: "synthetic-key",
      inferenceFallbackModel: FW_MODEL,
    });
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = okFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        inferWithTools([{ role: "user", content: "hi" }], [], async () => ""),
      ).rejects.toThrow(/synthetic Haiku failure/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("→ last line")),
      ).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });

  // Kept last: it records three failures on the shared `fallback` breaker.
  it("(xiv) armed with a primary configured too: fallback 500s → error bubbles, primary never fetched", async () => {
    arm();
    Object.assign(cfg, {
      inferencePrimaryUrl: "https://primary.test/v1",
      inferencePrimaryKey: "synthetic-primary-key",
      inferencePrimaryModel: "primary-x",
      inferenceMaxRetries: 3,
    });
    sonnetShouldThrow = true;
    haikuShouldThrow = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("upstream down", {
          status: 500,
          // Retry-After 0: no backoff sleep between the three attempts.
          headers: { "Retry-After": "0" },
        }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        infer({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(/All inference providers failed/);
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls).toEqual([
        `${FW_URL}/chat/completions`,
        `${FW_URL}/chat/completions`,
        `${FW_URL}/chat/completions`,
      ]);
      expect(urls.some((u) => u.startsWith("https://primary.test"))).toBe(
        false,
      );
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });
});
