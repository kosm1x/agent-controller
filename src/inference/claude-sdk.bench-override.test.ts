/**
 * Opus-tier benchmark override seam (scripts/benchmark-opus-tier.ts).
 * Production invariant: with the override UNSET, the tiered wrapper calls
 * OPUS_MODEL_ID first and retries Sonnet on failure — unchanged behavior.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

// SDK `query` mock (same shape as claude-sdk.test.ts) so the defaultModel
// case can read the options the builder hands the SDK.
const lastQueryOptions = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown) => ({
    name,
    desc,
    shape,
    handler,
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: (args: { prompt: unknown; options: unknown }) => {
    lastQueryOptions.value = args.options;
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      };
    })();
  },
}));
vi.mock("../tools/registry.js", () => ({
  toolRegistry: { get: () => undefined, execute: async () => "" },
}));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: vi.fn() }));
vi.mock("../config.js", () => ({
  getConfig: () => ({ budgetEnabled: false, budgetEnforce: false }),
}));

import {
  OPUS_MODEL_ID,
  SONNET_MODEL_ID,
  queryClaudeSdk,
  queryClaudeSdkTiered,
  setOpusTierBenchmarkOverride,
} from "./claude-sdk.js";

afterEach(() => setOpusTierBenchmarkOverride(undefined));

describe("setOpusTierBenchmarkOverride", () => {
  it("unset: Opus first, Sonnet retry on failure (production default)", async () => {
    const seen: string[] = [];
    const out = await queryClaudeSdkTiered(true, async (model) => {
      seen.push(model);
      if (model === OPUS_MODEL_ID) throw new Error("403 plan denied");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(seen).toEqual([OPUS_MODEL_ID, SONNET_MODEL_ID]);
  });

  it("opusModel: the tier calls the candidate model instead", async () => {
    setOpusTierBenchmarkOverride({ opusModel: "claude-opus-5" });
    const seen: string[] = [];
    await queryClaudeSdkTiered(true, async (model) => {
      seen.push(model);
      return "ok";
    });
    expect(seen).toEqual(["claude-opus-5"]);
  });

  it("noFallback: an Opus failure surfaces instead of masking with Sonnet", async () => {
    setOpusTierBenchmarkOverride({ opusModel: "claude-opus-5", noFallback: true });
    const seen: string[] = [];
    await expect(
      queryClaudeSdkTiered(true, async (model) => {
        seen.push(model);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen).toEqual(["claude-opus-5"]);
  });

  it("does not touch the Sonnet tier", async () => {
    setOpusTierBenchmarkOverride({ opusModel: "claude-opus-5", noFallback: true });
    const seen: string[] = [];
    await queryClaudeSdkTiered(false, async (model) => {
      seen.push(model);
      return "ok";
    });
    expect(seen).toEqual([SONNET_MODEL_ID]);
  });
});

describe("defaultModel (Sonnet-tier benchmark seam)", () => {
  const call = (model?: string) =>
    queryClaudeSdk({
      prompt: "hola",
      systemPrompt: "sys",
      toolNames: [],
      costLedger: false,
      ...(model && { model }),
    });
  const sentModel = () => (lastQueryOptions.value as { model: string }).model;

  it("set + no opts.model: the SDK query carries defaultModel", async () => {
    const taps: string[] = [];
    setOpusTierBenchmarkOverride({
      defaultModel: "claude-sonnet-5-5",
      tap: (r) => taps.push(r.model),
    });
    const r = await call();
    expect(sentModel()).toBe("claude-sonnet-5-5");
    // No modelUsage in the fixture → attribution falls back to the effective
    // model, not the hard-coded Sonnet id.
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(taps).toEqual(["claude-sonnet-5-5"]);
  });

  it("set + explicit opts.model: the explicit model wins", async () => {
    setOpusTierBenchmarkOverride({ defaultModel: "claude-sonnet-5-5" });
    await call(OPUS_MODEL_ID);
    expect(sentModel()).toBe(OPUS_MODEL_ID);
  });

  it("unset (production): SONNET_MODEL_ID", async () => {
    const r = await call();
    expect(sentModel()).toBe(SONNET_MODEL_ID);
    expect(r.model).toBe(SONNET_MODEL_ID);
  });
});
